import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { AWAIT_MAX_MS } from '../src/board/cards.ts'
import { install as installBoard } from '../src/board/plugin.ts'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

async function setup({ state = team() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-card-threads-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const prompts = []
  const archived = []
  const created = []
  let sessions = 0
  const agentFor = id => ({
    id,
    session: { id, requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash' } }) },
    ctx: { tools: { register: () => () => {}, restrict: () => () => {} }, on: () => () => {}, effect: execute => execute() },
    followup: () => {},
  })
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (id) => { archived.push(id) },
    },
    sessionController: {
      create: async (input) => { created.push(input); return { sessionId: `card${++sessions}` } },
      resolveAgent: async id => ({ agent: agentFor(id) }),
      selectModel: async () => {},
      prompt: async (input) => { prompts.push(input) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { ctx, rt, home, prompts, archived, created, saved, stop }
}

test('startCard opens a card thread beside the chat and sends the brief there; notes with the card id follow it', async (t) => {
  const { rt, prompts, saved, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  assert.deepEqual(await notes.startCard({ botId: 'nobody', cardId: 'c_1', text: 'x' }), { error: 'No such Bot.' })
  assert.deepEqual(await notes.startCard({ botId: 'writer', cardId: 'c_1', text: '  ' }), { error: 'A card needs a brief.' })
  const started = await notes.startCard({ botId: 'writer', cardId: 'c_1', title: 'Newsletter', text: '[Card c_1] Write it.\n\nUnder 300 words.' })
  assert.equal(started.sessionId, 'card1')
  const bot = rt.botOf('writer')
  assert.equal(bot.sessionId, 'writer')
  assert.deepEqual(bot.openParts.map(part => [part.sessionId, part.card]), [['card1', 'c_1']])
  assert.equal(rt.chatOwners.get('card1'), 'writer')
  assert.equal(rt.cardOfSession('card1'), 'c_1')
  assert.equal(rt.cardOfSession('writer'), undefined)
  assert.deepEqual(prompts.at(-1).sessionId, 'card1')
  assert.equal(prompts.at(-1).content[0].text, '[Card c_1] Write it.\n\nUnder 300 words.')
  assert.deepEqual(saved().bots.writer.openParts.map(part => part.card), ['c_1'])

  assert.equal((await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'again' })).sessionId, 'card1')
  assert.deepEqual((await notes.deliver({ botId: 'writer', cardId: 'c_1', text: 'shorter please', requestId: 'im:telegram:9' })), { sessionId: 'card1', where: 'card', requestId: 'im:telegram:9' })
  assert.equal(prompts.at(-1).requestId, 'im:telegram:9')
})

test('the card thread decides which session a note lands in', async (t) => {
  const state = team()
  state.rooms.ops = { id: 'ops', name: 'Ops', members: ['writer'], sessions: { writer: 'ops-writer' } }
  const { rt, prompts, stop } = await setup({ state })
  t.after(stop)
  const { notes } = rt.companions
  const sent = await notes.deliver({ botId: 'writer', cardId: 'c_1', roomId: 'ops', title: 'Release', brief: 'Write the newsletter.', text: 'Keep it short.' })
  assert.equal(sent.where, 'card')
  assert.equal(sent.sessionId, 'card1')
  assert.deepEqual(prompts.map(prompt => [prompt.sessionId, prompt.requestId, prompt.content[0].text]), [
    ['card1', sent.requestId, 'Write the newsletter.\n\nKeep it short.'],
  ])
  assert.deepEqual(rt.cardThreads.ofSession('card1'), { botId: 'writer', cardId: 'c_1' })
  assert.equal(rt.cardThreads.sessionOf('writer', 'c_1'), 'card1')
  assert.deepEqual(rt.ownerOfSession('card1'), { botId: 'writer', roomId: 'ops', cardId: 'c_1' })
})

test('a host with no card threads still gets the note', async (t) => {
  const { rt, prompts, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  rt.openCardThread = undefined
  const message = { botId: 'writer', cardId: 'c_1', requestId: 'note-1', text: 'Keep it short.' }
  assert.deepEqual(await notes.deliver(message), { sessionId: 'writer', where: 'chat', requestId: 'note-1' })
  rt.openCardThread = async () => { throw new Error('Thread creation failed') }
  assert.deepEqual(await notes.deliver({ ...message, requestId: 'note-2' }), { sessionId: 'writer', where: 'chat', requestId: 'note-2' })
  assert.deepEqual(prompts.map(prompt => [prompt.sessionId, prompt.requestId, prompt.content[0].text]), [
    ['writer', 'note-1', 'Keep it short.'],
    ['writer', 'note-2', 'Keep it short.'],
  ])
})

test('the card thread decides which answer lands after the note window', async (t) => {
  const { ctx, rt, home, prompts, stop } = await setup()
  t.after(stop)
  const board = installBoard(ctx, { file: join(home, 'board.json'), adoptMs: -1, waitPollMs: -1, watchMs: -1 }, {
    ...rt.companions, identity: { ownerOfSession: rt.ownerOfSession }, tools: ctx.tools, connection: ctx.connection, now: () => 1000,
  })
  t.after(() => board.dispose())
  const added = await board.handle('add', { title: 'Newsletter', assignee: 'writer', brief: 'Write it.' })
  const [id] = Object.keys(added.value.cards)
  const card = () => board.store.read().cards[id]
  const reply = async (answer) => {
    rt.botReplied({ botId: 'writer', since: 1001, ...answer })
    await board.store.change(() => ({ error: 'settled' }))
  }
  await board.store.change(data => {
    data.cards[id].awaiting = { botId: 'writer', since: 1000 }
    return {}
  })
  await reply({ sessionId: 'writer', text: 'Unrelated chat reply during the note window.' })
  assert.deepEqual(card().notes ?? [], [])
  assert.deepEqual(card().awaiting, { botId: 'writer', since: 1000 })

  assert.equal((await board.handle('note', { id, text: 'Keep it short.' })).ok, true)
  const { requestId, sessionId } = prompts.at(-1)
  assert.deepEqual(card().awaiting.requests, [requestId])
  await reply({ sessionId: 'writer', heard: [requestId], text: 'Wrong session.' })
  assert.deepEqual(card().notes.map(note => note.text), ['Keep it short.'])
  await reply({ sessionId, heard: ['another-note'], text: 'Progress on earlier work.' })
  assert.deepEqual(card().notes.map(note => note.text), ['Keep it short.', 'Progress on earlier work.'])
  assert.deepEqual(card().awaiting.requests, [requestId])
  await reply({ cardId: id, sessionId, since: 1001 + AWAIT_MAX_MS, heard: [requestId], text: 'Done.' })
  assert.deepEqual(card().notes.map(note => note.text), ['Keep it short.', 'Progress on earlier work.', 'Done.'])
  assert.equal(card().awaiting, undefined)
})

test('a finished card closes its thread, after the turn running in it ends; the thread stays readable', async (t) => {
  const { rt, archived, saved, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'one' })
  await notes.startCard({ botId: 'writer', cardId: 'c_2', text: 'two' })
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_9' }), { closed: false })

  rt.live.set('card1', { turn: {} })
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_1' }), { closed: 'later' })
  assert.equal(saved().bots.writer.openParts[0].closing, true)
  rt.cardTurnEnded()
  assert.equal(rt.botOf('writer').openParts.length, 2)
  rt.live.delete('card1')
  rt.cardTurnEnded()
  const deadline = performance.now() + 2000
  while (archived.length === 0 && performance.now() < deadline) await delay(5)
  assert.deepEqual(rt.botOf('writer').openParts.map(part => part.card), ['c_2'])
  assert.deepEqual(archived, ['card1'])
  assert.equal(rt.chatOwners.has('card1'), false)
  assert.equal(rt.cardThreads.ofSession('card1'), undefined)
  assert.deepEqual(rt.ownerOfSession('card1'), { botId: 'writer' })
  assert.deepEqual(rt.pastOwners.get('card1'), { botId: 'writer' })
  assert.deepEqual(saved().bots.writer.closedCards.map(closed => [closed.card, closed.sessionId]), [['c_1', 'card1']])

  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_2' }), { closed: true })
  assert.deepEqual(rt.botOf('writer').openParts, [])
  assert.deepEqual(archived, ['card1', 'card2'])
})

test('a card started again while its old thread waits to close gets a new thread, and the old close leaves it', async (t) => {
  const { rt, archived, prompts, saved, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'first' })
  rt.live.set('card1', { turn: {} })
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_1' }), { closed: 'later' })
  assert.equal(saved().bots.writer.openParts[0].closing, true)
  assert.equal(rt.cardThreads.sessionOf('writer', 'c_1'), undefined)

  const again = await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'again' })
  assert.equal(again.sessionId, 'card2')
  assert.equal(prompts.at(-1).sessionId, 'card2')
  assert.equal(prompts.at(-1).content[0].text, 'again')
  const delivered = await notes.deliver({ botId: 'writer', cardId: 'c_1', text: 'later note' })
  assert.deepEqual([delivered.sessionId, delivered.where], ['card2', 'card'])
  assert.equal(prompts.at(-1).sessionId, 'card2')

  rt.live.delete('card1')
  rt.cardThreads.turnEnded()
  const deadline = performance.now() + 2000
  while (!archived.includes('card1') && performance.now() < deadline) await delay(5)
  assert.deepEqual(archived, ['card1'])
  assert.deepEqual(rt.botOf('writer').openParts.map(part => [part.sessionId, part.card, part.closing]), [['card2', 'c_1', undefined]])
  assert.equal(rt.cardThreads.sessionOf('writer', 'c_1'), 'card2')
  assert.equal(rt.cardThreads.isClosed('writer', 'c_1'), false)
  assert.equal(rt.chatOwners.get('card2'), 'writer')
})

test('a focused card thread finishes its pending close without archiving the foreground chat', async (t) => {
  const { rt, archived, stop } = await setup()
  t.after(stop)
  const sessionId = await rt.cardThreads.open('writer', 'c_1', 'Release', 'ops')
  assert.equal(await rt.switchPart('writer', sessionId), true)
  assert.deepEqual(rt.ownerOfSession(sessionId), { botId: 'writer', roomId: 'ops', cardId: 'c_1' })
  rt.live.set(sessionId, { turn: {} })
  assert.equal(await rt.cardThreads.close('writer', 'c_1'), 'later')
  rt.live.delete(sessionId)
  rt.cardThreads.turnEnded()
  await rt.save()
  assert.deepEqual(rt.ownerOfSession(sessionId), { botId: 'writer' })
  assert.equal(rt.chatOf('writer'), sessionId)
  assert.deepEqual(archived, [])
})

test('after a restart, open card threads are the Bot\'s again and closed ones stay readable', async (t) => {
  const first = await setup()
  await first.rt.companions.notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'one' })
  await first.rt.companions.notes.startCard({ botId: 'writer', cardId: 'c_2', text: 'two' })
  await first.rt.companions.notes.closeCard({ botId: 'writer', cardId: 'c_1' })
  const state = first.saved()
  await first.stop()
  const { rt, stop } = await setup({ state })
  t.after(stop)
  assert.deepEqual(rt.botOf('writer').openParts.map(part => part.card), ['c_2'])
  assert.equal(rt.chatOwners.get('card2'), 'writer')
  assert.equal(rt.cardOfSession('card2'), 'c_2')
  assert.deepEqual(rt.ownerOfSession('card2'), { botId: 'writer', cardId: 'c_2' })
  assert.deepEqual(rt.pastOwners.get('card1'), { botId: 'writer' })
})

test('the team view names the card of each open card thread and lists the closed ones', async (t) => {
  const { ctx, rt, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'one' })
  await notes.startCard({ botId: 'writer', cardId: 'c_2', text: 'two' })
  await notes.closeCard({ botId: 'writer', cardId: 'c_1' })
  const call = async endpoint => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload: {} }) }))).json()
  const writer = (await call('state')).value.bots.find(bot => bot.id === 'writer')
  assert.deepEqual(writer.openParts.map(part => [part.sessionId, part.card]), [['card2', 'c_2']])
  assert.deepEqual(writer.closedCards.map(part => [part.card, part.sessionId, part.parts]), [['c_1', 'card1', []]])
  assert.equal(typeof writer.closedCards[0].closedAt, 'number')
})
