import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install } from '../src/host/board.js'
import { migrateRoomTasks, ticketKey } from '../src/host/board-data.js'
import { fakeContext } from './fake-ctx.js'

// The board is team data: the first tests drive the tool on a bare runtime, the last
// ones the Board page's endpoints and the migration of old group tasks through a
// whole runtime on a temporary home.

function fakeHost(given) {
  const state = given ?? {
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' }, c: { id: 'c', name: 'Coder' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', sessions: { a: 'ga', b: 'gb' } } },
    prefs: {},
  }
  // Own chats a, b, c; group Sessions ga, gb; a talk between Writer and Coder, xb.
  const members = { a: 'a', b: 'b', c: 'c', ga: 'a', gb: 'b', xb: 'b' }
  const calls = { save: 0 }
  const rt = {
    state,
    teamTools: [],
    async load() {},
    async save() { calls.save += 1 },
    botOf: id => state.bots[id],
    findBot: ref => state.bots[ref] ?? Object.values(state.bots).find(bot => bot.name.toLowerCase() === String(ref).toLowerCase()),
    roomOf: id => state.rooms[id],
    selfOf: id => members[id],
    isMain: id => id === 'a',
    isAdminOf: (room, id) => room.admin === id,
    groupOwners: new Map([['ga', { botId: 'a', roomId: 'r1' }], ['gb', { botId: 'b', roomId: 'r1' }]]),
  }
  install(rt)
  const tool = (args, sessionId = 'b') => rt.teamTools.find(entry => entry.name === 'board').execute(args, { agent: { id: sessionId } })
  const cards = () => Object.values(state.board?.cards ?? {})
  return { state, rt, tool, calls, cards }
}

const seed = extra => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {}, ...extra } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, extra) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(extra)))
  const ctx = fakeContext()
  const prompts = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId } } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const tool = (args, sessionId) => rt.teamTools.find(entry => entry.name === 'board').execute(args, { agent: { id: sessionId } })
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { home, ctx, rt, call, tool, prompts, saved }
}

test('board opens a card from a Bot\'s own chat and moves it through every column to done', async () => {
  const host = fakeHost()
  assert.match(await host.tool({ action: 'open', title: '  Fix   login ', key: 'life-782', url: 'https://jira.example.com/browse/LIFE-782' }),
    /^Opened c_[0-9a-f]{8} · LIFE-782: Fix login \(In progress, Writer\)\./)
  const [card] = host.cards()
  assert.deepEqual([card.assignee, card.openedBy, card.status, card.key, card.url, card.roomId], ['b', 'b', 'active', 'LIFE-782', 'https://jira.example.com/browse/LIFE-782', undefined])
  assert.equal(host.calls.save, 1)

  for (const status of ['todo', 'review', 'blocked', 'active']) {
    await host.tool({ action: 'update', status })
    assert.equal(host.cards()[0].status, status)
  }
  assert.match(await host.tool({ action: 'update', id: 'LIFE-782', progress: 'PR  open', link: 'https://github.com/o/r/pull/7' }), /progress: PR open/)
  assert.deepEqual(host.cards()[0].links.map(link => link.url), ['https://github.com/o/r/pull/7'])
  // The same link twice is kept once.
  await host.tool({ action: 'update', link: 'https://github.com/o/r/pull/7' })
  assert.equal(host.cards()[0].links.length, 1)

  assert.equal(await host.tool({ action: 'complete' }), 'A finished card needs a one-line result.')
  assert.match(await host.tool({ action: 'complete', result: 'Merged' }), /^Finished c_.* · LIFE-782: "Merged"/)
  assert.deepEqual([host.cards()[0].status, host.cards()[0].result, typeof host.cards()[0].doneAt], ['done', 'Merged', 'number'])
  assert.match(await host.tool({ action: 'show' }), /Done \(latest 1 of 1\):\n- c_.* · LIFE-782 · Writer · Fix login/)
})

test('board works from a group and from a talk between Bots; a group card remembers its group', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', title: 'Group work' }, 'gb')
  await host.tool({ action: 'open', title: 'Pair work' }, 'xb')
  const [group, pair] = host.cards()
  assert.equal(group.roomId, 'r1')
  assert.equal(pair.roomId, undefined)
  const shown = await host.tool({ action: 'show' }, 'c')
  assert.match(shown, /In progress:\n- c_\w+ · Writer · Group work\n- c_\w+ · Writer · Pair work/)
  assert.doesNotMatch(shown, /\(yours\)/)
})

test('a Bot opens a card for another Bot or for the user, and the assignee moves it', async () => {
  const host = fakeHost()
  assert.match(await host.tool({ action: 'open', title: 'Write tests', assignee: 'Coder', status: 'todo' }, 'a'), /\(Todo, Coder\)/)
  assert.match(await host.tool({ action: 'open', title: 'Approve the PR', assignee: 'user' }, 'a'), /the user\)/)
  const [forCoder] = host.cards()
  assert.match(await host.tool({ action: 'update', status: 'active' }, 'c'), /In progress/)
  assert.equal(host.cards()[0].status, 'active')
  // Writer neither holds nor opened it.
  assert.equal(await host.tool({ action: 'update', id: forCoder.id, progress: 'x' }, 'b'), `${forCoder.id} belongs to Coder.`)
  assert.equal(await host.tool({ action: 'open', title: 'x', assignee: 'Nobody' }, 'a'), 'No Bot named Nobody. Use an exact name from list_bots, or "user".')
})

test('who may change and cancel a card', async () => {
  const host = fakeHost()
  await host.tool({ action: 'open', title: 'Coder job' }, 'c')
  const [card] = host.cards()
  assert.equal(await host.tool({ action: 'complete', id: card.id, result: 'x' }, 'b'), `${card.id} belongs to Coder.`)
  assert.equal(await host.tool({ action: 'cancel', id: card.id }, 'b'), `${card.id} belongs to Coder; only its assignee, the Bot that opened it or a Main Bot cancels it.`)
  // A Main Bot may.
  assert.match(await host.tool({ action: 'cancel', id: card.id, reason: 'scope cut' }, 'a'), /^Cancelled/)
  assert.deepEqual([host.cards()[0].status, host.cards()[0].reason], ['cancelled', 'scope cut'])
})

test('board validates its input strictly', async () => {
  const host = fakeHost()
  assert.equal(await host.tool({ action: 'open', title: 'x' }, 'nobody'), 'Only Bots on the team can use board.')
  // The tool schema refuses an unknown action, status or a field of the wrong type before board runs.
  await assert.rejects(host.tool({ action: 'move' }), /"action" must be one of/)
  await assert.rejects(host.tool({ action: 'open', title: 'x', status: 'done' }), /"status" must be one of/)
  await assert.rejects(host.tool({ action: 'open', title: 7 }), /INVALID_ARGS|title/)
  assert.equal(await host.tool({ action: 'open', title: ' ' }), 'A card needs a one-line title.')
  assert.equal(await host.tool({ action: 'open', title: 'x', key: 'not a key' }), 'key is a ticket key like LIFE-782.')
  assert.equal(await host.tool({ action: 'open', title: 'x', url: 'javascript:alert(1)' }), 'url must be an http(s) address.')
  await host.tool({ action: 'open', title: 'First', key: 'LIFE-1' })
  const first = host.cards()[0]
  assert.equal(await host.tool({ action: 'open', title: 'Again', key: 'LIFE-1' }), `LIFE-1 is already on the board as ${first.id}; update that card.`)
  assert.equal(await host.tool({ action: 'update', link: 'ftp://x' }), 'link must be an http(s) address.')
  assert.equal(host.cards().length, 1)
  assert.equal(ticketKey('ab-12'), 'AB-12')
  assert.equal(ticketKey('12-AB'), undefined)
})

test('a finished card is immutable through every Bot action', async () => {
  for (const terminal of ['complete', 'cancel']) {
    const host = fakeHost()
    await host.tool({ action: 'open', title: 'Deliver' })
    const id = host.cards()[0].id
    await host.tool({ action: terminal, id, result: 'delivered', reason: 'stopped' })
    const saved = JSON.stringify(host.cards())
    for (const action of ['update', 'complete', 'cancel']) {
      assert.equal(await host.tool({ action, id, status: 'active', progress: 'late', result: 'changed' }), `${id} is already finished.`)
      assert.equal(JSON.stringify(host.cards()), saved)
    }
  }
})

test('the user adds, moves, notes and cancels cards; notes go to the group or the Bot\'s own chat', async () => {
  const host = fakeHost()
  const added = host.rt.boardAdd({ title: 'Đặt lịch khám răng', assignee: 'b', key: '', url: '' })
  assert.deepEqual([added.card.title, added.card.assignee, added.card.openedBy, added.card.status], ['Đặt lịch khám răng', 'b', 'user', 'todo'])
  assert.equal(host.rt.boardAdd({ title: ' ' }).error, 'Write a title first.')
  assert.equal(host.rt.boardAdd({ title: 'x', assignee: 'zz' }).error, 'No such Bot.')
  assert.equal(host.rt.boardAdd({ title: 'Mine' }).card.assignee, 'user')

  const id = added.card.id
  assert.equal(host.rt.boardMove(id, 'done').card.status, 'done')
  assert.equal(typeof host.cards().find(card => card.id === id).doneAt, 'number')
  assert.equal(host.rt.boardMove(id, 'blocked').card.doneAt, undefined)
  assert.equal(host.rt.boardMove(id, 'nowhere').error, 'Unknown column.')

  const own = host.rt.boardNote(id, '  gọi trước 5h ')
  assert.deepEqual(own.deliver, { sessionId: 'b', text: `Note on board card ${id} "Đặt lịch khám răng": gọi trước 5h` })
  await host.tool({ action: 'open', title: 'Group work' }, 'gb')
  const group = host.cards().find(card => card.roomId === 'r1')
  assert.deepEqual(host.rt.boardNote(group.id, 'add tests').deliver, { sessionId: 'r1', text: '@Writer add tests' })
  const mine = host.cards().find(card => card.title === 'Mine')
  assert.equal(host.rt.boardNote(mine.id, 'remember').deliver, undefined)
  assert.equal(host.rt.boardNote(id, ' ').error, 'Write a note first.')

  assert.equal(host.rt.boardCancel(id, 'not needed').card.status, 'cancelled')
  assert.equal(host.rt.boardCancel(id).error, 'That card is already finished.')
  assert.equal(host.rt.boardNote(id, 'late').error, 'That card is already finished.')
  assert.equal(host.rt.boardMove(id, 'todo').error, 'That card is cancelled.')
  assert.equal(host.rt.boardMove('nope', 'todo').error, 'No such card.')
})

test('old group tasks move onto the board once, keeping their group, notes and history', () => {
  const state = {
    rooms: {
      r1: {
        id: 'r1',
        tasks: {
          t_1: { id: 't_1', botId: 'b', goal: 'Write the draft', status: 'review', startedAt: 10, updatedAt: 20, progress: 'ready', notes: [{ at: 15, by: 'user', text: 'shorter' }] },
          t_2: { id: 't_2', botId: 'a', goal: 'Check', status: 'done', startedAt: 11, updatedAt: 30, progress: '', result: 'ok' },
        },
      },
      r2: { id: 'r2' },
    },
  }
  assert.equal(migrateRoomTasks(state), true)
  assert.equal(state.rooms.r1.tasks, undefined)
  assert.deepEqual(state.board.cards.t_1, {
    id: 't_1', title: 'Write the draft', assignee: 'b', openedBy: 'b', status: 'review', progress: 'ready', links: [],
    notes: [{ at: 15, by: 'user', text: 'shorter' }], roomId: 'r1', createdAt: 10, updatedAt: 20,
  })
  assert.deepEqual([state.board.cards.t_2.status, state.board.cards.t_2.result, state.board.cards.t_2.doneAt], ['done', 'ok', 30])
  assert.equal(migrateRoomTasks(state), false)
})

test('a saved team with group tasks loads them onto the board, and the Board page endpoints save and deliver', async (t) => {
  const host = await start(t, { tasks: { t_old: { id: 't_old', botId: 'b', goal: 'Old group task', status: 'active', startedAt: 1, updatedAt: 1, progress: '' } } })
  await host.rt.load()
  assert.equal(host.saved().rooms.r1.tasks, undefined)
  assert.equal(host.saved().board.cards.t_old.roomId, 'r1')

  const state = await host.call('state', {})
  assert.equal(state.value.board.cards.t_old.title, 'Old group task')

  const added = await host.call('board-add', { title: 'Viết báo cáo tuần', key: 'LIFE-9', assignee: 'b' })
  assert.equal(added.ok, true)
  const card = Object.values(host.saved().board.cards).find(entry => entry.key === 'LIFE-9')
  assert.equal(card.title, 'Viết báo cáo tuần')
  assert.equal((await host.call('board-add', { title: 'Dup', key: 'LIFE-9' })).error.message, 'LIFE-9 is already on the board as ' + card.id + '; update that card.')

  assert.equal((await host.call('board-move', { id: card.id, status: 'blocked' })).ok, true)
  assert.equal(host.saved().board.cards[card.id].status, 'blocked')

  // A note on a card from the Bot's own work goes to its own chat.
  assert.equal((await host.call('board-note', { id: card.id, text: 'Thêm số liệu' })).ok, true)
  assert.equal(host.prompts.at(-1).sessionId, 'b')
  assert.equal(host.prompts.at(-1).content[0].text, `Note on board card ${card.id} · LIFE-9 "Viết báo cáo tuần": Thêm số liệu`)
  // A note on the migrated group task goes to its group, as the user's @ message.
  assert.equal((await host.call('board-note', { id: 't_old', text: 'Also add tests' })).ok, true)
  assert.equal(host.prompts.at(-1).sessionId, 'r1')
  assert.equal(host.prompts.at(-1).content[0].text, '@Writer Also add tests')
  assert.equal(host.saved().board.cards.t_old.notes.at(-1).text, 'Also add tests')

  assert.equal((await host.call('board-cancel', { id: card.id })).ok, true)
  assert.equal(host.saved().board.cards[card.id].status, 'cancelled')
  const refused = await host.call('board-note', { id: card.id, text: 'late' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.message, 'That card is already finished.')
  assert.equal(host.prompts.length, 2)

  // The tool, from the Bot's own chat, writes the same board.
  assert.match(await host.tool({ action: 'open', title: 'From my chat' }, 'b'), /^Opened/)
  assert.ok(Object.values(host.saved().board.cards).some(entry => entry.title === 'From my chat' && entry.assignee === 'b'))
})

test('finished cards stay on the board beyond two hundred deliveries', async () => {
  const host = fakeHost()
  for (let i = 0; i < 205; i++) {
    await host.tool({ action: 'open', title: `Deliver ${i}` })
    await host.tool({ action: 'complete', result: `Result ${i}` })
  }
  assert.equal(host.cards().length, 205)
  assert.match(await host.tool({ action: 'show' }), /Done \(latest 5 of 205\)/)
})
