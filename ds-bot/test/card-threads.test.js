import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
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
  // The Bot's chat stays where it was; the card thread is an open part with the card.
  const bot = rt.botOf('writer')
  assert.equal(bot.sessionId, 'writer')
  assert.deepEqual(bot.openParts.map(part => [part.sessionId, part.card]), [['card1', 'c_1']])
  assert.equal(rt.chatOwners.get('card1'), 'writer')
  assert.equal(rt.cardOfSession('card1'), 'c_1')
  assert.equal(rt.cardOfSession('writer'), undefined)
  assert.deepEqual(prompts.at(-1).sessionId, 'card1')
  assert.equal(prompts.at(-1).content[0].text, '[Card c_1] Write it.\n\nUnder 300 words.')
  assert.deepEqual(saved().bots.writer.openParts.map(part => part.card), ['c_1'])

  // The same card again finds its thread.
  assert.equal((await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'again' })).sessionId, 'card1')
  assert.deepEqual((await notes.deliver({ botId: 'writer', cardId: 'c_1', text: 'shorter please', requestId: 'im:telegram:9' })), { sessionId: 'card1', where: 'card', requestId: 'im:telegram:9' })
  assert.equal(prompts.at(-1).requestId, 'im:telegram:9')
  // A card with no thread falls back to the Bot's chat.
  assert.equal((await notes.deliver({ botId: 'writer', cardId: 'c_2', text: 'hi' })).where, 'chat')
})

test('a finished card closes its thread, after the turn running in it ends; the thread stays readable', async (t) => {
  const { rt, archived, saved, stop } = await setup()
  t.after(stop)
  const { notes } = rt.companions
  await notes.startCard({ botId: 'writer', cardId: 'c_1', text: 'one' })
  await notes.startCard({ botId: 'writer', cardId: 'c_2', text: 'two' })
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_9' }), { closed: false })

  // The Bot finishes c_1 from inside its thread: the close waits for that turn.
  rt.live.set('card1', { turn: {} })
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_1' }), { closed: 'later' })
  assert.equal(saved().bots.writer.openParts[0].closing, true)
  rt.cardTurnEnded()
  assert.equal(rt.botOf('writer').openParts.length, 2)
  rt.live.delete('card1')
  rt.cardTurnEnded()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(rt.botOf('writer').openParts.map(part => part.card), ['c_2'])
  assert.deepEqual(archived, ['card1'])
  assert.equal(rt.chatOwners.has('card1'), false)
  assert.deepEqual(rt.pastOwners.get('card1'), { botId: 'writer' })
  assert.deepEqual(saved().bots.writer.closedCards.map(closed => [closed.card, closed.sessionId]), [['c_1', 'card1']])

  // An idle thread closes at once.
  assert.deepEqual(await notes.closeCard({ botId: 'writer', cardId: 'c_2' }), { closed: true })
  assert.deepEqual(rt.botOf('writer').openParts, [])
  assert.deepEqual(archived, ['card1', 'card2'])
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
  assert.deepEqual(rt.pastOwners.get('card1'), { botId: 'writer' })
})
