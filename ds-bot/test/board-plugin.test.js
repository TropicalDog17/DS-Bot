import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name } from '../src/board/entry.js'
import { ROUTE, boardFileOf, install } from '../src/board/plugin.js'
import { READ_ONLY, openBoardStore } from '../src/board/store.js'
import { ACTIONS, ticketKey } from '../src/board/cards.js'
import { KEPT_THINK_MAX, callAbout, keep, visibleThought } from '../src/board/live.js'
import { createHerdr, herdrBinary, panesIn } from '../src/board/herdr.js'
import { commandOf } from '../src/board/plugin.js'
import { bridgeService, notesService, rosterService } from '../src/host/companions.js'
import { homeLock } from '../src/host/home-lock.js'
import { addCardThread, cardThreadSession, closeCardThread } from '../src/host/threads.js'

// The board plugin knows the team only through DS Bot's public services, so the tests
// build those services over a small fake team, exactly as the host provides them.
function fakeTeam() {
  const state = {
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' }, c: { id: 'c', name: 'Coder' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a' } },
  }
  const hasOwn = (object, id) => typeof id === 'string' && Object.hasOwn(object, id)
  const sent = []
  // The request id each note went with, in order.
  const requests = []
  const rt = {
    ctx: {},
    state,
    load: async () => {},
    botOf: id => (hasOwn(state.bots, id) ? state.bots[id] : undefined),
    roomOf: id => (hasOwn(state.rooms, id) ? state.rooms[id] : undefined),
    isMain: id => id === 'a',
    findBot: ref => (hasOwn(state.bots, ref) ? state.bots[ref] : Object.values(state.bots).find(bot => bot.name.toLowerCase() === ref.toLowerCase())),
    onSaved: () => () => {},
    sendUser: async input => { sent.push([input.sessionId, input.content[0].text]); requests.push(input.requestId) },
    deliver: async input => { delivered.push(input) },
    // Card threads as parts.js keeps them, named ct-<card id>.
    openCardThread: async (botId, cardId) => {
      const bot = state.bots[botId]
      const known = cardThreadSession(bot, cardId)
      if (known !== undefined) return known
      addCardThread(bot, `ct-${cardId}`, cardId)
      return `ct-${cardId}`
    },
    closeCardThread: async (botId, cardId) => closeCardThread(state.bots[botId], cardId) !== undefined,
    imPush: async (push) => { pushes.push(push); return 1 },
    routingParts: (part) => { parts.add(part); return () => { parts.delete(part) } },
    // Sessions in a turn, by id, as turns.js keeps them.
    live: new Map(),
    chatOf: id => id,
  }
  const pushes = []
  const delivered = []
  const parts = new Set()
  // Own chats a, b, c; group Sessions ga, gb; a talk between Writer and Coder, xb.
  const owners = { a: { botId: 'a' }, b: { botId: 'b' }, c: { botId: 'c' }, ga: { botId: 'a', roomId: 'r1' }, gb: { botId: 'b', roomId: 'r1' }, xb: { botId: 'b' } }
  const identity = { ownerOfSession: id => (hasOwn(owners, id) ? owners[id] : undefined), subscribe: () => () => {} }
  const notes = notesService(rt)
  const bridge = bridgeService(rt)
  // What turns.js does when a Bot's turn ends with an answer the user reads.
  const reply = heard => rt.botReplied(heard)
  return { state, owners, sent, requests, pushes, delivered, parts, live: rt.live, identity, roster: rosterService(rt), notes, bridge, bridged: () => rt.bridgedTools(), reply, cardNote: note => rt.cardNote(note) }
}

// threads: false is a host without card threads, where a card's notes reach the Bot in
// its own chat or its group and the card waits for the answer there.
function host(t, { file, notes, now = Date.now, config = {}, threads = true, herdr } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-board-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const team = fakeTeam()
  if (!threads) notes = { ...team.notes, startCard: async () => ({ error: 'Card threads are not available.' }) }
  const registered = { tools: [], routes: [] }
  const tools = { register: (tool) => { registered.tools.push(tool); return () => { registered.tools.splice(registered.tools.indexOf(tool), 1) } } }
  const connection = { fetch: { register: (route) => { registered.routes.push(route); return () => { registered.routes.splice(registered.routes.indexOf(route), 1) } } } }
  const boardFile = file ?? join(dir, 'bot-board', 'board.json')
  // DSH's own events, as a host would emit them to the plugin.
  const listeners = {}
  const ctx = { on: (name, listener) => { listeners[name] = listener; return () => { delete listeners[name] } } }
  const emit = (name, ...args) => listeners[name]?.(...args)
  const sections = new Map()
  const systemPrompt = { section: (section) => { sections.set(section.name, section); return () => { sections.delete(section.name) } } }
  const handle = install(ctx, { file: boardFile, adoptMs: -1, ...config }, { ...team, ...(notes ? { notes } : {}), ...(herdr ? { herdr } : {}), tools, connection, systemPrompt, store: openBoardStore(boardFile), now })
  t.after(() => handle.dispose())
  const tool = (args, sessionId = 'b') => registered.tools.find(entry => entry.name === 'board').execute(args, { agent: { id: sessionId } })
  const cards = () => Object.values(JSON.parse(readFileSync(boardFile, 'utf8')).cards)
  const post = async (endpoint, payload) => {
    const route = registered.routes.find(entry => entry.path === ROUTE)
    const response = await route.fetch(new Request('http://dsh/api/ds-bot-board', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // A copied answer is written after the event; the next change waits for it.
  const settle = () => handle.store.change(() => ({ error: 'settled' }))
  return { dir, team, handle, registered, tool, cards, post, boardFile, settle, emit, listeners, sections }
}

test('the entry is a separate plugin that needs only public services', () => {
  assert.equal(name, 'ds-bot-board')
  assert.deepEqual(inject, ['botSessionIdentity', 'dsBotRoster', 'dsBotNotes', 'dsBotBridge', 'tools', 'connection', 'systemPrompt'])
  let effects = 0
  apply({ effect: () => { effects += 1 } }, {})
  assert.equal(effects, 1)
  assert.equal(boardFileOf({}, { DSH_HOME: '/tmp/x-home' }), '/tmp/x-home/bot-board/board.json')
  assert.equal(boardFileOf({ file: '/data/b.json' }, {}), '/data/b.json')
})

test('board opens a card from a Bot\'s own chat and moves it through every column to done', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', brief: 'Do it.', title: '  Fix   login ', key: 'life-782', url: 'https://jira.example.com/browse/LIFE-782' }),
    /^Opened c_[0-9a-f]{8} · LIFE-782: Fix login \(In progress, Writer\)\./)
  const [card] = h.cards()
  assert.deepEqual([card.assignee, card.openedBy, card.status, card.key, card.url, card.roomId], ['b', 'b', 'active', 'LIFE-782', 'https://jira.example.com/browse/LIFE-782', undefined])
  for (const status of ['todo', 'review', 'blocked', 'active']) {
    await h.tool({ action: 'update', status })
    assert.equal(h.cards()[0].status, status)
  }
  assert.match(await h.tool({ action: 'update', id: 'LIFE-782', progress: 'PR  open', link: 'https://github.com/o/r/pull/7' }), /progress: PR open/)
  await h.tool({ action: 'update', link: 'https://github.com/o/r/pull/7' })
  assert.deepEqual(h.cards()[0].links.map(link => link.url), ['https://github.com/o/r/pull/7'])
  assert.equal(await h.tool({ action: 'complete' }), 'A finished card needs a one-line result.')
  assert.match(await h.tool({ action: 'complete', result: 'Merged' }), /^Finished c_.* · LIFE-782: "Merged"/)
  assert.deepEqual([h.cards()[0].status, h.cards()[0].result, typeof h.cards()[0].doneAt], ['done', 'Merged', 'number'])
  assert.match(await h.tool({ action: 'show' }), /Done \(latest 1 of 1\):\n- c_.* · LIFE-782 · Writer · Fix login/)
})

test('a card keeps the steps it went through, and what the user must do while it waits on them', async (t) => {
  let clock = 1000
  const h = host(t, { now: () => clock })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Ship it', progress: 'starting' })
  clock = 2000
  await h.tool({ action: 'update', progress: 'PR up' })
  clock = 3000
  // Into Review without saying what the user must do: the Bot is told to say it.
  assert.match(await h.tool({ action: 'update', status: 'review' }), /Say with need what the user must do/)
  clock = 4000
  assert.doesNotMatch(await h.tool({ action: 'update', need: 'Approve and merge [o/r#7](https://github.com/o/r/pull/7).' }), /Say with need/)
  // A link alone is not a step.
  await h.tool({ action: 'update', link: 'https://github.com/o/r/pull/7' })
  const [card] = h.cards()
  assert.equal(card.need, 'Approve and merge [o/r#7](https://github.com/o/r/pull/7).')
  assert.deepEqual(card.log, [
    { at: 1000, by: 'b', status: 'active', progress: 'starting' },
    { at: 2000, by: 'b', status: 'active', progress: 'PR up' },
    { at: 3000, by: 'b', status: 'review', progress: 'PR up' },
  ])
  assert.match(await h.tool({ action: 'show' }), /the user must: Approve and merge/)
  // Back to work, the need goes; the user's own move is a step too.
  clock = 5000
  await h.post('move', { id: card.id, status: 'active' })
  assert.equal(h.cards()[0].need, undefined)
  assert.deepEqual(h.cards()[0].log.at(-1), { at: 5000, by: 'user', status: 'active', progress: 'PR up' })
  // Blocked with a need; finishing drops it.
  await h.tool({ action: 'update', status: 'blocked', need: 'Grant deploy access.' })
  assert.equal(h.cards()[0].need, 'Grant deploy access.')
  await h.tool({ action: 'complete', result: 'Shipped' })
  assert.equal(h.cards()[0].need, undefined)
})

test('a group card remembers its group; a talk between Bots does not', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Group work' }, 'gb')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Pair work' }, 'xb')
  const [group, pair] = h.cards()
  assert.equal(group.roomId, 'r1')
  assert.equal(pair.roomId, undefined)
  const shown = await h.tool({ action: 'show' }, 'c')
  assert.match(shown, /In progress:\n- c_\w+ · Writer · Group work\n- c_\w+ · Writer · Pair work/)
  assert.doesNotMatch(shown, /\(yours\)/)
})

test('who may change and cancel a card: assignee, opener, a Main Bot, or the group admin for cancel', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', title: 'Write tests', assignee: 'Coder', status: 'todo', brief: 'Cover the parser.' }, 'a'), /\(Todo, Coder\)/)
  assert.match(await h.tool({ action: 'open', brief: 'Do it.', title: 'Approve the PR', assignee: 'user' }, 'a'), /the user\)/)
  const [forCoder] = h.cards()
  assert.match(await h.tool({ action: 'update', status: 'active' }, 'c'), /In progress/)
  assert.equal(await h.tool({ action: 'update', id: forCoder.id, progress: 'x' }, 'b'), `${forCoder.id} belongs to Coder.`)
  assert.equal(await h.tool({ action: 'cancel', id: forCoder.id }, 'b'), `${forCoder.id} belongs to Coder; only its assignee, the Bot that opened it or a Main Bot cancels it.`)
  assert.match(await h.tool({ action: 'cancel', id: forCoder.id, reason: 'scope cut' }, 'a'), /^Cancelled/)
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: 'x', assignee: 'Nobody' }, 'a'), 'No Bot named Nobody. Use an exact name from list_bots, or "user".')
})

test('board validates its input strictly and refuses Sessions that are not Bots', async (t) => {
  const h = host(t)
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: 'x' }, 'nobody'), 'Only Bots on the team can use board.')
  await assert.rejects(h.tool({ action: 'move' }), /"action" must be one of/)
  await assert.rejects(h.tool({ action: 'open', brief: 'Do it.', title: 'x', status: 'done' }), /"status" must be one of/)
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: ' ' }), 'A card needs a one-line title.')
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: 'x', key: 'not a key' }), 'key is a ticket key like LIFE-782.')
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: 'x', url: 'javascript:alert(1)' }), 'url must be an http(s) address.')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'First', key: 'LIFE-1' })
  const first = h.cards()[0]
  assert.equal(await h.tool({ action: 'open', brief: 'Do it.', title: 'Again', key: 'LIFE-1' }), `LIFE-1 is already on the board as ${first.id}; update that card.`)
  assert.equal(h.cards().length, 1)
  for (const terminal of ['complete', 'cancel']) {
    const id = (await h.tool({ action: 'open', brief: 'Do it.', title: `Deliver ${terminal}` })).match(/c_[0-9a-f]{8}/)[0]
    await h.tool({ action: terminal, id, result: 'delivered', reason: 'stopped' })
    for (const action of ['update', 'complete', 'cancel']) assert.equal(await h.tool({ action, id, status: 'active', result: 'changed' }), `${id} is already finished.`)
  }
  assert.equal(ticketKey('ab-12'), 'AB-12')
  assert.equal(ticketKey('12-AB'), undefined)
})

test('a Bot asks the user with options: the card moves to Review and the pick comes back as a note', async (t) => {
  const h = host(t, { threads: false })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Deploy' })
  assert.equal(await h.tool({ action: 'ask', question: 'Where?', options: ['Staging'] }), 'ask needs 2 to 6 different options.')
  assert.equal(await h.tool({ action: 'ask', question: 'Where?', options: ['a', ' a ', ''] }), 'ask needs 2 to 6 different options.')
  assert.equal(await h.tool({ action: 'ask', question: ' ', options: ['a', 'b'] }), 'ask needs a question.')
  const [card] = h.cards()
  assert.equal(await h.tool({ action: 'ask', id: card.id, question: 'Where?', options: ['a', 'b'] }, 'a'), `${card.id} belongs to Writer; only its assignee asks on it.`)
  assert.match(await h.tool({ action: 'ask', question: 'Which **environment**?', options: [' Staging ', 'Production'] }),
    /^Asked on c_\w+: Staging \/ Production\. The user's pick reaches you as a note on the card\.\n.*\n.*latest note from Writer: Which \*\*environment\*\*\? \(options: Staging \/ Production\)/)
  const asked = h.cards()[0]
  assert.deepEqual([asked.status, asked.unread, asked.notes.at(-1)], ['review', true, { at: asked.notes.at(-1).at, by: 'b', text: 'Which **environment**?', options: ['Staging', 'Production'] }])
  await h.post('note', { id: card.id, text: 'Production' })
  assert.deepEqual(h.team.sent.at(-1), ['b', `Note on card ${card.id} "Deploy": Production`])
})

test('the Board page adds, moves, notes and cancels; notes reach the Bot through dsBotNotes', async (t) => {
  const h = host(t, { threads: false })
  const state = await h.post('state')
  assert.equal(state.ok, true)
  assert.deepEqual(state.value.cards, {})
  assert.deepEqual(state.value.bots.map(bot => [bot.id, bot.main]), [['a', true], ['b', false], ['c', false]])
  const added = await h.post('add', { title: 'Đặt lịch khám răng', assignee: 'b', key: '', url: '' })
  const card = Object.values(added.value.cards)[0]
  assert.deepEqual([card.title, card.assignee, card.openedBy, card.status], ['Đặt lịch khám răng', 'b', 'user', 'todo'])
  assert.deepEqual((await h.post('add', { title: ' ' })).error, { code: 'board/refused', message: 'Write a title first.' })
  assert.equal((await h.post('add', { title: 'x', assignee: 'zz' })).error.message, 'No such Bot.')
  assert.equal((await h.post('move', { id: card.id, status: 'done' })).value.cards[card.id].status, 'done')
  assert.equal((await h.post('move', { id: card.id, status: 'blocked' })).value.cards[card.id].doneAt, undefined)
  assert.equal((await h.post('move', { id: card.id, status: 'nowhere' })).error.message, 'Unknown column.')

  await h.post('note', { id: card.id, text: '  gọi trước 5h ' })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Group work' }, 'gb')
  const group = h.cards().find(entry => entry.roomId === 'r1')
  await h.post('note', { id: group.id, text: 'add tests' })
  const mine = (await h.post('add', { title: 'Mine' })).value
  const mineId = Object.values(mine.cards).find(entry => entry.title === 'Mine').id
  await h.post('note', { id: mineId, text: 'remember' })
  // The card started Writer's card thread; done closed it, so the later note goes to its chat.
  assert.match(h.team.sent[0][1], /^\[Card c_\w+ · "Đặt lịch khám răng"\] from the user\./)
  assert.deepEqual(h.team.sent.slice(1), [
    ['b', `Note on card ${card.id} "Đặt lịch khám răng": gọi trước 5h`],
    ['r1', `@Writer Note on card ${group.id} "Group work": add tests`],
  ])
  assert.deepEqual(h.cards().find(entry => entry.id === mineId).notes.map(note => note.text), ['remember'])

  assert.equal((await h.post('cancel', { id: card.id, reason: 'not needed' })).value.cards[card.id].status, 'cancelled')
  assert.equal((await h.post('cancel', { id: card.id })).error.message, 'That card is already finished.')
  assert.equal((await h.post('move', { id: card.id, status: 'todo' })).error.message, 'That card is cancelled.')
  assert.equal((await h.post('move', { id: 'nope', status: 'todo' })).error.message, 'No such card.')
  assert.equal((await h.post('wat')).error.code, 'board/unknown')
})

test('chat is where the Bot answers: the answer that read the note is copied onto the card', async (t) => {
  let clock = 1000
  const h = host(t, { now: () => clock, threads: false })
  // Writer took the card in its own chat: no card thread, so notes reach that chat.
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Đặt lịch khám răng' }, 'b')
  const id = h.cards()[0].id
  await h.post('note', { id, text: 'gọi trước 5h nhé' })
  const [first] = h.team.requests
  assert.deepEqual(h.cards()[0].awaiting, { botId: 'b', since: 1000, requests: [first] })

  // Another Bot, the Bot in a group, or an answer to something else is not the answer.
  h.team.reply({ botId: 'c', text: 'not mine', since: 1100, heard: [first] })
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'in Ops', since: 1100, heard: [first] })
  h.team.reply({ botId: 'b', text: 'typed in chat', since: 1100 })
  h.team.reply({ botId: 'b', text: 'another note', since: 1100, heard: ['elsewhere'] })
  await h.settle()
  assert.equal(h.cards()[0].notes.length, 1)

  h.team.reply({ botId: 'b', text: '  Ok, mình gọi lúc 4h.\r\n\n\n\nXong sẽ báo.  ', since: 1200, heard: ['elsewhere', first] })
  await h.settle()
  // One answer per note: the Bot's next turn stays in its chat.
  h.team.reply({ botId: 'b', text: 'something else', since: 1300, heard: [first] })
  await h.settle()
  clock = 2000
  await h.post('note', { id, text: 'cảm ơn' })
  h.team.reply({ botId: 'b', text: 'Không có gì', since: 2100, heard: [h.team.requests[1]] })
  await h.settle()
  const card = (await h.post('state')).value.cards[id]
  assert.deepEqual(card.notes.map(note => [note.by, note.text]), [
    ['user', 'gọi trước 5h nhé'],
    ['b', 'Ok, mình gọi lúc 4h.\n\nXong sẽ báo.'],
    ['user', 'cảm ơn'],
    ['b', 'Không có gì'],
  ])
  assert.equal(card.notes.every(note => typeof note.at === 'number'), true)
  assert.equal(card.awaiting, undefined)
  // The Bot answers in chat only; the board tool has no reply action.
  assert.equal(ACTIONS.includes('reply'), false)
})

test('notes on three cards to one Bot: each answer lands on the cards whose notes it read, in any order', async (t) => {
  const h = host(t, { threads: false })
  const open = async (title) => {
    await h.tool({ action: 'open', brief: 'Do it.', title }, 'b')
    return h.cards().find(card => card.title === title).id
  }
  const honey = await open('honey: flaky test')
  const preset = await open('dual-investment-alpha: preset')
  const gateway = await open('gateway: images')
  await h.post('note', { id: honey, text: 'sao ròi' })
  await h.post('note', { id: preset, text: 'sao rồi' })
  await h.post('note', { id: gateway, text: 'check xem ok chưa' })
  const [toHoney, toPreset, toGateway] = h.team.requests

  // The first turn read two notes (the second was steered into it); it answers both cards.
  h.team.reply({ botId: 'b', text: 'honey and preset', since: Date.now(), heard: [toHoney, toPreset] })
  h.team.reply({ botId: 'b', text: 'gateway', since: Date.now(), heard: [toGateway] })
  await h.post('note', { id: preset, text: '???' })
  h.team.reply({ botId: 'b', text: 'preset again', since: Date.now(), heard: [h.team.requests[3]] })
  await h.settle()
  const byId = (await h.post('state')).value.cards
  const thread = id => byId[id].notes.map(note => note.text)
  assert.deepEqual(thread(honey), ['sao ròi', 'honey and preset'])
  assert.deepEqual(thread(preset), ['sao rồi', 'honey and preset', '???', 'preset again'])
  assert.deepEqual(thread(gateway), ['check xem ok chưa', 'gateway'])
  assert.equal([honey, preset, gateway].some(id => byId[id].awaiting !== undefined), false)
})

test('a Bot\'s answer copied onto a card is unread until the user opens the card', async (t) => {
  const clock = 1000
  const h = host(t, { now: () => clock, threads: false })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Fix login', key: 'LIFE-782' }, 'b')
  const id = h.cards()[0].id
  await h.post('note', { id, text: 'có cần log không?' })
  // The user's own note is not news to them.
  assert.equal(h.cards()[0].unread, undefined)
  h.team.reply({ botId: 'b', text: 'Có, thêm log ở redirect.', since: 1100, heard: h.team.requests })
  await h.settle()
  assert.equal(h.cards()[0].unread, true)
  const updated = h.cards()[0].updatedAt
  const seen = await h.post('seen', { id })
  assert.equal(seen.ok, true)
  assert.equal(seen.value.cards[id].unread, undefined)
  // Reading a card is not a change to it.
  assert.equal(h.cards()[0].updatedAt, updated)
  assert.equal((await h.post('seen', { id: 'c_missing' })).ok, false)
})

test('a group card waits for the answer in its group; two notes wait from the first; stale waits lapse', async (t) => {
  let clock = 1000
  const h = host(t, { now: () => clock, threads: false })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Group work' }, 'gb')
  const group = h.cards()[0].id
  await h.post('note', { id: group, text: 'add tests' })
  clock = 1500
  await h.post('note', { id: group, text: 'and docs' })
  // The round shows the note to the Bot, so the turn that read it names it.
  assert.deepEqual(h.cards()[0].awaiting, { botId: 'b', roomId: 'r1', since: 1000, requests: h.team.requests.slice(0, 2) })
  h.team.reply({ botId: 'b', text: 'in my own chat', since: 1200, heard: h.team.requests.slice(0, 2) })
  // A turn there that did not read the note is about something else, also a later one.
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'closed the old sessions', since: 1600 })
  // The turn that read the note answers it, though it began before the note.
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'On it: tests first.', since: 900, heard: [h.team.requests[1]] })
  await h.settle()
  assert.deepEqual(h.cards()[0].notes.map(note => note.text), ['add tests', 'and docs', 'On it: tests first.'])

  // Two group cards that waited before notes had ids: the one asked first gets the first answer.
  clock = 5000
  await h.tool({ action: 'open', brief: 'Do it.', title: 'One' }, 'gb')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Two' }, 'gb')
  const idOf = title => h.cards().find(card => card.title === title).id
  const [first, second] = [idOf('One'), idOf('Two')]
  await h.post('note', { id: second, text: 'two?' })
  clock = 4000
  await h.post('note', { id: first, text: 'one?' })
  await h.handle.store.change((data) => { for (const id of [first, second]) delete data.cards[id].awaiting.requests })
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'answer one', since: 6000 })
  await h.settle()
  const byId = (await h.post('state')).value.cards
  assert.deepEqual(byId[first].notes.map(note => note.text), ['one?', 'answer one'])
  assert.deepEqual(byId[second].notes.map(note => note.text), ['two?'])
  // Half a day later the wait is over: an answer then is about something else.
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'much later', since: 5000 + 12 * 60 * 60 * 1000 + 1 })
  await h.settle()
  assert.deepEqual(h.cards().find(card => card.id === second).notes.map(note => note.text), ['two?'])
})

test('a chat card that waited before request ids still gets the next answer there', async (t) => {
  const h = host(t)
  const id = Object.keys((await h.post('add', { title: 'Old wait', assignee: 'b' })).value.cards)[0]
  await h.handle.store.change(data => { data.cards[id].awaiting = { botId: 'b', since: 1000 } })
  h.team.reply({ botId: 'b', text: 'answer', since: 2000, heard: ['unknown'] })
  await h.settle()
  assert.deepEqual(h.cards()[0].notes.map(note => note.text), ['answer'])
})

test('a waiting card shows what its Bot is doing: reasoning as it streams and each tool call', async (t) => {
  let clock = 1000
  const h = host(t, { now: () => clock, threads: false })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Sửa lỗi đăng nhập' }, 'b')
  const id = h.cards()[0].id
  await h.post('note', { id, text: 'xem giúp log nhé' })
  const session = { id: 'b' }
  const event = (type, data, time = clock) => h.emit('session/event', session, { type, data, time })
  const frame = (frame) => h.emit('agent/assistant-stream', { agent: session, frame })
  const think = (attemptId, text) => frame({ type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', index: 0, text } })

  // A turn that began before the note is other work: the card only waits.
  event('turn/start', { turn: 1 }, 900)
  frame({ type: 'start', attemptId: 'a0' })
  think('a0', 'older work')
  assert.deepEqual((await h.post('state')).value.live, {})

  clock = 1100
  event('turn/start', { turn: 2 })
  frame({ type: 'start', attemptId: 'a1' })
  think('a1', '<signature>xyz</signature>\nThe user wants ')
  think('a1', 'the login log.')
  frame({ type: 'end', attemptId: 'a1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } })
  event('tool/call', { callId: 'k1', name: 'read_file', arguments: JSON.stringify({ path: '/var/log/app/login.log' }) })
  let live = (await h.post('state')).value.live[id]
  assert.equal(live.since, 1100)
  assert.deepEqual(live.steps, [
    { kind: 'think', text: 'The user wants the login log.' },
    { kind: 'tool', tool: 'read_file', target: 'login.log', input: 'path: /var/log/app/login.log', state: 'running' },
  ])
  event('tool/result', { message: { toolCallId: 'k1', isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] } })
  event('tool/call', { callId: 'k2', name: 'bash', arguments: JSON.stringify({ command: 'tail -n 50 login.log', description: 'Read the last lines' }) })
  event('tool/result', { message: { toolCallId: 'k2', content: [{ type: 'text', text: 'token expired\n' + 'x'.repeat(3000) }] } })
  // An attempt that failed and was retried leaves nothing behind.
  frame({ type: 'start', attemptId: 'a2' })
  think('a2', 'half a thought')
  frame({ type: 'end', attemptId: 'a2', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 6 } })
  frame({ type: 'start', attemptId: 'a3' })
  think('a3', 'Found it.')
  live = (await h.post('state')).value.live[id]
  assert.deepEqual(live.steps.map(step => [step.kind, step.text ?? step.tool, step.state]), [
    ['think', 'The user wants the login log.', undefined],
    ['tool', 'read_file', 'failed'],
    ['tool', 'bash', 'done'],
    ['think', 'Found it.', undefined],
  ])
  // Each call opens on what it was given and what it gave back, cut short.
  assert.equal(live.steps[1].output, 'ENOENT: no such file')
  assert.equal(live.steps[2].input, 'command: tail -n 50 login.log\ndescription: Read the last lines')
  assert.match(live.steps[2].output, /^token expired\nx+…$/)
  assert.equal(live.steps[2].output.length, 1200)
  const { input: _input, output: _output, ...line } = live.steps[2]
  assert.deepEqual(line, { kind: 'tool', tool: 'bash', note: 'Read the last lines', target: 'tail -n 50 login.log', state: 'done' })

  // The answer lands on the card with how the Bot got there; the card stops waiting.
  clock = 4100
  event('turn/end', { turn: 2 })
  h.team.reply({ botId: 'b', text: 'Lỗi do token hết hạn.', since: 1100, heard: h.team.requests })
  await h.settle()
  const state = (await h.post('state')).value
  assert.deepEqual(state.live, {})
  const answer = state.cards[id].notes.at(-1)
  assert.equal(answer.text, 'Lỗi do token hết hạn.')
  assert.equal(answer.trace.ms, 3000)
  assert.deepEqual(answer.trace.steps.map(step => step.kind), ['think', 'tool', 'tool', 'think'])
  assert.equal(answer.trace.steps[2].output.length, 600)
  assert.equal(state.trace, 'thinking')
  // Another Bot's Session, or a Session that is no Bot's, is not traced.
  h.emit('session/event', { id: 'nobody' }, { type: 'turn/start', data: {}, time: 5000 })
  h.handle.dispose()
  assert.deepEqual(Object.keys(h.listeners), [])
})

test('the board level sets how much of a Bot\'s work shows and stays: off, tool calls, thinking, all', async (t) => {
  let clock = 1000
  const h = host(t, { now: () => clock, threads: false })
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Logs' }, 'b')
  const id = h.cards()[0].id
  const session = { id: 'b' }
  const event = (type, data) => h.emit('session/event', session, { type, data, time: clock })
  const frame = (frame) => h.emit('agent/assistant-stream', { agent: session, frame })
  const turn = async (text) => {
    await h.post('note', { id, text })
    clock += 100
    event('turn/start', {})
    frame({ type: 'start', attemptId: `a${clock}` })
    frame({ type: 'chunk', attemptId: `a${clock}`, chunk: { type: 'reasoning-delta', text: 'Thinking hard.' } })
    event('tool/call', { callId: `k${clock}`, name: 'bash', arguments: '{"command":"ls"}' })
    event('tool/result', { message: { toolCallId: `k${clock}`, content: 'a.txt' } })
  }
  const answer = async () => {
    const since = clock
    clock += 1000
    event('turn/end', {})
    h.team.reply({ botId: 'b', text: 'done', since, heard: [h.team.requests.at(-1)] })
    await h.settle()
    return h.cards()[0].notes.at(-1).trace
  }

  assert.equal((await h.post('trace', { trace: 'loud' })).error.message, 'Unknown level.')
  assert.equal((await h.post('trace', { trace: 'tools' })).value.trace, 'tools')
  await turn('one')
  assert.deepEqual((await h.post('state')).value.live[id].steps.map(step => step.kind), ['tool'])
  assert.deepEqual((await answer()).steps.map(step => step.kind), ['tool'])

  await h.post('trace', { trace: 'off' })
  await turn('two')
  assert.deepEqual((await h.post('state')).value.live, {})
  assert.equal(await answer(), undefined)

  await h.post('trace', { trace: 'all' })
  await turn('three')
  assert.deepEqual((await h.post('state')).value.live[id].steps.map(step => step.kind), ['think', 'tool'])
  const kept = await answer()
  assert.deepEqual(kept.steps[1], { kind: 'tool', tool: 'bash', target: 'ls', input: 'command: ls', output: 'a.txt', state: 'done' })
  // The level is the board's, kept in its file.
  assert.equal(JSON.parse(readFileSync(h.boardFile, 'utf8')).settings.trace, 'all')
})

test('a Bot on a local agent CLI shows its own tool lines; a kept trace is short', () => {
  const trace = { since: 0, steps: [{ kind: 'think', text: 'Plan it.\n▸ Read src/app.js\nLooks fine.\n▸ Ran npm test' }] }
  assert.deepEqual(keep({ ...trace, endedAt: 500 }).steps, [
    { kind: 'think', text: 'Plan it.' },
    { kind: 'tool', text: 'Read src/app.js', state: 'done' },
    { kind: 'think', text: 'Looks fine.' },
    { kind: 'tool', text: 'Ran npm test', state: 'done' },
  ])
  assert.equal(keep({ ...trace, endedAt: 500 }).ms, 500)
  const long = keep({ since: 0, endedAt: 1, steps: [{ kind: 'think', text: 'a'.repeat(5000) }, { kind: 'tool', tool: 'bash', state: 'running' }, { kind: 'think', text: 'b'.repeat(5000) }] })
  assert.deepEqual(long.steps.map(step => step.kind), ['tool', 'think'])
  assert.equal(long.steps[1].text.length, KEPT_THINK_MAX)
  assert.equal(long.steps[0].state, 'done')
  assert.equal(keep({ since: 0, steps: [] }), undefined)
  assert.equal(visibleThought('<signature>abc'), '')
  assert.equal(visibleThought('<b>bold</b>'), '<b>bold</b>')
  assert.deepEqual(callAbout('{"url":"https://example.com/a","query":"login"}'), { target: 'login' })
  assert.deepEqual(callAbout('not json'), {})
})

test('a card keeps the last 200 messages of its conversation', async (t) => {
  const h = host(t)
  const added = await h.post('add', { title: 'Long talk', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
  for (let n = 1; n <= 205; n += 1) await h.post('note', { id, text: `m${n}` })
  const thread = h.cards()[0].notes
  assert.equal(thread.length, 200)
  assert.deepEqual([thread[0].text, thread.at(-1).text], ['m6', 'm205'])
})

test('a note whose delivery fails is kept on the card and says it was not sent', async (t) => {
  const h = host(t, { notes: { deliver: async () => { throw new Error('host busy') } } })
  const added = await h.post('add', { title: 'Ship', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
  const result = await h.post('note', { id, text: 'still there?' })
  assert.deepEqual(result.error, { code: 'board/refused', message: 'Saved on the card, but not sent: host busy' })
  assert.deepEqual(h.cards()[0].notes.map(note => note.text), ['still there?'])
  // Nothing reached the Bot, so the card waits for no answer.
  assert.equal(h.cards()[0].awaiting, undefined)
})

test('disposing the plugin takes back its tool, its share on the CLI bridge and its route', async (t) => {
  const h = host(t)
  assert.equal(h.registered.tools.length, 1)
  assert.deepEqual(h.team.bridged(), ['board'])
  assert.equal(h.registered.routes.length, 1)
  h.handle.dispose()
  assert.equal(h.registered.tools.length, 0)
  assert.deepEqual(h.team.bridged(), [])
  assert.equal(h.registered.routes.length, 0)
})

test('storage: atomic whole-file writes, a broken file kept aside, one writer per home', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-board-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board.json')
  const store = openBoardStore(file)
  t.after(() => store.dispose())
  assert.deepEqual(store.read(), { version: 1, cards: {} })
  await Promise.all([1, 2, 3].map(n => store.change(data => { data.cards[`c_${n}`] = { id: `c_${n}`, n } })))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).cards).sort(), ['c_1', 'c_2', 'c_3'])
  assert.deepEqual(readdirSync(dir).filter(entry => entry.endsWith('.tmp')), [])
  // A refused change writes nothing.
  assert.deepEqual(await store.change(data => { data.cards.x = { id: 'x' }; return { error: 'no' } }), { error: 'no' })
  assert.equal(store.read().cards.x, undefined)
  // A change written by the other host is read back.
  writeFileSync(file, JSON.stringify({ version: 1, cards: { c_9: { id: 'c_9' }, bad: { id: 'other' } } }))
  assert.deepEqual(Object.keys(store.read().cards), ['c_9'])

  // A second host on the same home only reads.
  const other = openBoardStore(file, { lock: homeLock(join(dir, 'board.lock'), { pid: process.pid + 1, isAlive: () => true }) })
  assert.equal(other.readOnly(), true)
  assert.deepEqual(await other.change(data => { data.cards.y = { id: 'y' } }), { error: READ_ONLY })
  assert.deepEqual(Object.keys(other.read().cards), ['c_9'])

  writeFileSync(file, '{ not json')
  assert.deepEqual(store.read().cards, {})
  assert.equal(readdirSync(dir).some(entry => entry.startsWith('board.json.broken-')), true)
  assert.equal(existsSync(file), true)
})

test('a card handed to another Bot needs a brief, starts that Bot\'s card thread and closes it when done', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', title: 'Draft the newsletter', assignee: 'Writer' }, 'a'), /^A card for Writer needs a brief/)
  const said = await h.tool({ action: 'open', title: 'Draft the newsletter', assignee: 'Writer', brief: 'Topic: the November release.\nKeep it under 300 words.' }, 'a')
  assert.match(said, /The card reaches Writer by itself; do not also message it\./)
  const [card] = h.cards()
  assert.equal(card.brief, 'Topic: the November release.\nKeep it under 300 words.')
  const thread = `ct-${card.id}`
  assert.deepEqual(h.team.state.bots.b.openParts.map(part => [part.sessionId, part.card]), [[thread, card.id]])
  assert.equal(h.team.sent[0][0], thread)
  assert.match(h.team.sent[0][1], /^\[Card c_\w+ · "Draft the newsletter"\] from Chief\.\n\nTopic: the November release\.\nKeep it under 300 words\.\n\nThis conversation is for this card only\./)

  // Every answer in the card thread is the card's; a note on the card goes to the thread.
  h.team.reply({ botId: 'b', cardId: card.id, text: 'On it.', since: Date.now() })
  await h.settle()
  await h.post('note', { id: card.id, text: 'mention the new board' })
  assert.deepEqual(h.team.sent.at(-1), [thread, `Note on card ${card.id} "Draft the newsletter": mention the new board`])
  assert.deepEqual(h.cards()[0].awaiting.cardId, card.id)
  h.team.reply({ botId: 'b', cardId: card.id, text: 'Added it.', since: Date.now() })
  // Another Bot cannot answer for the card.
  h.team.reply({ botId: 'c', cardId: card.id, text: 'not mine', since: Date.now() })
  await h.settle()
  assert.deepEqual(h.cards()[0].notes.map(note => [note.by, note.text]), [['b', 'On it.'], ['user', 'mention the new board'], ['b', 'Added it.']])

  assert.match(await h.tool({ action: 'complete', id: card.id, result: 'Draft in docs/news.md' }, 'b'), /^Finished/)
  assert.deepEqual(h.team.state.bots.b.openParts, [])
  assert.deepEqual(h.team.state.bots.b.closedCards.map(closed => [closed.card, closed.sessionId]), [[card.id, thread]])
})

test('a card a Bot opens for itself needs a brief and runs in a card thread of its own', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', title: 'Fix CI' }, 'gb'), /^A card needs a brief/)
  const said = await h.tool({ action: 'open', title: 'Fix CI', brief: 'The lint job fails on main.' }, 'gb')
  assert.match(said, /Its work runs in a conversation of its own that starts now: do not do it here\./)
  const [card] = h.cards()
  assert.deepEqual(h.team.state.bots.b.openParts.map(part => [part.sessionId, part.card]), [[`ct-${card.id}`, card.id]])
  assert.deepEqual(h.team.sent.map(([sessionId]) => sessionId), [`ct-${card.id}`])
  assert.match(h.team.sent[0][1], /^\[Card c_\w+ · "Fix CI"\] opened by you\.\n\nThe lint job fails on main\.\n\nThis conversation is for this card only\./)
  // A card for the user has no thread and needs no brief.
  assert.match(await h.tool({ action: 'open', title: 'Approve it', assignee: 'user' }, 'b'), /\(In progress, the user\)\.\n/)
  assert.equal(h.team.sent.length, 1)
})

test('without card threads a card a Bot opens for itself stays where it is', async (t) => {
  const h = host(t, { threads: false })
  const said = await h.tool({ action: 'open', title: 'Fix CI', brief: 'The lint job fails.' }, 'gb')
  assert.match(said, /The card could not get a conversation of its own, so do its work here after all\./)
  assert.deepEqual(h.team.sent, [])
})

test('an open card without a card thread moves into one, with a brief that says where its work was', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', title: 'Merge the indexer', key: 'LIFE-782', brief: 'Merge #1209.' }, 'gb')
  await h.tool({ action: 'open', title: 'Fix CI', assignee: 'Coder', brief: 'The lint job fails.' }, 'a')
  await h.tool({ action: 'open', title: 'Done already', brief: 'x' }, 'b')
  await h.tool({ action: 'open', title: 'Approve it', assignee: 'user' }, 'a')
  const [indexer, ci, done] = h.cards()
  await h.tool({ action: 'update', id: indexer.id, status: 'review', progress: 'PR #74 up', link: 'https://github.com/o/r/pull/74' }, 'b')
  await h.post('note', { id: indexer.id, text: 'wait for CI' })
  await h.tool({ action: 'complete', id: done.id, result: 'ok' }, 'b')
  // As before card threads: neither card has one.
  closeCardThread(h.team.state.bots.b, indexer.id)
  closeCardThread(h.team.state.bots.c, ci.id)
  h.team.sent.length = 0

  // Coder is in a turn, so its card waits; Writer's moves.
  h.team.live.set('c', { turn: 't1' })
  assert.deepEqual(await h.handle.adoptOnce(), { moved: [indexer.id], waiting: 1 })
  assert.equal(cardThreadSession(h.team.state.bots.b, indexer.id), `ct-${indexer.id}`)
  assert.deepEqual(h.team.sent.map(([sessionId]) => sessionId), [`ct-${indexer.id}`])
  assert.equal(h.team.sent[0][1], [
    `[Card ${indexer.id} · LIFE-782 · "Merge the indexer"] moved to a conversation of its own.`,
    '',
    'Merge #1209.',
    '',
    'Status: Review. Progress: PR #74 up. Links: https://github.com/o/r/pull/74',
    '',
    'Latest on the card:',
    '- the user: wait for CI',
    '',
    'Its earlier work is in the group "Ops" (read_group_chat): search it for LIFE-782 and read what you need before you act, and do not redo what is done. If the card is waiting (Review or Blocked), say its state in one line and stop.',
    '',
    `This conversation is for this card only. Keep it moving with board update (id ${indexer.id}); when you need the user to decide, board ask; finish with board complete and a one-line result, or board cancel with the reason.`,
  ].join('\n'))
  h.team.live.clear()
  assert.deepEqual(await h.handle.adoptOnce(), { moved: [ci.id], waiting: 0 })
  assert.equal(cardThreadSession(h.team.state.bots.c, ci.id), `ct-${ci.id}`)
  // Nothing left to move.
  assert.deepEqual(await h.handle.adoptOnce(), { moved: [], waiting: 0 })
})

test('a card the user adds for a Bot starts its thread; cancelling or moving it to Done closes it', async (t) => {
  const h = host(t)
  const one = Object.values((await h.post('add', { title: 'Book the dentist', assignee: 'c', brief: 'Before Friday.' })).value.cards)[0]
  assert.match(h.team.sent[0][1], /from the user\.\n\nBefore Friday\./)
  await h.post('cancel', { id: one.id, reason: 'done by phone' })
  const two = Object.values((await h.post('add', { title: 'Renew the domain', assignee: 'c' })).value.cards).find(card => card.title === 'Renew the domain')
  assert.match(h.team.sent[1][1], /\n\nRenew the domain\n\n/)
  await h.post('move', { id: two.id, status: 'done' })
  assert.deepEqual(h.team.state.bots.c.openParts, [])
  assert.deepEqual(h.team.state.bots.c.closedCards.map(closed => closed.card), [one.id, two.id])
})

test('without card threads the brief still reaches the Bot, in its own chat', async (t) => {
  const team = fakeTeam()
  const notes = { ...team.notes, startCard: async () => ({ error: 'Card threads are not available.' }) }
  const h = host(t, { notes })
  await h.tool({ action: 'open', title: 'Fix CI', assignee: 'Coder', brief: 'The lint job fails.' }, 'a')
  // The host's own team is the one that records sends.
  assert.deepEqual(team.sent.map(([sessionId]) => sessionId), ['c'])
  assert.match(team.sent[0][1], /The lint job fails\./)
})

test('the Main Bot passes on what the user said with board note; it reaches the card thread', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', title: 'Fix CI', assignee: 'Coder', brief: 'The lint job fails.' }, 'a')
  const [card] = h.cards()
  assert.equal(await h.tool({ action: 'note', id: card.id }, 'a'), 'note needs the text to pass on.')
  assert.equal(await h.tool({ action: 'note', id: card.id, text: 'x' }, 'c'), `${card.id} is yours; just do it.`)
  assert.equal(await h.tool({ action: 'note', id: card.id, text: 'x' }, 'b'), `${card.id} belongs to Coder.`)
  assert.match(await h.tool({ action: 'note', id: card.id, text: 'the user says skip the e2e job' }, 'a'), /^Passed on to Coder on c_\w+\./)
  assert.deepEqual(h.team.sent.at(-1), [`ct-${card.id}`, `Note on card ${card.id} "Fix CI" from Chief: the user says skip the e2e job`])
  assert.deepEqual(h.cards()[0].notes.map(note => [note.by, note.text]), [['a', 'the user says skip the e2e job']])
})

test('a Bot\'s ask, Review, done and cancel push a short line naming the card; the user\'s own moves do not', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', title: 'Fix login', key: 'LIFE-782', assignee: 'Writer', brief: 'Redirect loop after login.' }, 'a')
  const [card] = h.cards()
  await h.tool({ action: 'update', id: card.id, progress: 'found it' }, 'b')
  await h.tool({ action: 'ask', id: card.id, question: 'Ship today?', options: ['Yes', 'No'] }, 'b')
  await h.tool({ action: 'update', id: card.id, status: 'active' }, 'b')
  await h.tool({ action: 'update', id: card.id, status: 'review', progress: 'PR #12 is up' }, 'b')
  await h.post('move', { id: card.id, status: 'active' })
  await h.tool({ action: 'complete', id: card.id, result: 'Merged PR #12' }, 'b')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Other' }, 'c')
  await h.tool({ action: 'cancel', reason: 'not needed' }, 'c')
  await h.settle()
  assert.deepEqual(h.team.pushes.map(push => push.text), [
    'Writer · LIFE-782: asks "Fix login": Ship today? (Yes / No)',
    'Writer · LIFE-782: "Fix login" is ready for review: PR #12 is up',
    'Writer · LIFE-782: done "Fix login": Merged PR #12',
    `Coder · ${h.cards()[1].id}: stopped "Other": not needed`,
  ])
  assert.deepEqual(h.team.pushes[0].cardId, card.id)
  assert.deepEqual(h.team.pushes[0].botId, 'b')
})

test('a reply to a push about a card becomes a note on it, with the reply\'s own request id', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', title: 'Fix CI', assignee: 'Coder', brief: 'The lint job fails.' }, 'a')
  const [card] = h.cards()
  assert.equal(await h.team.cardNote({ cardId: 'c_nope', text: 'x', requestId: 'im:telegram:1' }), false)
  assert.equal(await h.team.cardNote({ cardId: card.id, text: 'use node 22', requestId: 'im:telegram:2' }), true)
  assert.deepEqual(h.team.sent.at(-1), [`ct-${card.id}`, `Note on card ${card.id} "Fix CI": use node 22`])
  assert.equal(h.team.requests.at(-1), 'im:telegram:2')
  assert.deepEqual(h.cards()[0].notes.map(note => note.text), ['use node 22'])
})

test('the board adds its rules to every Bot\'s prompt and its open cards to the Main Bot\'s digest', async (t) => {
  const h = host(t)
  const rules = id => h.sections.get('ds-bot-board-rules').text({ agent: { id } })
  assert.match(rules('a'), /^## The board\n- A task becomes a card: board open/)
  assert.match(rules('ga'), /do not also message_bot it/)
  assert.match(rules('a'), /never pass card work on with @name in a group or message_bot/)
  assert.match(rules('a'), /answer from its status and progress \(team snapshot, board show\) first/)
  assert.match(rules('b'), /open the card yourself \(board open\) with a brief/)
  assert.match(rules('b'), /arrives in a conversation of its own that starts with "\[Card …\]"/)
  assert.equal(rules('nobody'), '')
  const [part] = h.team.parts
  assert.equal(part('a'), 'Open cards: none.')
  await h.tool({ action: 'open', title: 'Fix CI', key: 'LIFE-9', assignee: 'Coder', brief: 'x' }, 'a')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Mine', status: 'todo' }, 'b')
  assert.match(part('a'), /^Open cards:\n- c_\w+ · LIFE-9 · Coder · In progress · Fix CI\n- c_\w+ · Writer · Todo · Mine$/)
  h.handle.dispose()
  assert.equal(h.team.parts.size, 0)
  assert.equal(h.sections.size, 0)
})

test('the watchdog tells the user once about a stuck card, a card left in Review and a card whose Bot is gone', async (t) => {
  let clock = 0
  const h = host(t, { now: () => clock, config: { watchMs: 0 } })
  const hour = 3_600_000
  await h.tool({ action: 'open', title: 'Stuck work', assignee: 'Writer', brief: 'x' }, 'a')
  await h.tool({ action: 'open', brief: 'Do it.', title: 'Needs a look', status: 'review' }, 'b')
  await h.tool({ action: 'open', title: 'Orphan', assignee: 'Coder', brief: 'x', status: 'todo' }, 'a')
  const [stuck, review, orphan] = h.cards()
  clock = 2 * hour
  assert.deepEqual(await h.handle.watchOnce(), [])
  delete h.team.state.bots.c
  clock = 4 * hour
  assert.deepEqual((await h.handle.watchOnce()).map(alert => alert.text), [
    `Writer · ${stuck.id}: "Stuck work" has not moved for 4h`,
    `Board · ${orphan.id}: "Orphan" has no assignee: its Bot is gone`,
  ])
  assert.deepEqual(await h.handle.watchOnce(), [])
  clock = 25 * hour
  assert.deepEqual((await h.handle.watchOnce()).map(alert => alert.text), [`Writer · ${review.id}: "Needs a look" has waited for you in Review for 25h`])
  // A card that moves and gets stuck again is told again.
  await h.tool({ action: 'update', id: stuck.id, progress: 'half way' }, 'b')
  clock = 29 * hour
  assert.deepEqual((await h.handle.watchOnce()).map(alert => alert.text), [`Writer · ${stuck.id}: "Stuck work" has not moved for 4h`])
  await h.settle()
  assert.equal(h.team.pushes.length, 4)
})

test('the herdr panes a shell command drives, and a pane read through the herdr CLI', async () => {
  assert.deepEqual(panesIn('H=~/.local/bin/herdr; $H agent prompt w1:p1J "go" --wait; $H pane read w1D:p7 | tail; $H agent get w1:p1J'), ['w1:p1J', 'w1D:p7'])
  assert.deepEqual(panesIn('for p in w1:p1C w1:p1F; do herdr pane close $p; done'), [])
  assert.deepEqual(panesIn('echo w1:p1J'), [])
  assert.equal(commandOf(JSON.stringify({ description: 'Send it', command: 'herdr agent prompt w1:p1T "x"' })), 'herdr agent prompt w1:p1T "x"')
  assert.equal(commandOf({ cmd: 'ls' }), 'ls')
  assert.equal(commandOf({ path: 'a' }), '')
  assert.equal(herdrBinary({ herdr: '/opt/herdr' }), '/opt/herdr')
  assert.equal(herdrBinary({}, '/nowhere'), 'herdr')

  const calls = []
  const answers = {
    read: { ok: true, stdout: '● Running tests\nok  pkg/a  3.1s\n\n', stderr: '' },
    get: { ok: true, stdout: JSON.stringify({ result: { pane: { agent_status: 'working', terminal_title_stripped: ' Integration tests ' } } }), stderr: '' },
  }
  const herdr = createHerdr({ binary: 'hd', exec: async (file, args) => { calls.push([file, ...args]); return answers[args[1]] } })
  assert.deepEqual(await herdr.read('w1:p1T'), { text: '● Running tests\nok  pkg/a  3.1s', status: 'working', title: 'Integration tests' })
  assert.deepEqual(calls, [['hd', 'pane', 'read', 'w1:p1T', '--source', 'recent-unwrapped', '--lines', '200'], ['hd', 'pane', 'get', 'w1:p1T']])
  // Never a flag, never a shell word.
  assert.deepEqual(await herdr.read('--help'), { error: 'Not a pane.' })
  assert.deepEqual(await herdr.read('w1:p1 ; rm'), { error: 'Not a pane.' })
  answers.read = { ok: false, stdout: JSON.stringify({ error: { code: 'pane_not_found', message: 'pane w1:p1T not found' } }), stderr: '' }
  assert.deepEqual(await herdr.read('w1:p1T'), { error: 'pane w1:p1T not found', gone: true })
  const missing = createHerdr({ exec: async () => ({ ok: false, stdout: '', stderr: '', missing: true }) })
  assert.deepEqual(await missing.read('w1:p1T'), { error: 'herdr is not installed here.' })
})

// The user asked where the card was opened; its work ran in the card's own thread.
test('a card a Bot opened reports how it ended back where it was opened', async (t) => {
  const h = host(t, { now: () => 5000 })
  const inThread = id => { h.team.owners[`ct-${id}`] = { botId: 'b' }; return `ct-${id}` }

  await h.tool({ action: 'open', title: 'Research desk', brief: 'Find out what it is.' }, 'b')
  const [own] = h.cards()
  await h.tool({ action: 'complete', id: own.id, result: 'A funding-arb tool', link: 'https://docs.example.com/desk' }, inThread(own.id))
  assert.deepEqual(h.team.delivered, [{
    toId: 'b', role: 'card', note: `Card ${own.id} ended in its own conversation`,
    text: `Card ${own.id} "Research desk" is done (Writer): A funding-arb tool (https://docs.example.com/desk)\nTell the user here in a line or two how it ended, with the card id; the whole work stays on the card.`,
  }])
  assert.deepEqual(h.cards()[0].log.at(-1), { at: 5000, by: 'b', status: 'done' })

  // Finished where it was opened, the Bot tells the user itself.
  h.team.delivered.length = 0
  await h.tool({ action: 'open', title: 'Quick one', brief: 'Small.' }, 'b')
  const quick = h.cards().find(card => card.title === 'Quick one')
  await h.tool({ action: 'complete', id: quick.id, result: 'Done' }, 'b')
  assert.deepEqual(h.team.delivered, [])

  // A card Chief opened in a group for Writer goes back to Chief in that group.
  h.team.state.rooms.r1.sessions = { a: 'ga', b: 'gb' }
  await h.tool({ action: 'open', title: 'Write docs', assignee: 'Writer', brief: 'Docs for 782.' }, 'ga')
  const docs = h.cards().find(card => card.title === 'Write docs')
  await h.tool({ action: 'cancel', id: docs.id, reason: 'already written' }, inThread(docs.id))
  assert.equal(h.team.delivered.length, 1)
  assert.deepEqual({ ...h.team.delivered[0], text: undefined }, { toId: 'a', sessionId: 'ga', role: 'room', roomId: 'r1', note: `card ${docs.id} ended`, text: undefined })
  assert.match(h.team.delivered[0].text, new RegExp(`^Card ${docs.id} "Write docs" was cancelled \\(Writer\\): already written\\n`))

  // A card the user opened has no Bot to report to.
  h.team.delivered.length = 0
  await h.post('add', { title: 'Mine', assignee: 'b', brief: 'Do it.' })
  const mine = h.cards().find(card => card.title === 'Mine')
  await h.tool({ action: 'complete', id: mine.id, result: 'ok' }, inThread(mine.id))
  assert.deepEqual(h.team.delivered, [])
})

test('a card keeps the herdr panes its Bot drives from the card thread, and the page reads only those', async (t) => {
  const reads = []
  const herdr = { read: async (pane) => { reads.push(pane); return { text: `tail of ${pane}`, status: 'working' } } }
  const h = host(t, { herdr, now: () => 5000 })
  await h.tool({ action: 'open', title: 'Speed up tests', assignee: 'Writer', brief: 'Under 3 minutes.' }, 'a')
  const [card] = h.cards()
  const thread = `ct-${card.id}`
  h.team.owners[thread] = { botId: 'b' }
  // The card's thread is looked up before the pane is saved.
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await h.settle() }
  const call = (sessionId, command) => h.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { callId: `k${reads.length}`, name: 'bash', arguments: JSON.stringify({ command }) } })

  call(thread, 'H=~/.local/bin/herdr; $H agent prompt w1:p1T "Find the slow tests" --wait --timeout 1800000')
  await flush()
  assert.deepEqual(h.cards()[0].panes, [{ id: 'w1:p1T', at: 5000 }])
  // The same pane again changes nothing; a command elsewhere is not the card's.
  call(thread, 'herdr agent get w1:p1T')
  call('b', 'herdr agent prompt w1:p9 "other work"')
  await flush()
  assert.deepEqual(h.cards()[0].panes.map(entry => entry.id), ['w1:p1T'])
  assert.match(await h.tool({ action: 'show' }, 'a'), /herdr pane: w1:p1T/)

  assert.deepEqual((await h.post('pane', { id: card.id, pane: 'w1:p1T' })).value, { pane: 'w1:p1T', at: 5000, text: 'tail of w1:p1T', status: 'working' })
  assert.deepEqual(await h.post('pane', { id: card.id, pane: 'w1:p9' }), { ok: false, error: { code: 'board/refused', message: 'That pane is not on the card.' } })
  assert.equal((await h.post('pane', { id: 'c_nope', pane: 'w1:p1T' })).ok, false)
  assert.deepEqual(reads, ['w1:p1T'])

  // From anywhere else, the Bot names the pane; the newest is last, four at most.
  assert.match(await h.tool({ action: 'update', id: card.id, pane: '-rf' }, 'b'), /^pane is a herdr pane id/)
  for (const pane of ['w1:p2', 'w1:p3', 'w1:p4', 'w1:p1T']) await h.tool({ action: 'update', id: card.id, pane }, 'b')
  assert.deepEqual(h.cards()[0].panes.map(entry => entry.id), ['w1:p2', 'w1:p3', 'w1:p4', 'w1:p1T'])
})
