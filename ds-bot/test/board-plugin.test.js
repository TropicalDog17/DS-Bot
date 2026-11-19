import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name } from '../src/board/entry.js'
import { ROUTE, boardFileOf, install } from '../src/board/plugin.js'
import { READ_ONLY, openBoardStore } from '../src/board/store.js'
import { ticketKey } from '../src/board/cards.js'
import { notesService, rosterService } from '../src/host/companions.js'
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
  const rt = {
    ctx: {},
    state,
    load: async () => {},
    botOf: id => (hasOwn(state.bots, id) ? state.bots[id] : undefined),
    roomOf: id => (hasOwn(state.rooms, id) ? state.rooms[id] : undefined),
    isMain: id => id === 'a',
    findBot: ref => (hasOwn(state.bots, ref) ? state.bots[ref] : Object.values(state.bots).find(bot => bot.name.toLowerCase() === ref.toLowerCase())),
    onSaved: () => () => {},
    sendUser: async input => { sent.push([input.sessionId, input.content[0].text]) },
  }
  // Own chats a, b, c; group Sessions ga, gb; a talk between Writer and Coder, xb.
  const owners = { a: { botId: 'a' }, b: { botId: 'b' }, c: { botId: 'c' }, ga: { botId: 'a', roomId: 'r1' }, gb: { botId: 'b', roomId: 'r1' }, xb: { botId: 'b' } }
  const identity = { ownerOfSession: id => (hasOwn(owners, id) ? owners[id] : undefined), subscribe: () => () => {} }
  return { state, sent, identity, roster: rosterService(rt), notes: notesService(rt) }
}

function host(t, { file, notes } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-board-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const team = fakeTeam()
  const registered = { tools: [], routes: [] }
  const tools = { register: (tool) => { registered.tools.push(tool); return () => { registered.tools.splice(registered.tools.indexOf(tool), 1) } } }
  const connection = { fetch: { register: (route) => { registered.routes.push(route); return () => { registered.routes.splice(registered.routes.indexOf(route), 1) } } } }
  const boardFile = file ?? join(dir, 'bot-board', 'board.json')
  const handle = install({}, { file: boardFile }, { ...team, ...(notes ? { notes } : {}), tools, connection, store: openBoardStore(boardFile) })
  t.after(() => handle.dispose())
  const tool = (args, sessionId = 'b') => registered.tools.find(entry => entry.name === 'board').execute(args, { agent: { id: sessionId } })
  const cards = () => Object.values(JSON.parse(readFileSync(boardFile, 'utf8')).cards)
  const post = async (endpoint, payload) => {
    const route = registered.routes.find(entry => entry.path === ROUTE)
    const response = await route.fetch(new Request('http://dsh/api/ds-bot-board', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { dir, team, handle, registered, tool, cards, post, boardFile }
}

test('the entry is a separate plugin that needs only public services', () => {
  assert.equal(name, 'ds-bot-board')
  assert.deepEqual(inject, ['botSessionIdentity', 'dsBotRoster', 'dsBotNotes', 'tools', 'connection'])
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
    ['b', `Note on board card ${card.id} "Đặt lịch khám răng": gọi trước 5h (Answer on the card: board reply, id ${card.id}.)`],
    ['r1', `@Writer Note on board card ${group.id} "Group work": add tests (Answer on the card: board reply, id ${group.id}.)`],
  ])
  assert.deepEqual(h.cards().find(entry => entry.id === mineId).notes.map(note => note.text), ['remember'])

  assert.equal((await h.post('cancel', { id: card.id, reason: 'not needed' })).value.cards[card.id].status, 'cancelled')
  assert.equal((await h.post('cancel', { id: card.id })).error.message, 'That card is already finished.')
  assert.equal((await h.post('move', { id: card.id, status: 'todo' })).error.message, 'That card is cancelled.')
  assert.equal((await h.post('move', { id: 'nope', status: 'todo' })).error.message, 'No such card.')
  assert.equal((await h.post('wat')).error.code, 'board/unknown')
})

test('a card holds a conversation: the user\'s note, the Bot\'s reply on the card, in order', async (t) => {
  const h = host(t)
  const added = await h.post('add', { title: 'Đặt lịch khám răng', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
  await h.post('note', { id, text: 'gọi trước 5h nhé' })
  assert.equal(await h.tool({ action: 'reply', id, text: '  Ok, mình gọi lúc 4h.\r\n\n\n\nXong sẽ báo.  ' }), `Replied on ${id}.\n- ${id} · Writer · Đặt lịch khám răng (yours)\n  latest note from Writer: Ok, mình gọi lúc 4h.\n\nXong sẽ báo.`)
  await h.post('note', { id, text: 'cảm ơn' })
  const thread = (await h.post('state')).value.cards[id].notes
  assert.deepEqual(thread.map(note => [note.by, note.text]), [
    ['user', 'gọi trước 5h nhé'],
    ['b', 'Ok, mình gọi lúc 4h.\n\nXong sẽ báo.'],
    ['user', 'cảm ơn'],
  ])
  assert.equal(thread.every(note => typeof note.at === 'number'), true)
  // Only a Bot that may change the card answers on it; a Main Bot may.
  assert.equal(await h.tool({ action: 'reply', id, text: 'me too' }, 'c'), `${id} belongs to Writer.`)
  assert.match(await h.tool({ action: 'reply', id, text: 'Chief here' }, 'a'), /^Replied on/)
  assert.equal(await h.tool({ action: 'reply', id, text: '   ' }), 'A reply needs text.')
  assert.equal(await h.tool({ action: 'reply', id: 'c_nope', text: 'x' }), 'No open card of yours. Name one with its id or ticket key.')
  // With no id, the reply goes on the Bot's newest open card.
  assert.match(await h.tool({ action: 'reply', text: 'still on it' }), new RegExp(`^Replied on ${id}\\.`))
  // A question that lands as the work completes still gets its answer on the card.
  await h.tool({ action: 'complete', id, result: 'Đã đặt lịch' })
  assert.match(await h.tool({ action: 'reply', id, text: 'Thứ 6, 4h chiều' }), /^Replied on/)
  assert.equal((await h.post('note', { id, text: 'x' })).error.message, 'That card is already finished.')
})

test('a card keeps the last 200 messages of its conversation', async (t) => {
  const h = host(t)
  const added = await h.post('add', { title: 'Long talk', assignee: 'b' })
  const id = Object.keys(added.value.cards)[0]
  for (let n = 1; n <= 205; n += 1) await h.tool({ action: 'reply', id, text: `m${n}` })
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
})

test('disposing the plugin takes back its tool and route', async (t) => {
  const h = host(t)
  assert.equal(h.registered.tools.length, 1)
  assert.equal(h.registered.routes.length, 1)
  h.handle.dispose()
  assert.equal(h.registered.tools.length, 0)
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
