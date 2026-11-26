import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install as installBoard } from '../src/board/plugin.ts'
import { install as installResume, RESUME_DELAY_MS } from '../src/host/resume.ts'
import { fakeContext } from './fake-ctx.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-card-routing-'))

const room = () => ({ id: 'ops', name: 'Ops', members: ['chief', 'writer'], sessions: { chief: 'group-chief', writer: 'group-writer' } })

async function boardFixture(t, { sendNote, beforeCreate } = {}) {
  const home = tempHome()
  const state = {
    version: 1, mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', createdAt: 1 },
      writer: { id: 'writer', name: 'Writer', createdAt: 2 },
    },
    rooms: { ops: room() },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const boardCtx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const prompts = []
  const deliveries = []
  const archived = []
  let created = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'workspace', path }),
      archiveSession: async id => { archived.push(id) },
    },
    sessionTitle: { rename: async () => {} },
    sessionController: {
      create: async () => { await beforeCreate?.(); return { sessionId: `thread-${++created}` } },
      resolveAgent: async id => ({ agent: { ...ctx.scopeAgent(id), session: { id, requestHeader: () => undefined } } }),
      prompt: async input => { prompts.push(input); await sendNote?.(input) },
    },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  const record = async input => { deliveries.push(input) }
  rt.dispatch = { ...rt.dispatch, sendNotice: record, sendReply: record, sendGroupTurn: record }
  const board = installBoard(boardCtx, { file: join(home, 'board.json'), adoptMs: -1, waitPollMs: -1, watchMs: -1 }, {
    ...rt.companions, identity: { ownerOfSession: rt.ownerOfSession }, tools: boardCtx.tools, connection: boardCtx.connection, now: () => 1000,
  })
  t.after(() => board.dispose())
  const add = async (title = 'Prepare release') => {
    const result = await board.handle('add', { title, assignee: 'writer', brief: 'Write the release notes.' })
    assert.equal(result.ok, true)
    return Object.values(result.value.cards).find(card => card.title === title).id
  }
  const openInGroup = async () => {
    const result = await board.tool.execute({ action: 'open', title: 'Group release', brief: 'Write the release notes.' }, { agent: { id: 'group-writer' } })
    assert.match(result, /^Opened /)
    return Object.values(board.store.read().cards)[0].id
  }
  const note = async (id, text = 'Add the date.') => {
    const result = await board.handle('note', { id, text })
    assert.equal(result.ok, true)
    return prompts.at(-1)
  }
  const settle = () => board.store.change(() => ({ error: 'settled' }))
  const reply = async input => {
    rt.botReplied({ botId: 'writer', since: 1001, ...input })
    await settle()
  }
  const trace = boardCtx.listeners.get('session/event')[0]
  return { rt, board, prompts, deliveries, archived, created: () => created, add, openInGroup, note, reply, settle, trace, card: id => board.store.read().cards[id] }
}

test('closed card never opens a fresh thread for a note or wake', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  const sessionId = h.prompts[0].sessionId
  const done = await h.board.handle('move', { id, status: 'done' })
  assert.equal(done.ok, true)
  assert.deepEqual(h.archived, [sessionId])
  const { notes } = h.rt.companions
  assert.deepEqual(await notes.deliver({ botId: 'writer', cardId: id, requestId: 'after-close', text: 'One last detail.' }),
    { where: 'chat', sessionId: 'writer', requestId: 'after-close' })
  assert.deepEqual(await notes.wake({ botId: 'writer', cardId: id, roomId: 'ops', pane: 'w1:p1', text: 'The check finished.' }), { where: 'group' })
  assert.equal(h.prompts.at(-1).content[0].text, 'One last detail.')
  assert.deepEqual(h.deliveries.at(-1), { toId: 'writer', sessionId: 'group-writer', role: 'room', roomId: 'ops', note: 'herdr pane w1:p1 · the wait you started is over', text: 'The check finished.' })
  const boardNote = await h.note(id, 'Remember this for next time.')
  assert.equal(boardNote.sessionId, 'writer')
  assert.match(boardNote.content[0].text, /Remember this for next time\./)
  assert.equal(h.card(id).status, 'done')
  assert.equal(h.card(id).awaiting, undefined)
  assert.equal(h.created(), 1)
  assert.equal(h.rt.cardSession('writer', id), undefined)
})

test('a closed card never opens a thread when it closes during session creation', { timeout: 5000 }, async (t) => {
  const creating = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const h = await boardFixture(t, { beforeCreate: () => { creating.resolve(); return resume.promise } })
  const openCardThread = h.rt.openCardThread
  h.rt.openCardThread = undefined
  const id = await h.add()
  h.rt.openCardThread = openCardThread
  const pending = h.note(id)
  await creating.promise
  try {
    assert.equal((await h.board.handle('move', { id, status: 'done' })).ok, true)
  } finally {
    resume.resolve()
  }
  assert.equal((await pending).sessionId, 'writer')
  assert.equal(h.rt.cardSession('writer', id), undefined)
  assert.deepEqual(h.archived, ['thread-1'])
  assert.equal(h.card(id).awaiting, undefined)
})

test('a closed card never opens a thread when its first brief was still starting', { timeout: 5000 }, async (t) => {
  const creating = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const h = await boardFixture(t, { beforeCreate: () => { creating.resolve(); return resume.promise } })
  const pending = h.add()
  await creating.promise
  const [id] = Object.keys(h.board.store.read().cards)
  try {
    assert.equal((await h.board.handle('move', { id, status: 'done' })).ok, true)
  } finally {
    resume.resolve()
  }
  assert.equal(await pending, id)
  assert.equal(h.rt.cardSession('writer', id), undefined)
  assert.deepEqual(h.archived, ['thread-1'])
  assert.equal(h.prompts.at(-1).sessionId, 'writer')
  assert.match(h.prompts.at(-1).content[0].text, /Write the release notes\./)
})

test('a closed card never opens again through standalone notes when its archival record is available', async (t) => {
  const h = await boardFixture(t)
  const { notes } = h.rt.companions
  const cardId = 'external-card'
  const started = await notes.startCard({ cardId, botId: 'writer', text: 'Write it.' })
  assert.equal(started.sessionId, 'thread-1')
  assert.deepEqual(await notes.closeCard({ cardId, botId: 'writer' }), { closed: true })
  const late = await notes.deliver({ cardId, botId: 'writer', text: 'One more detail.' })
  assert.equal(late.where, 'chat')
  assert.equal(late.sessionId, 'writer')
  assert.equal(h.created(), 1)
})

test('a reply for another card is ignored even if it carries the awaited request id', async (t) => {
  const h = await boardFixture(t)
  const first = await h.add('First card')
  const second = await h.add('Second card')
  const { sessionId, requestId } = await h.note(second)
  await h.reply({ sessionId, cardId: first, heard: [requestId], text: 'Wrong card.' })
  assert.deepEqual(h.card(first).notes ?? [], [])
  assert.deepEqual(h.card(second).notes.map(note => note.text), ['Add the date.'])
  assert.deepEqual(h.card(second).awaiting.requests, [requestId])
})

test('a turn finishing before delivery records the request still answers its note', async (t) => {
  let onPrompt
  const h = await boardFixture(t, { sendNote: input => onPrompt?.(input) })
  const id = await h.add()
  onPrompt = async ({ sessionId, requestId }) => {
    assert.equal(h.card(id).awaiting, undefined)
    await h.reply({ cardId: id, sessionId, heard: [requestId], text: 'I added the date.' })
  }
  await h.note(id)
  await h.settle()
  assert.deepEqual(h.card(id).notes.map(note => note.text), ['Add the date.', 'I added the date.'])
  assert.equal(h.card(id).awaiting, undefined)
})

test('a group card thread keeps its board rules without GROUP_RULES', async (t) => {
  const h = await boardFixture(t)
  const id = await h.openInGroup()
  const sessionId = h.rt.cardSession('writer', id)
  const groupRule = 'In this group, answer in a few lines.'
  assert.match(h.board.rulesFor('group-writer'), new RegExp(groupRule))
  assert.match(h.board.rulesFor(sessionId), /A card handed to you/)
  assert.ok(!h.board.rulesFor(sessionId).includes(groupRule))
})

test('a card opened in a group carries its roomId from board to session identity', async (t) => {
  const h = await boardFixture(t)
  const id = await h.openInGroup()
  const { sessionId } = h.prompts[0]
  assert.equal(h.card(id).roomId, 'ops')
  assert.equal(h.rt.cardSession('writer', id), sessionId)
  assert.deepEqual(h.rt.ownerOfSession(sessionId), { botId: 'writer', roomId: 'ops', cardId: id })
})

test('the board filters by card id when showing live activity', async (t) => {
  const h = await boardFixture(t)
  const first = await h.add('First card')
  const second = await h.add('Second card')
  const { sessionId } = await h.note(first)
  for (const [id, time, tool] of [[sessionId, 1100, 'first_card_tool'], [h.rt.cardSession('writer', second), 1200, 'second_card_tool'], ['writer', 1300, 'own_chat_tool']]) {
    h.trace({ id }, { type: 'turn/start', time })
    h.trace({ id }, { type: 'tool/call', data: { callId: id, name: tool } })
  }
  const { value } = await h.board.handle('state')
  assert.deepEqual(value.live[first].steps.map(step => step.tool), ['first_card_tool'])
  assert.deepEqual(value.live[second].steps.map(step => step.tool), ['second_card_tool'])
  h.trace({ id: h.rt.cardSession('writer', second) }, { type: 'turn/end', time: 1400 })
  assert.equal((await h.board.handle('state')).value.live[second], undefined)
})

test('busy counts card and group turns with an idle own chat', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  const { notes } = h.rt.companions
  assert.equal(await notes.busy({ botId: 'writer' }), false)
  for (const sessionId of [h.rt.cardSession('writer', id), 'group-writer']) {
    h.rt.live.set(sessionId, { turn: {} })
    assert.equal(await notes.busy({ botId: 'writer' }), true)
    h.rt.live.delete(sessionId)
    assert.equal(await notes.busy({ botId: 'writer' }), false)
  }
})

test('a card thread mirrors progress when it never heard the pending note', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  const { sessionId, requestId } = await h.note(id)
  await h.reply({ sessionId, cardId: id, text: 'The draft is ready.' })
  assert.deepEqual(h.card(id).notes.map(note => note.text), ['Add the date.', 'The draft is ready.'])
  assert.deepEqual(h.card(id).awaiting.requests, [requestId])
  assert.equal(h.card(id).unread, true)
  await h.reply({ sessionId, cardId: id, heard: [requestId], text: 'I added the date.' })
  assert.equal(h.card(id).awaiting, undefined)
  assert.equal(h.card(id).notes.at(-1).text, 'I added the date.')
})

test('a long answer reaches the card whole', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  const { sessionId } = await h.note(id)
  const text = `${'Đã dọn pane, đã lưu bằng chứng. '.repeat(200)}Hết.`
  await h.reply({ sessionId, cardId: id, text })
  assert.equal(h.card(id).notes.at(-1).text, text.trim())
})

function resumeFixture(t, notes, { group = room(), logs = {}, bots = {}, extras = {} } = {}) {
  const home = tempHome()
  writeFileSync(join(home, 'inflight.json'), JSON.stringify(notes))
  const ctx = fakeContext()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const deliveries = []
  const resolved = []
  const read = []
  const posts = []
  const warnings = []
  const settled = Promise.withResolvers()
  const groupOwners = new Map()
  for (const [botId, sessionId] of Object.entries(group.sessions)) groupOwners.set(sessionId, { botId, roomId: group.id })
  groupOwners.set('old-group-writer', { botId: 'writer', roomId: group.id })
  Object.assign(ctx, { sessionController: { inspect: async id => { read.push(id); return { events: logs[id] } } } })
  const rt = {
    ctx, home, groupOwners, chatOwners: new Map(), live: new Map(),
    load: async () => {}, readOnly: () => undefined,
    botOf: id => ({ chief: { id: 'chief', name: 'Chief' }, writer: { id: 'writer', name: 'Writer' }, ...bots })[id],
    roomOf: id => id === group.id ? group : undefined,
    isBotSession: id => ['chief', 'writer', 'group-chief', 'group-writer', 'thread-current'].includes(id),
    selfOf: id => id === 'old-group-writer' ? 'writer' : id,
    resolveAgent: async id => { resolved.push(id); return { status: 'idle' } },
    postToRoom: async (...args) => { posts.push(args) },
    dispatch: {
      attachOutbox() {},
      sendGroupTurn: async input => { deliveries.push({ ...input, role: 'room' }) },
      sendReply: async input => { deliveries.push(input) },
      sendNotice: async input => { deliveries.push(input) },
      resend: async input => { deliveries.push({ ...input, steer: false, resent: true }) },
    },
    warn: (...warning) => {
      warnings.push(warning)
      if (warning[0] === 'ds-bot: picking up interrupted work failed: %s') settled.reject(warning[1])
    },
    settleRoomBatches: () => settled.resolve(),
    ...extras,
  }
  let recover
  const timer = t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, RESUME_DELAY_MS)
    recover = callback
  })
  try {
    installResume(rt)
  } finally {
    timer.mock.restore()
  }
  const restart = async () => {
    recover()
    await settled.promise
    assert.deepEqual(warnings, [])
  }
  const saved = async () => {
    await ctx.dispose()
    return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8'))
  }
  return { ctx, restart, deliveries, resolved, read, posts, saved }
}

test('resume in a group prefers the current card thread for interrupted turns and stopped jobs', { timeout: 3000 }, async (t) => {
  const card = { botId: 'writer', roomId: 'ops', cardId: 'c_1' }
  const jobId = 'check'
  const turn = 'thread-old'
  const job = 'thread-old-job'
  const before = resumeFixture(t, { turns: { [turn]: { botId: 'writer', since: 1 } } }, {
    extras: {
      isBotSession: id => id === turn || id === job,
      selfOf: () => 'writer',
      chatOwners: new Map([[turn, 'writer']]),
      ownerOfSession: () => card,
    },
  })
  const [record] = before.ctx.listeners.get('session/event')
  record({ id: turn }, { type: 'turn/start', time: 1 })
  record({ id: job }, { type: 'job/registered', data: { jobId, startedAt: 2, kind: 'bash', label: 'Check build' } })
  const saved = await before.saved()
  assert.deepEqual(saved.turns[turn], { ...card, since: 1 })
  assert.deepEqual(saved.jobs[jobId], { ...card, sessionId: job, since: 2, kind: 'bash', label: 'Check build' })
  const h = resumeFixture(t, saved, {
    bots: { writer: { id: 'writer', name: 'Writer', openParts: [{ sessionId: 'thread-current', card: 'c_1' }] } },
    logs: { [job]: [{ type: 'job/settled', data: { jobId, cause: 'teardown' } }] },
  })
  await h.restart()
  assert.deepEqual(h.deliveries.map(({ sessionId, role, roomId }) => ({ sessionId, role, roomId })), [
    { sessionId: 'thread-current', role: 'resume', roomId: undefined },
    { sessionId: 'thread-current', role: 'resume', roomId: undefined },
  ])
  assert.deepEqual(h.posts, [])
  assert.match(h.deliveries[0].text, /last turn stopped/)
  assert.match(h.deliveries[1].text, /background job/)
})

test('a private group message stays in its group on resume', { timeout: 3000 }, async (t) => {
  const group = room()
  delete group.sessions.writer
  const message = { at: 1, args: { toId: 'writer', role: 'room', roomId: 'ops', exchangeId: 'private', text: 'Only this group should see it.' } }
  const h = resumeFixture(t, { queued: { 'retired-group-writer': [message] } }, { group })
  await h.restart()
  assert.deepEqual(h.deliveries, [])
  assert.deepEqual(h.resolved, [])
})

test('a recovered answer picks the group before an earlier own-chat part', { timeout: 3000 }, async (t) => {
  const exchangeId = 'exchange'
  const workId = 'work'
  const closed = []
  const held = []
  const h = resumeFixture(t, { turns: { writer: { botId: 'writer', since: 1, trigger: { exchangeId } } } }, {
    logs: {
      writer: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { source: { exchangeId } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The result.' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      'group-chief': [{ type: 'user/message', data: { source: { replyTo: workId } } }],
    },
    bots: { chief: { id: 'chief', openParts: [{ sessionId: 'chief-part' }] } },
    extras: {
      workOf: () => workId, ownsWork: () => true,
      workAsker: () => ({ senderSessionId: 'chief', senderPart: 'chief-part', senderRoomId: 'ops' }),
      waitsWork: () => true,
      holdWork: (...args) => { held.push(args) },
      closeWork: (...args) => { closed.push(args) },
      answerText: (_id, text) => text,
    },
  })
  for (const listener of h.ctx.listeners.get('session/event')) {
    listener({ id: 'writer' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  await h.restart()
  assert.deepEqual(h.read, ['writer', 'group-chief'])
  assert.deepEqual(closed, [[workId, 'Writer', 'The result.']])
  assert.deepEqual(held, [])
  assert.deepEqual(h.deliveries, [])
})

test('a note to a card steers its thread; a note to the Bot\'s own chat still queues', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  assert.equal(h.prompts.at(-1).mode, 'queue')
  const sent = await h.note(id)
  assert.deepEqual([sent.sessionId, sent.mode], [h.rt.cardSession('writer', id), 'steer'])
  await h.rt.companions.notes.deliver({ botId: 'writer', text: 'A word.' })
  assert.deepEqual([h.prompts.at(-1).sessionId, h.prompts.at(-1).mode], ['writer', 'queue'])
})

test('cardBusy tells a thread in a turn from a quiet one and from no thread', async (t) => {
  const h = await boardFixture(t)
  const id = await h.add()
  const { notes } = h.rt.companions
  assert.equal(notes.cardBusy({ botId: 'writer', cardId: id }), false)
  h.rt.live.set(h.rt.cardSession('writer', id), { turn: {} })
  assert.equal(notes.cardBusy({ botId: 'writer', cardId: id }), true)
  assert.equal(notes.cardBusy({ botId: 'writer', cardId: 'c_none' }), undefined)
  assert.deepEqual(await notes.tellCard({ botId: 'writer', cardId: 'c_none', text: 'x' }), { error: 'The card has no conversation.' })
})
