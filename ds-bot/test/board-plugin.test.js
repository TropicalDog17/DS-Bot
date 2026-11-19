import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name } from '../src/board/entry.js'
import { ROUTE, boardFileOf, install } from '../src/board/plugin.js'
import { READ_ONLY, openBoardStore } from '../src/board/store.js'
import { ACTIONS, ticketKey } from '../src/board/cards.js'
import { bridgeService, notesService, rosterService } from '../src/host/companions.js'
import { homeLock } from '../src/host/home-lock.js'

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
  }
  // Own chats a, b, c; group Sessions ga, gb; a talk between Writer and Coder, xb.
  const owners = { a: { botId: 'a' }, b: { botId: 'b' }, c: { botId: 'c' }, ga: { botId: 'a', roomId: 'r1' }, gb: { botId: 'b', roomId: 'r1' }, xb: { botId: 'b' } }
  const identity = { ownerOfSession: id => (hasOwn(owners, id) ? owners[id] : undefined), subscribe: () => () => {} }
  const notes = notesService(rt)
  const bridge = bridgeService(rt)
  // What turns.js does when a Bot's turn ends with an answer the user reads.
  const reply = heard => rt.botReplied(heard)
  return { state, sent, requests, identity, roster: rosterService(rt), notes, bridge, bridged: () => rt.bridgedTools(), reply }
}

function host(t, { file, notes, now = Date.now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-board-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const team = fakeTeam()
  const registered = { tools: [], routes: [] }
  const tools = { register: (tool) => { registered.tools.push(tool); return () => { registered.tools.splice(registered.tools.indexOf(tool), 1) } } }
  const connection = { fetch: { register: (route) => { registered.routes.push(route); return () => { registered.routes.splice(registered.routes.indexOf(route), 1) } } } }
  const boardFile = file ?? join(dir, 'bot-board', 'board.json')
  const handle = install({}, { file: boardFile }, { ...team, ...(notes ? { notes } : {}), tools, connection, store: openBoardStore(boardFile), now })
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
  return { dir, team, handle, registered, tool, cards, post, boardFile, settle }
}

test('the entry is a separate plugin that needs only public services', () => {
  assert.equal(name, 'ds-bot-board')
  assert.deepEqual(inject, ['botSessionIdentity', 'dsBotRoster', 'dsBotNotes', 'dsBotBridge', 'tools', 'connection'])
  let effects = 0
  apply({ effect: () => { effects += 1 } }, {})
  assert.equal(effects, 1)
  assert.equal(boardFileOf({}, { DSH_HOME: '/tmp/x-home' }), '/tmp/x-home/bot-board/board.json')
  assert.equal(boardFileOf({ file: '/data/b.json' }, {}), '/data/b.json')
})

test('board opens a card from a Bot\'s own chat and moves it through every column to done', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', title: '  Fix   login ', key: 'life-782', url: 'https://jira.example.com/browse/LIFE-782' }),
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

test('a group card remembers its group; a talk between Bots does not', async (t) => {
  const h = host(t)
  await h.tool({ action: 'open', title: 'Group work' }, 'gb')
  await h.tool({ action: 'open', title: 'Pair work' }, 'xb')
  const [group, pair] = h.cards()
  assert.equal(group.roomId, 'r1')
  assert.equal(pair.roomId, undefined)
  const shown = await h.tool({ action: 'show' }, 'c')
  assert.match(shown, /In progress:\n- c_\w+ · Writer · Group work\n- c_\w+ · Writer · Pair work/)
  assert.doesNotMatch(shown, /\(yours\)/)
})

test('who may change and cancel a card: assignee, opener, a Main Bot, or the group admin for cancel', async (t) => {
  const h = host(t)
  assert.match(await h.tool({ action: 'open', title: 'Write tests', assignee: 'Coder', status: 'todo' }, 'a'), /\(Todo, Coder\)/)
  assert.match(await h.tool({ action: 'open', title: 'Approve the PR', assignee: 'user' }, 'a'), /the user\)/)
  const [forCoder] = h.cards()
  assert.match(await h.tool({ action: 'update', status: 'active' }, 'c'), /In progress/)
  assert.equal(await h.tool({ action: 'update', id: forCoder.id, progress: 'x' }, 'b'), `${forCoder.id} belongs to Coder.`)
  assert.equal(await h.tool({ action: 'cancel', id: forCoder.id }, 'b'), `${forCoder.id} belongs to Coder; only its assignee, the Bot that opened it or a Main Bot cancels it.`)
  assert.match(await h.tool({ action: 'cancel', id: forCoder.id, reason: 'scope cut' }, 'a'), /^Cancelled/)
  assert.equal(await h.tool({ action: 'open', title: 'x', assignee: 'Nobody' }, 'a'), 'No Bot named Nobody. Use an exact name from list_bots, or "user".')
})

test('board validates its input strictly and refuses Sessions that are not Bots', async (t) => {
  const h = host(t)
  assert.equal(await h.tool({ action: 'open', title: 'x' }, 'nobody'), 'Only Bots on the team can use board.')
  await assert.rejects(h.tool({ action: 'move' }), /"action" must be one of/)
  await assert.rejects(h.tool({ action: 'open', title: 'x', status: 'done' }), /"status" must be one of/)
  assert.equal(await h.tool({ action: 'open', title: ' ' }), 'A card needs a one-line title.')
  assert.equal(await h.tool({ action: 'open', title: 'x', key: 'not a key' }), 'key is a ticket key like LIFE-782.')
  assert.equal(await h.tool({ action: 'open', title: 'x', url: 'javascript:alert(1)' }), 'url must be an http(s) address.')
  await h.tool({ action: 'open', title: 'First', key: 'LIFE-1' })
  const first = h.cards()[0]
  assert.equal(await h.tool({ action: 'open', title: 'Again', key: 'LIFE-1' }), `LIFE-1 is already on the board as ${first.id}; update that card.`)
  assert.equal(h.cards().length, 1)
  for (const terminal of ['complete', 'cancel']) {
    const id = (await h.tool({ action: 'open', title: `Deliver ${terminal}` })).match(/c_[0-9a-f]{8}/)[0]
    await h.tool({ action: terminal, id, result: 'delivered', reason: 'stopped' })
    for (const action of ['update', 'complete', 'cancel']) assert.equal(await h.tool({ action, id, status: 'active', result: 'changed' }), `${id} is already finished.`)
  }
  assert.equal(ticketKey('ab-12'), 'AB-12')
  assert.equal(ticketKey('12-AB'), undefined)
})

test('the Board page adds, moves, notes and cancels; notes reach the Bot through dsBotNotes', async (t) => {
  const h = host(t)
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
  await h.tool({ action: 'open', title: 'Group work' }, 'gb')
  const group = h.cards().find(entry => entry.roomId === 'r1')
  await h.post('note', { id: group.id, text: 'add tests' })
  const mine = (await h.post('add', { title: 'Mine' })).value
  const mineId = Object.values(mine.cards).find(entry => entry.title === 'Mine').id
  await h.post('note', { id: mineId, text: 'remember' })
  assert.deepEqual(h.team.sent, [
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
  const h = host(t, { now: () => clock })
  const added = await h.post('add', { title: 'Đặt lịch khám răng', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
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
  const h = host(t)
  const open = async title => Object.values((await h.post('add', { title, assignee: 'b' })).value.cards).find(card => card.title === title).id
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
  const h = host(t, { now: () => clock })
  const added = await h.post('add', { title: 'Fix login', key: 'LIFE-782', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
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
  const h = host(t, { now: () => clock })
  await h.tool({ action: 'open', title: 'Group work' }, 'gb')
  const group = h.cards()[0].id
  await h.post('note', { id: group, text: 'add tests' })
  clock = 1500
  await h.post('note', { id: group, text: 'and docs' })
  // The group passes the note on as its own message: no request id to wait on.
  assert.deepEqual(h.cards()[0].awaiting, { botId: 'b', roomId: 'r1', since: 1000 })
  h.team.reply({ botId: 'b', text: 'in my own chat', since: 1200 })
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'older work', since: 900 })
  h.team.reply({ botId: 'b', roomId: 'r1', text: 'On it: tests first.', since: 1200 })
  await h.settle()
  assert.deepEqual(h.cards()[0].notes.map(note => note.text), ['add tests', 'and docs', 'On it: tests first.'])

  // Two group cards wait on Writer there: the one asked first gets the first answer.
  clock = 5000
  await h.tool({ action: 'open', title: 'One' }, 'gb')
  await h.tool({ action: 'open', title: 'Two' }, 'gb')
  const idOf = title => h.cards().find(card => card.title === title).id
  const [first, second] = [idOf('One'), idOf('Two')]
  await h.post('note', { id: second, text: 'two?' })
  clock = 4000
  await h.post('note', { id: first, text: 'one?' })
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
