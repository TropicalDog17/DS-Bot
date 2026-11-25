import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { ROOM_IDLE_RELAY_LIMIT } from '../src/host/constants.ts'
import { isIdleRelayText, lineText } from '../src/host/groups.ts'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

let rt
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-rounds-')) } = {}) {
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // Session events arrive one at a time in DSH; awaiting each listener keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = (text, rpcId) => ({ type: 'user/message', data: { source: { kind: 'user', ...(rpcId ? { rpcId } : {}) }, content: [{ type: 'text', text }] } })
  const compose = (sessionId, content, mode = 'queue') => ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  })
  const relay = (roomId, callId, signal = new AbortController().signal) => rt.teamTools.find(d => d.name === 'group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
    .then(async value => JSON.stringify(await afterRound(rt, roomId, value)))
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent, ctx, home, rt }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))

test('a new group Session waits for capabilities before its first member prompt', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))

  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  rt.ensureCapabilities = async sessionId => {
    markStarted(sessionId)
    await gate
  }
  const running = relay(room.id, 'first-turn')
  const sessionId = await started
  assert.equal(sent.length, 0)
  release()

  const first = await turnFor(sent)
  assert.equal(first.sessionId, sessionId)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief ready.', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer ready.', 2)
  await running
})

async function team(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0
  return room
}

test('a message the composer queues mid-round joins the round and leaves the Session\'s queue', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Tell me a long story', 'opening'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the first turn')

  await compose(room.id, '@Writer ping mid-round')

  await answer(first.sessionId, first.message.source.exchangeId, 'Once upon a time...', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the Writer gets the next turn')
  assert.match(second.message.content[0].text, /@Writer ping mid-round/)
  assert.match(second.message.content[0].text, /the user mentioned you/)
  assert.deepEqual(first.message.source.requests, ['opening'])
  assert.equal(second.message.source.requests.length, 2)
  assert.equal(second.message.source.requests[0], 'opening')

  await answer(second.sessionId, second.message.source.exchangeId, 'Ping back!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Writer'])
  assert.deepEqual(inboxOf(room.id).nextTurn, [])
})

test('a plain message steered mid-round is answered by everyone, admin first, inside the round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'steer this way', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.equal(second.sessionId, first.sessionId)
  assert.match(second.message.content[0].text, /steer this way/)
  assert.match(second.message.content[0].text, /new message from the user/)
  await answer(second.sessionId, second.message.source.exchangeId, 'one again', 2)
  const third = await turnFor(sent, first, second)
  assert.match(third.message.content[0].text, /steer this way/)
  await answer(third.sessionId, third.message.source.exchangeId, 'two', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Chief', 'Writer'])
  assert.deepEqual(inboxOf(room.id).nextStep, [])
})

test('a message sent during the last speaker\'s turn is still answered in the round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Kick it off'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief first', 1)
  const second = await turnFor(sent, first)

  assert.equal((await call('send', { sessionId: room.id, text: 'one more thing' })).ok, true)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer done', 2)

  const third = await turnFor(sent, first, second)
  assert.ok(third, 'the admin answers the late message')
  assert.match(third.message.content[0].text, /one more thing/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Back again', 3)
  const fourth = await turnFor(sent, first, second, third)
  assert.ok(fourth, 'and so does the Writer')
  await answer(fourth.sessionId, fourth.message.source.exchangeId, 'Me too', 4)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief', 'Writer'])
})

test('in admin mode a plain mid-round message goes to the admin', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer your call', 1)
  const second = await turnFor(sent, first)
  assert.notEqual(second.sessionId, first.sessionId)
  await compose(room.id, 'what do you think?')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here', 2)
  const third = await turnFor(sent, first, second)
  assert.equal(third.sessionId, first.sessionId, 'the admin answers the user')
  assert.match(third.message.content[0].text, /what do you think\?/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Admin here', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief'])
})

test('a message with an image or a chat reference waits for its own round, and so does what follows it', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, [{ type: 'text', text: 'see this' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  await compose(room.id, 'after the image')
  await compose(room.id, 'about @[Notes](dsh-session:abc123)', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.doesNotMatch(second.message.content[0].text, /see this|after the image|about @/)
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
  assert.equal(inboxOf(room.id).nextTurn.length, 2)
  assert.equal(inboxOf(room.id).nextStep.length, 1)
})

test('the greeting round leaves a waiting message for its own round', async (t) => {
  const { call, emit, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'kickoff' }, content: [{ type: 'text', text: '[Group chat created]' }] } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'hello there')
  await answer(first.sessionId, first.message.source.exchangeId, 'Welcome!', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a stopped round leaves a waiting message for the next round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const controller = new AbortController()
  const running = relay(room.id, 'relay', controller.signal)
  await turnFor(sent)
  await compose(room.id, 'still there?')
  rt.stopRoomRound(room.id)
  const result = JSON.parse(await running)
  assert.equal(result.replies.some(reply => reply.kind === 'user'), false)
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a message sent between rounds still opens a full round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Hello group'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first)
  await answer(first.sessionId, first.message.source.exchangeId, 'Hi!', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Hello!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

test('a member whose group Session cannot be opened shows a failure, and its next turn there starts a new Session', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId

  await emit(room.id, userMessage('Report in'))
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  await running
  const broken = rt.roomOf(room.id).sessions[chief]
  assert.equal(first.sessionId, broken)

  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async sessionId => (sessionId === broken
    ? { error: { code: 'gateway/internal', message: `resume failed for session "${sessionId}": SessionQueryError: stored session "${sessionId}" is corrupt: released v2 row has seq gap (expected 20, got 16)` } }
    : resolve(sessionId))
  t.mock.method(rt, 'warn', () => {})
  sent.length = 0
  await emit(room.id, userMessage('Again'))
  running = relay(room.id, 'r2')
  const writerTurn = await turnFor(sent)
  assert.equal(writerTurn.sessionId, second.sessionId)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Still here.', 3)
  const result = JSON.parse(await running)
  const failed = result.replies.filter(reply => reply.kind === 'failed')
  assert.deepEqual(failed.map(reply => [reply.name, reply.code]), [['Chief', 'SESSION_RESET']])
  assert.equal(result.passed.includes('Chief'), false)
  assert.equal(rt.roomOf(room.id).sessions[chief], undefined)

  sent.length = 0
  await emit(room.id, userMessage('Once more'))
  running = relay(room.id, 'r3')
  const fresh = await turnFor(sent)
  assert.notEqual(fresh.sessionId, broken)
  assert.equal(rt.roomOf(room.id).sessions[chief], fresh.sessionId)
  await answer(fresh.sessionId, fresh.message.source.exchangeId, 'Back.', 1)
  const again = await turnFor(sent, fresh)
  await answer(again.sessionId, again.message.source.exchangeId, 'Here.', 4)
  assert.deepEqual(JSON.parse(await running).replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

test('a delivery that fails for another reason shows a failure and keeps the Session', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId
  await emit(room.id, userMessage('Report in'))
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  await running

  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async sessionId => (sessionId === first.sessionId
    ? { error: { code: 'session/writer-held', message: 'another process holds this Session' } }
    : resolve(sessionId))
  t.mock.method(rt, 'warn', () => {})
  sent.length = 0
  await emit(room.id, userMessage('Again'))
  running = relay(room.id, 'r2')
  const writerTurn = await turnFor(sent)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Still here.', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.code]), [['Chief', 'SESSION']])
  assert.equal(rt.roomOf(room.id).sessions[chief], first.sessionId)
})

// #217: DSH opens a relative file link from the folder of the Session that shows it.
test('a relative file link a member writes reaches the group, and another Bot, as a full path', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-links-')))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const room = await team(call, sent)
  assert.equal((await call('update-room', { id: room.id, workDir: folder })).ok, true)
  const full = path => join(folder, path).replace(/\\/g, '/').replace(/ /g, '%20')
  await emit(room.id, userMessage('Where is the draft?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'It is in [a.txt](sub/a.txt).', 1)
  const second = await turnFor(sent, first)
  assert.ok(second.message.content[0].text.includes(`[a.txt](${full('sub/a.txt')})`))
  await answer(second.sessionId, second.message.source.exchangeId, 'Thanks.', 2)
  const result = JSON.parse(await running)
  assert.equal(result.replies[0].text, `It is in [a.txt](${full('sub/a.txt')}).`)

  const chief = rt.state.mainBotIds[0]
  const writer = rt.state.rooms[room.id].members.find(id => id !== chief)
  sent.length = 0
  await rt.teamTools.find(d => d.name === 'message_bot').execute({ to: rt.botOf(writer).name, message: 'Read [notes](notes.md#L3)', when: 'queue' }, {
    agent: { id: first.sessionId, session: { id: first.sessionId, header: { cwd: folder } }, inbox: { nextStep: [], nextTurn: [] } }, callId: 'c1',
  })
  const delivered = await waitFor(() => sent.find(entry => entry.sessionId === room.id && entry.message.source?.role === 'post'))
  assert.ok(delivered.message.content.map(block => block.text).join('\n').includes(`[notes](${full('notes.md')}#L3)`))
})

// #209: DSH can fail a member's turn before its first step (DSH 0.2.1 does so for a folder
// that is gone), so the turn never takes the round's call.
test('a member turn that fails before it takes the call fails that member in the round at once', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await emit(first.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(first.sessionId, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'working-directory: directory does not exist: "/gone"', code: 'UNKNOWN' } } } })
  const second = await turnFor(sent, first)
  assert.ok(second, 'the next member speaks without waiting for the reply timeout')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => [reply.kind ?? 'reply', reply.name]), [['failed', 'Chief'], ['reply', 'Writer']])
})

test('a member turn that runs out of quota leaves a lasting line in the group log', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Deploy it'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await emit(first.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(first.sessionId, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'coding plan quota used up', code: 'QUOTA', status: 402 } } } })
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 1)
  await running
  const failed = rt.roomOf(room.id).log.filter(line => line.kind === 'notice' && line.reason === 'failed')
  assert.equal(failed.length, 1)
  assert.deepEqual(failed[0].names, ['Chief'])
  assert.match(failed[0].detail, /^QUOTA/)
  const { lineText } = await import('../src/host/groups.ts')
  assert.match(lineText(failed[0]), /^\[Chief stopped: its model call failed \(QUOTA.*\)\. What it was doing here is not finished; the user can switch its model in its settings or ask it to go on\.\]$/)
})

test('a member deleted while its group Session is made is left out, and the Session is not kept', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const writer = rt.state.rooms[room.id].members.find(id => !rt.isMain(id))
  const archived = []
  ctx.workspaceRegistry.archiveSession = async (sessionId) => { archived.push(sessionId) }
  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)

  let release
  const gate = new Promise(resolve => { release = resolve })
  let made
  const making = new Promise(resolve => { made = resolve })
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (options) => {
    const result = await create(options)
    made(result.sessionId)
    await gate
    return result
  }
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const sessionId = await making
  assert.equal((await call('delete-bot', { id: writer })).ok, true)
  release()

  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => [reply.kind ?? 'reply', reply.name]), [['reply', 'Chief']])
  assert.ok(archived.includes(sessionId))
  assert.equal(rt.state.rooms[room.id].sessions?.[writer], undefined)
})

test('a long group line keeps its start in state.json, and members and read_group_chat read it whole', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const room = await team(call, sent)
  const long = `${'长'.repeat(9000)}结尾`
  await emit(room.id, userMessage('Write it all out'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, long, 1)
  const second = await turnFor(sent, first)
  assert.ok(second.message.content[0].text.includes(long), 'the next member reads the line whole')
  await answer(second.sessionId, second.message.source.exchangeId, 'Thanks.', 2)
  assert.equal(JSON.parse(await running).replies[0].text, long)

  await rt.save()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id].log.find(line => line.length !== undefined)
  assert.equal(saved.text.length, 2000)
  assert.equal(saved.length, long.length)
  assert.equal(rt.ledger.record(`group-${room.id}`, saved.seq).text, long)
  const read = rt.teamTools.find(d => d.name === 'read_group_chat')
  const exec = { agent: { id: first.sessionId } }
  assert.match(await read.execute({ group: 'R1' }, exec), new RegExp(`cut; ${long.length} characters in all; read_group_chat with seq ${saved.seq} reads it whole`))
  assert.ok((await read.execute({ group: 'R1', seq: saved.seq }, exec)).endsWith(long))
  await stop({ keep: true })

  const file = join(home, 'state.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  const kept = onDisk.rooms[room.id]
  const fillers = Array.from({ length: 60 - kept.log.length }, (_, at) => ({ who: 'User', text: `line ${at}`, seq: kept.seq + at + 1 }))
  kept.log = [...kept.log, ...fillers]
  kept.seq += fillers.length
  writeFileSync(file, JSON.stringify(onDisk))

  const again = start({ home })
  t.after(() => again.stop({ keep: true }))
  await again.call('state', {})
  const whole = await again.rt.teamTools.find(d => d.name === 'read_group_chat').execute({ group: 'R1', seq: saved.seq }, exec)
  assert.ok(whole.endsWith(long))

  await again.emit(room.id, again.userMessage('Next'))
  const next = again.relay(room.id, 'relay-2')
  const one = await turnFor(again.sent)
  await again.answer(one.sessionId, one.message.source.exchangeId, 'One.', 3)
  const two = await turnFor(again.sent, one)
  await again.answer(two.sessionId, two.message.source.exchangeId, 'Two.', 4)
  await next
  assert.equal(again.rt.state.rooms[room.id].log.some(entry => entry.seq === saved.seq), false)
  assert.ok((await again.rt.teamTools.find(d => d.name === 'read_group_chat').execute({ group: 'R1', seq: saved.seq }, exec)).endsWith(long))
  const book = join(home, 'ledger', `group-${room.id}.jsonl`)
  assert.equal(existsSync(book), true)
  await again.call('delete-room', { id: room.id })
  await waitFor(() => (existsSync(book) ? undefined : true))
  assert.equal(existsSync(book), false)
})

test('a group line longer than a member reads is cut in its prompt, with its length, and its book keeps it whole', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Go'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'x'.repeat(25_000), 1)
  const second = await turnFor(sent, first)
  const prompt = second.message.content[0].text
  assert.ok(prompt.includes(`${'x'.repeat(20_000)}… (cut; 25000 characters in all)`))
  assert.ok(!prompt.includes('x'.repeat(20_001)))
  await answer(second.sessionId, second.message.source.exchangeId, 'Ok.', 2)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.length === 25_000)
  assert.equal(rt.ledger.record(`group-${room.id}`, line.seq).text.length, 25_000)
  assert.equal(existsSync(join(home, 'group-lines')), false)
})

test('a file the user sends in a group reaches each member the line is shown to, once', async (t) => {
  const { call, emit, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const pdf = { attachmentId: 'sha256:39cb3dab00', name: 'report-XYZ176.pdf', bytes: 607 }
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read this PDF' }, { type: 'file', attachment: pdf }] } })
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  const files = message => message.content.filter(block => block.type === 'file').map(block => block.attachment)
  assert.deepEqual(files(first.message), [pdf])
  assert.match(first.message.content[0].text, /User: Read this PDF\n\[File "report-XYZ176\.pdf" \(607 bytes\) attached\]/)
  await answer(first.sessionId, first.message.source.exchangeId, 'Reading it.', 1)
  const second = await turnFor(sent, first)
  assert.deepEqual(files(second.message), [pdf])
  await answer(second.sessionId, second.message.source.exchangeId, 'Me too.', 2)
  await running
  assert.deepEqual(rt.roomOf(room.id).log.find(line => line.who === 'User').files, [pdf])

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Thanks' }] } })
  running = relay(room.id, 'r2')
  const next = await turnFor(sent)
  assert.deepEqual(files(next.message), [])
  await answer(next.sessionId, next.message.source.exchangeId, 'OK.', 3)
  const after = await turnFor(sent, next)
  await answer(after.sessionId, after.message.source.exchangeId, 'OK.', 4)
  await running
})

test('an image the user sends in a group reaches each member the line is shown to, once, with its read-only path', async (t) => {
  const { call, emit, relay, answer, stop, sent, ctx, rt } = start()
  t.after(stop)
  const savedPath = '/tmp/dsh-attachments/objects/ab/cd'
  ctx.get = name => (name === 'attachments' ? { imageHostPath: () => savedPath } : undefined)
  const room = await team(call, sent)
  const png = { attachmentId: 'sha256:abcd1234', name: 'image.png', mediaType: 'image/png', bytes: 67_000, width: 800, height: 600 }
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'What is in this screenshot?' }, { type: 'image', attachment: png }] } })
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  const images = message => message.content.filter(block => block.type === 'image').map(block => block.attachment)
  assert.deepEqual(images(first.message), [png])
  assert.match(first.message.content[0].text, /read-only copy saved at "\/tmp\/dsh-attachments\/objects\/ab\/cd"/)
  await answer(first.sessionId, first.message.source.exchangeId, 'I see it.', 1)
  const second = await turnFor(sent, first)
  assert.deepEqual(images(second.message), [png])
  await answer(second.sessionId, second.message.source.exchangeId, 'Me too.', 2)
  await running
  assert.deepEqual(rt.roomOf(room.id).log.find(line => line.who === 'User').images, [png])

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Thanks' }] } })
  running = relay(room.id, 'r2')
  const next = await turnFor(sent)
  assert.deepEqual(images(next.message), [])
  await answer(next.sessionId, next.message.source.exchangeId, 'OK.', 3)
  const after = await turnFor(sent, next)
  await answer(after.sessionId, after.message.source.exchangeId, 'OK.', 4)
  await running
})

test('a long post goes to the group as a file, and reaches the member with its prompt', async (t) => {
  const { call, emit, relay, answer, stop, sent, ctx, rt } = start()
  t.after(stop)
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const long = `${Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${'报告内容。'.repeat(10)}`).join('\n')}\n结尾`
  const posted = await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: long }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R1"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  const file = post.message.content.find(block => block.type === 'file')?.attachment
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(post.message.source.length, long.length)
  assert.equal(new TextDecoder().decode(store.files.get(file.attachmentId)), long)

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const running = relay(room.id, 'relay')
  const turn = await turnFor(sent)
  assert.deepEqual(turn.message.content.filter(block => block.type === 'file').map(block => block.attachment), [file])
  const prompt = turn.message.content[0].text
  assert.ok(prompt.includes(`Chief: [A long message: ${long.length} characters.`))
  assert.ok(prompt.includes(`[File "Post from Chief.txt" (${file.bytes} bytes) attached]`))
  assert.ok(prompt.length < 6000, `the prompt has ${prompt.length} characters`)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Read it.', 1)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.botId === chief)
  assert.deepEqual(line.files, [file])
  assert.equal(line.length, undefined, 'the line is short; no file of its own')
})

test('members call each other for as long as they call, and a user @ mid-round still reaches a member', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')

  const spoken = []
  let turn = await turnFor(sent)
  for (let step = 0; step < 20; step += 1) {
    spoken.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `${step % 2 === 0 ? '@Writer' : '@Chief'} volley ${step + 1}`, step + 1)
    turn = await turnFor(sent, ...spoken)
  }
  const writerSession = rt.state.rooms[room.id].sessions[writer.id]
  assert.equal(sent.filter(entry => entry.sessionId === writerSession && entry.message.source.role === 'room').length, 10)

  await compose(room.id, '@Writer your take?')
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Done.', 21)
  const called = await turnFor(sent, ...spoken, turn)
  assert.equal(called.sessionId, writerSession)
  assert.match(called.message.content[0].text, /@Writer your take\?/)
  assert.match(called.message.content[0].text, /the user mentioned you/)
  await answer(called.sessionId, called.message.source.exchangeId, 'Here.', 22)
  const result = JSON.parse(await running)
  assert.equal(result.replies.filter(reply => reply.kind === 'paused').length, 0)
  const state = rt.state.rooms[room.id]
  assert.equal(state.log.filter(line => line.kind === 'notice').length, 0, 'no pause notice')
  assert.equal(state.paused, undefined)
  assert.equal(state.relays, undefined, 'nothing counts the calls')
})

test('calls parked under the old relay limit run in the group\'s next round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt, home } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })
  const chief = rt.state.mainBotIds[0]
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const state = () => rt.state.rooms[room.id]
  state().paused = [{ id: writer.id, name: 'Writer', note: 'Chief mentioned you', by: chief }]
  await rt.save()

  sent.length = 0
  await emit(room.id, userMessage('Status, please'))
  assert.equal(state().paused.length, 1, 'still parked until a round runs')
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  const second = await turnFor(sent, first)
  const [own, parked] = first.sessionId === state().sessions[chief] ? [first, second] : [second, first]
  assert.equal(own.sessionId, state().sessions[chief])
  assert.equal(parked.sessionId, state().sessions[writer.id], 'the parked call runs')
  assert.match(parked.message.content[0].text, /Chief mentioned you/)
  await answer(own.sessionId, own.message.source.exchangeId, 'All fine.', 1)
  await answer(parked.sessionId, parked.message.source.exchangeId, 'On it.', 2)
  await running
  assert.equal(state().paused, undefined)
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(saved.paused, undefined)
})

test('calls the idle guard parked wait for the user\'s message, also one that joins a running round', async (t) => {
  const { call, emit, compose, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })
  const chief = rt.state.mainBotIds[0]
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const state = () => rt.state.rooms[room.id]
  state().paused = [{ id: writer.id, name: 'Writer', note: 'Chief mentioned you', by: chief, idle: true }]
  await rt.save()

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'p1', senderSessionId: writer.id, senderName: 'Writer', roomId: room.id }, content: [{ type: 'text', text: '[Group post from Writer]\n@Chief the draft is up' }] } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.equal(first.sessionId, state().sessions[chief])
  assert.equal(state().paused.length, 1, 'a Bot\'s post does not bring the parked call in')

  await compose(room.id, 'Go on, both of you')
  await answer(first.sessionId, first.message.source.exchangeId, 'Thanks.', 1)
  const parked = await waitFor(() => sent.find(entry => entry !== first && entry.message.source.role === 'room' && /Chief mentioned you/.test(entry.message.content[0].text)))
  assert.ok(parked, 'the user\'s message brings the parked call in')
  assert.equal(state().paused, undefined)
  const again = await waitFor(() => sent.find(entry => entry !== first && entry !== parked && entry.message.source.role === 'room'))
  await answer(parked.sessionId, parked.message.source.exchangeId, 'On it.', 1)
  await answer(again.sessionId, again.message.source.exchangeId, 'Fine.', 2)
  await running
})

test('a member the reply timeout cut short is told to the group, not left as silence', async (t) => {
  const { call, emit, userMessage, relay, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const turn = await turnFor(sent)
  rt.roomWaiters.get(turn.message.source.exchangeId).resolve({ missed: true })
  await running

  const notices = rt.state.rooms[room.id].log.filter(line => line.kind === 'notice')
  assert.equal(notices.length, 1)
  assert.deepEqual({ reason: notices[0].reason, names: notices[0].names, minutes: notices[0].minutes },
    { reason: 'missed', names: ['Chief'], minutes: 4 })
  assert.match(lineText(notices[0]), /did not answer within 4 minutes/)
  assert.match(lineText(notices[0]), /late reply/)
})

test('in admin mode a sole admin that passes leaves the group a notice', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Writer, what do you think?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the turn alone')
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.passed, ['Chief'])
  assert.equal(result.replies.filter(reply => reply.kind === undefined).length, 0, 'the round ends without an answer')

  const events = result.replies.filter(reply => reply.kind === 'admin-passed')
  assert.equal(events.length, 1, 'the round shows the notice once')
  assert.deepEqual({ botId: events[0].botId, name: events[0].name },
    { botId: chief, name: 'Chief' })

  const notices = rt.state.rooms[room.id].log.filter(line => line.kind === 'notice')
  assert.equal(notices.length, 1, 'the group is told once')
  assert.deepEqual({ reason: notices[0].reason, names: notices[0].names },
    { reason: 'admin-passed', names: ['Chief'] })
  assert.match(lineText(notices[0]), /did not answer or call anyone/)
  assert.match(lineText(notices[0]), /@Name/)

  await emit(room.id, userMessage('Anyone there?'))
  const next = relay(room.id, 'relay-2')
  const turn = await turnFor(sent, first)
  assert.match(turn.message.content[0].text, /did not answer or call anyone/)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Here.', 2)
  await next
})

test('in admin mode an admin that answers leaves the group no notice', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Writer, what do you think?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'On it.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(result.replies.filter(reply => reply.kind === 'admin-passed').length, 0)
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('in admin mode a member the user called alone is not the admin, and the group says nothing', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('@Writer your take'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the member the user called answers')
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.passed, ['Writer'])
  assert.deepEqual(result.replies, [], 'the member passed, and the admin was not alone')
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('a group where everyone answers says nothing when the admin passes', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Writer'])
  assert.equal(result.replies.filter(reply => reply.kind === 'admin-passed').length, 0)
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('a member still at work is shown with the group messages it has not read yet', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const editor = (await call('create-bot', { name: 'Editor' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id, editor.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0

  await emit(room.id, userMessage('hello'))
  const first0 = relay(room.id, 'relay-1')
  const spoken = []
  for (const text of ['Chief here.', 'Writer here.', 'Editor here.']) {
    const turn = await turnFor(sent, ...spoken)
    await answer(turn.sessionId, turn.message.source.exchangeId, text, 1)
    spoken.push(turn)
  }
  await first0

  await emit(room.id, userMessage('again'))
  const second0 = relay(room.id, 'relay-2')
  const chiefTurn = await turnFor(sent, ...spoken)
  await emit(rt.state.rooms[room.id].sessions[editor.id], { type: 'turn/start', data: { turn: 9 } })
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, 'Chief again.', 2)
  spoken.push(chiefTurn)

  const writerTurn = await turnFor(sent, ...spoken)
  assert.match(writerTurn.message.content[0].text, /Editor \(1 min, with [1-9]\d* group message\(s\) it has not read yet\)/)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Writer again.', 2)
  await second0
})


async function trio(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const tester = (await call('create-bot', { name: 'Tester' })).value
  const room = (await call('create-room', { name: 'R3', members: [chief, writer.id, tester.id] })).value
  await call('update-room', { id: room.id, mode: 'admin' })
  sent.length = 0
  return room
}

test('members called in one message start together, each told who else answers', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await trio(call, sent)
  await emit(room.id, userMessage('Search it, all of you'))
  const running = relay(room.id, 'relay')
  const admin = await turnFor(sent)
  await answer(admin.sessionId, admin.message.source.exchangeId, '@Writer @Tester search it', 1)
  const first = await turnFor(sent, admin)
  const second = await turnFor(sent, admin, first)
  assert.ok(first && second, 'both members got their turn at once')
  const prompts = [first, second].map(entry => entry.message.content[0].text)
  assert.ok(prompts.some(prompt => /Called together with you: Tester\./.test(prompt)))
  assert.ok(prompts.some(prompt => /Called together with you: Writer\./.test(prompt)))
  assert.ok(prompts.every(prompt => !/one at a time/.test(prompt)))
  await answer(second.sessionId, second.message.source.exchangeId, 'Second found it.', 2)
  await answer(first.sessionId, first.message.source.exchangeId, 'First found it too.', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.text), ['@Writer @Tester search it', 'Second found it.', 'First found it too.'])
})

test('a user message mid-round reaches the admin at once while a member still answers', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await trio(call, sent)
  const chief = rt.state.mainBotIds[0]
  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const admin = await turnFor(sent)
  await answer(admin.sessionId, admin.message.source.exchangeId, '@Writer go', 1)
  const writer = await turnFor(sent, admin)
  await compose(room.id, 'why is the Tester idle?')
  await emit(room.id, { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [] } })
  const again = await turnFor(sent, admin, writer)
  assert.equal(again.sessionId, rt.state.rooms[room.id].sessions[chief], 'the admin answers the user without waiting for the Writer')
  assert.match(again.message.content[0].text, /why is the Tester idle\?/)
  assert.match(again.message.content[0].text, /Writer \(answering now\)/)
  await answer(again.sessionId, again.message.source.exchangeId, 'It was not called.', 2)
  await answer(writer.sessionId, writer.message.source.exchangeId, 'Done.', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Chief', 'Writer'])
})

test('a plain message in a group where everyone answers still goes one member at a time', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await trio(call, sent)
  await call('update-room', { id: room.id, mode: 'everyone' })
  await emit(room.id, userMessage('Count off'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.match(first.message.content[0].text, /Members answer this message one at a time/)
  assert.match(first.message.content[0].text, /You are number 1 of 3/)
  await settle()
  assert.equal(sent.filter(entry => entry.message.source.role === 'room').length, 1, 'the next member waits')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.match(second.message.content[0].text, /You are number 2 of 3/)
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const third = await turnFor(sent, first, second)
  await answer(third.sessionId, third.message.source.exchangeId, 'three', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.text), ['one', 'two', 'three'])
})

test('a group stops answering its own status posts once the idle steps reach the limit', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const state = () => rt.state.rooms[room.id]
  const posted = async (message, callId) => {
    sent.length = 0
    await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message }, { agent: { id: rt.chatOf(chief) } })
    const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
    await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
    return { round: relay(room.id, callId) }
  }

  for (let step = 1; step <= 5; step += 1) {
    const { round: running } = await posted('暂无待办，静候下一步', `relay-${step}`)
    const turn = await turnFor(sent)
    assert.ok(turn, `round ${step} answers the post`)
    await answer(turn.sessionId, turn.message.source.exchangeId, '待命', step)
    await running
    assert.equal(state().idleRelays, step, 'one step, whatever the round took to say')
    assert.equal(state().idlePaused, undefined, 'not paused before the limit')
  }

  const { round: sixth } = await posted('待命', 'relay-6')
  const turning = await turnFor(sent)
  assert.ok(turning, 'the round the sixth step counts in still runs')
  await answer(turning.sessionId, turning.message.source.exchangeId, '收到，静候下一步', 6)
  await sixth
  assert.equal(state().idleRelays, ROOM_IDLE_RELAY_LIMIT)
  assert.ok(state().idlePaused, 'the room is paused')
  const notices = state().log.filter(line => line.kind === 'notice' && line.reason === 'paused')
  assert.equal(notices.length, 1, 'the group hears about it once')
  assert.match(lineText(notices[0]), /6 status updates with no new work/)
  assert.match(lineText(notices[0]), /the last from Writer/)
  assert.match(lineText(notices[0]), /until the user writes here/)

  const { round: seventh } = await posted('暂无待办', 'relay-7')
  await settle()
  assert.equal(sent.filter(entry => entry.message.source.role === 'room').length, 0, 'no turn starts on its own')
  assert.equal(JSON.parse(await seventh).replies.filter(reply => reply.kind === 'paused').length <= 1, true)
  assert.equal(state().log.filter(line => line.kind === 'notice').length, 1, 'no second notice')

  await emit(room.id, userMessage('@Chief 我们接着做'))
  const resumed = relay(room.id, 'relay-8')
  const answered = []
  for (let n = 0; n < 3; n += 1) {
    const turn = await turnFor(sent, ...answered)
    if (turn === undefined) break
    answered.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `好，先从第 ${n + 1} 段日志看起`, 9 + n)
    await settle()
  }
  const sessions = answered.map(turn => turn.sessionId)
  assert.ok(sessions.includes(state().sessions[chief]), 'the user reaches the admin')
  assert.ok(sessions.includes(state().sessions[writer.id]), 'the held call runs after the user writes')
  assert.equal(state().idlePaused, undefined)
  assert.equal(state().idleRelays, undefined)
  await resumed
})

test('a paused group holds idle calls, lets new work through, and only the user lifts it', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const state = () => rt.state.rooms[room.id]
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const pause = () => {
    state().idleRelays = ROOM_IDLE_RELAY_LIMIT
    state().idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }
  }
  const posted = async (message, callId) => {
    sent.length = 0
    await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message }, { agent: { id: rt.chatOf(chief) } })
    const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
    await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
    return { round: relay(room.id, callId) }
  }

  pause()
  const { round: calling } = await posted('@Writer 把这批报错贴出来', 'relay-1')
  const turn = await turnFor(sent)
  assert.ok(turn, 'a post with work in it is not held back')
  rt.workRoomTurn(turn.sessionId, 'bash')
  await answer(turn.sessionId, turn.message.source.exchangeId, '贴在这里了：两个 502，一个超时', 1)
  const result = await turnFor(sent, turn)
  assert.ok(result, 'the member that asked is woken with its result')
  await answer(result.sessionId, result.message.source.exchangeId, '收到，我安排下一步', 1)
  await calling
  assert.ok(state().idlePaused, 'a tool call does not lift a pause already in place')

  const { round: asking } = await posted('@Writer 再核对一遍', 'relay-2')
  const again = await turnFor(sent)
  await answer(again.sessionId, again.message.source.exchangeId, '@Chief 待命', 2)
  await asking
  const held = (state().paused ?? []).map(entry => [entry.name, entry.idle])
  assert.deepEqual(held, [['Chief', true]], 'the idle call waits in the park list')
  assert.equal(sent.filter(entry => entry.sessionId === state().sessions[chief] && entry.message.source.role === 'room').length, 0, 'the held member is not called')

  sent.length = 0
  await rt.postToRoom(room, rt.botOf(writer.id), '迟到的结果：两个 502 都修好了', { late: true, askedBy: chief })
  const latePost = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: latePost.message.source, content: latePost.message.content } })
  const lateRound = relay(room.id, 'relay-late')
  const late = await turnFor(sent)
  assert.ok(late, 'a late reply still reaches the member that asked')
  assert.equal(late.sessionId, state().sessions[chief])
  assert.ok(state().idlePaused, 'a late reply does not lift a pause')
  await answer(late.sessionId, late.message.source.exchangeId, '收到，我看一下', 3)
  await lateRound

  sent.length = 0
  await emit(room.id, userMessage('@Writer 继续'))
  const resumed = relay(room.id, 'relay-3')
  const answered = []
  for (let n = 0; n < 4; n += 1) {
    const turn = await turnFor(sent, ...answered)
    if (turn === undefined) break
    answered.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `继续核对第 ${n + 1} 段日志`, 4 + n)
    await settle()
  }
  assert.ok(answered.length >= 1, "the user's message reaches a member")
  assert.deepEqual(answered.map(turn => turn.sessionId).includes(state().sessions[chief]), true, 'the call held back runs after the user writes')
  assert.equal(state().idlePaused, undefined)
  await resumed
})

test('a paused group parks every member an @all called, in a new round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await trio(call, sent)
  await call('update-room', { id: room.id, mode: 'everyone' })
  const chief = rt.state.mainBotIds[0]
  const state = () => rt.state.rooms[room.id]
  state().idleRelays = ROOM_IDLE_RELAY_LIMIT
  state().idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }

  await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R3', message: '@all 待命' }, { agent: { id: rt.chatOf(chief) } })
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const held = relay(room.id, 'relay-1')
  await held
  assert.equal(sent.filter(entry => entry.message.source.role === 'room').length, 0, 'a paused room opens no round')
  assert.deepEqual((state().paused ?? []).map(entry => [entry.name, entry.note, entry.idle]), [
    ['Writer', 'Chief called everyone', true],
    ['Tester', 'Chief called everyone', true],
  ], 'every member @all called waits for the user')

  sent.length = 0
  await emit(room.id, userMessage('@Writer 继续'))
  const resumed = relay(room.id, 'relay-2')
  const answered = []
  for (let n = 0; n < 4; n += 1) {
    const turn = await turnFor(sent, ...answered)
    if (turn === undefined) break
    answered.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `继续第 ${n + 1} 步`, n + 1)
    await settle()
  }
  assert.equal(state().paused, undefined)
  assert.ok(answered.length >= 1)
  await resumed
})

test('a paused group parks every member an @all called, in a running round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await trio(call, sent)
  await call('update-room', { id: room.id, mode: 'everyone' })
  const chief = rt.state.mainBotIds[0]
  const state = () => rt.state.rooms[room.id]

  await emit(room.id, userMessage('@Writer 开始吧'))
  const running = relay(room.id, 'relay-1')
  const first = await turnFor(sent)
  assert.ok(first, 'the member the user called starts')
  state().idleRelays = ROOM_IDLE_RELAY_LIMIT
  state().idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }
  const posted = await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R3', message: '@all 待命' }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R3"/)
  const parked = (state().paused ?? []).map(entry => entry.name).sort()
  assert.deepEqual(parked, ['Tester', 'Writer'], 'the running round parks every member @all called')
  await answer(first.sessionId, first.message.source.exchangeId, '第一部分看完了', 1)
  await running
})

test('a post with new work that lands in a running round is answered in that round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const state = () => rt.state.rooms[room.id]
  state().idleRelays = ROOM_IDLE_RELAY_LIMIT
  state().idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }

  await emit(room.id, userMessage('@Writer 开始吧'))
  const running = relay(room.id, 'relay-1')
  const first = await turnFor(sent)
  assert.ok(first, 'the member the user called starts')
  sent.length = 0
  const posted = await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: '@Writer 这段日志也看一下' }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R1"/)
  await answer(first.sessionId, first.message.source.exchangeId, '先看第一部分', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the new work is queued into the running round')
  assert.match(second.message.content[0].text, /这段日志也看一下/)
  await answer(second.sessionId, second.message.source.exchangeId, '第二部分也看完了', 2)
  await running
})

test('the idle guard reads status posts and not ordinary work', () => {
  const everyone = [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }]
  const idle = [
    '待命', '暂无待办', '静候下一步', '收到，待命', '收口无待办', '保持待命', '暂无待办，静候下一步',
    '目前没有新进展', '今日无任务', '当前无任务',
  ]
  for (const text of idle) assert.equal(isIdleRelayText(text, everyone, []), true, `should count: ${text}`)
  const work = [
    '当前任务：修 502', '目前任务已完成', '今天任务很多', '任务', '变化', '安排', '进展', '动作', '待', '静',
    '待我确认', '静态资源缺失', '安排在周三上线', '进展：接口改完', '动作序列有误',
    '正在核对 09:31 之后的日志', '已完成登录接口改造', '@Chief 这段日志也看一下',
  ]
  for (const text of work) assert.equal(isIdleRelayText(text, everyone, []), false, `should not count: ${text}`)
})

test('the idle pause survives a restart and the user lifts it', async (t) => {
  const first = start()
  const room = await team(first.call, first.sent)
  const chief = first.rt.state.mainBotIds[0]
  first.rt.state.rooms[room.id].idleRelays = ROOM_IDLE_RELAY_LIMIT
  first.rt.state.rooms[room.id].idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }
  await first.rt.save()
  const saved = JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).rooms[room.id]
  assert.deepEqual({ count: saved.idleRelays, paused: saved.idlePaused?.count }, { count: ROOM_IDLE_RELAY_LIMIT, paused: ROOM_IDLE_RELAY_LIMIT })
  await first.stop({ keep: true })

  const second = start({ home: first.home })
  t.after(() => second.stop())
  const { rt, sent, emit, relay, answer } = second
  const state = () => rt.state.rooms[room.id]
  assert.equal(state().idlePaused?.count, ROOM_IDLE_RELAY_LIMIT, 'the pause is still there after the restart')
  sent.length = 0
  await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: '暂无待办' }, { agent: { id: rt.chatOf(chief) } })
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await relay(room.id, 'relay-1')
  assert.equal(sent.filter(entry => entry.message.source.role === 'room').length, 0, 'no round starts on its own after a restart')

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '@Writer 继续' }] } })
  const resumed = relay(room.id, 'relay-2')
  const turn = await turnFor(sent)
  assert.ok(turn, "the user's message opens a round again")
  await answer(turn.sessionId, turn.message.source.exchangeId, '继续核对', 1)
  await resumed
  assert.equal(state().idlePaused, undefined)
})

// 让步 C12: DSH cuts a long tool result.
test("a long round's result stays small, and its rows read back whole after a restart", async (t) => {
  const { call, emit, userMessage, inboxOf, answer, stop, sent, home, rt } = start()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const room = await team(call, sent)
  const long = `${'回'.repeat(60_000)}完`
  await emit(room.id, userMessage('Write a long report'))
  const raw = rt.teamTools.find(d => d.name === 'group_relay').execute({}, { agent: { id: room.id, inbox: inboxOf(room.id) }, callId: 'long', signal: new AbortController().signal })
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, long, 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '[PASS]', 2)
  const result = await raw
  assert.ok(result.length < 200, result)
  const { from } = JSON.parse(result)
  await afterRound(rt, room.id, result)
  const to = undefined
  assert.equal((await call('group-rows', { roomId: room.id, from, to })).value.rows.find(row => row.botId !== undefined).text, long)
  await rt.save()
  await stop({ keep: true })

  const again = start({ home })
  t.after(() => again.stop({ keep: true }))
  await again.call('state', {})
  const rows = (await again.call('group-rows', { roomId: room.id, from, to })).value.rows
  assert.deepEqual(rows.map(row => [row.kind ?? 'message', row.text?.length]), [['message', long.length]])
})

test("a member's group row carries the change line of its turn", async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const changes = {
    sessionId: 'member-session', seq: 12, turn: 4, total: 2, added: 9, deleted: 3,
    files: [{ path: 'src/a.js', added: 6, deleted: 3 }, { path: 'docs/b.md', added: 3, deleted: 0 }],
  }
  rt.turnChanges = async () => changes
  await emit(room.id, userMessage('First'))
  const running = relay(room.id, 'one')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Done.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '[PASS]', 2)
  const from = JSON.parse(await running).from
  const rows = rt.groupRows(room.id, from)
  const done = rows.find(row => row.text === 'Done.')
  assert.deepEqual(done.changes, changes)
  const check = await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })
  assert.equal(check.value, false)
})

test('a late completion notice keeps the change line of its turn', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('First'))
  const running = relay(room.id, 'one')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Done.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '[PASS]', 2)
  const { from } = JSON.parse(await running)

  const changes = {
    sessionId: 'member-session', seq: 31, turn: 8, total: 1, added: 3, deleted: 1,
    files: [{ path: 'late.js', added: 3, deleted: 1 }],
  }
  const member = rt.botOf(room.members.find(id => id !== rt.state.mainBotIds[0]))
  await rt.postToRoom(room, member, '', { late: true, done: true, changes })
  const post = sent.findLast(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.deepEqual(post.message.source.changes, changes, 'the queued post carries the change line')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  await relay(room.id, 'late')

  const rows = rt.groupRows(room.id, from, Number.MAX_SAFE_INTEGER)
  const notice = rows.find(row => row.kind === 'done')
  assert.deepEqual(notice?.changes, changes)
})

test('a member that changed files and ended with [PASS] still gets its change line', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const changes = {
    sessionId: 'pass-session', seq: 44, turn: 6, total: 1, added: 5, deleted: 2,
    files: [{ path: 'work.js', added: 5, deleted: 2 }],
  }
  let writerSession
  rt.turnChanges = async sessionId => (sessionId === writerSession ? changes : undefined)
  await emit(room.id, userMessage('Do the work'))
  const running = relay(room.id, 'pass')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'On it.', 1)
  const second = await turnFor(sent, first)
  writerSession = second.sessionId
  await answer(second.sessionId, second.message.source.exchangeId, '[PASS]', 2)
  const { from } = JSON.parse(await running)
  const rows = rt.groupRows(room.id, from)
  const done = rows.find(row => row.kind === 'done')
  assert.deepEqual(done?.changes, changes)
  assert.equal(done?.botId, room.members.find(id => id !== rt.state.mainBotIds[0]))
})

test('a [PASS] turn that changed nothing adds no completion line', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  rt.turnChanges = async () => undefined
  await emit(room.id, userMessage('Do the work'))
  const running = relay(room.id, 'pass-none')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'On it.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '[PASS]', 2)
  const { from } = JSON.parse(await running)
  const rows = rt.groupRows(room.id, from)
  assert.equal(rows.some(row => row.kind === 'done'), false)
})

test('the rows of a round leave out its opening message and show once what came between rounds', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('First'))
  const first = relay(room.id, 'one')
  const a = await turnFor(sent)
  await answer(a.sessionId, a.message.source.exchangeId, 'Done one.', 1)
  const b = await turnFor(sent, a)
  await answer(b.sessionId, b.message.source.exchangeId, '[PASS]', 2)
  assert.deepEqual(JSON.parse(await first).replies.map(row => row.text), ['Done one.'])
  await rt.teamTools.find(d => d.name === 'read_own_chat').execute({ query: 'plan' }, { agent: { id: a.sessionId } })
  await emit(room.id, userMessage('Second'))
  const second = relay(room.id, 'two')
  const c = await turnFor(sent, a, b)
  await answer(c.sessionId, c.message.source.exchangeId, 'Done two.', 3)
  const d = await turnFor(sent, a, b, c)
  await answer(d.sessionId, d.message.source.exchangeId, '[PASS]', 4)
  const secondRows = JSON.parse(await second)
  assert.deepEqual(secondRows.replies.map(row => [row.kind ?? 'message', row.text]), [['message', 'Done two.']])
  const firstFrom = rt.ledger.records(`group-${room.id}`).find(record => record.event === 'anchor').from
  assert.deepEqual(rt.groupRows(room.id, firstFrom).map(row => [row.kind ?? 'message', row.text]), [['message', 'Done one.'], ['lookup', 'plan']])
})

test('a group whose state was not saved after its last line goes on numbering after the book', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const room = await team(call, sent)
  await emit(room.id, userMessage('One'))
  const running = relay(room.id, 'one')
  const a = await turnFor(sent)
  await answer(a.sessionId, a.message.source.exchangeId, 'Reply one.', 1)
  const b = await turnFor(sent, a)
  await answer(b.sessionId, b.message.source.exchangeId, '[PASS]', 2)
  await running
  await rt.save()
  const seq = rt.state.rooms[room.id].seq
  await rt.ledger.flush()
  await stop({ keep: true })
  const book = join(home, 'ledger', `group-${room.id}.jsonl`)
  writeFileSync(book, `${readFileSync(book, 'utf8')}${JSON.stringify({ who: 'User', text: 'said, not saved', seq: seq + 1, time: Date.now() })}\n`)

  const again = start({ home })
  t.after(() => again.stop({ keep: true }))
  await again.call('state', {})
  await again.emit(room.id, again.userMessage('Two'))
  const next = again.relay(room.id, 'two')
  const c = await turnFor(again.sent)
  assert.match(c.message.content[0].text, /said, not saved/)
  await again.answer(c.sessionId, c.message.source.exchangeId, 'Reply two.', 3)
  const d = await turnFor(again.sent, c)
  await again.answer(d.sessionId, d.message.source.exchangeId, '[PASS]', 4)
  await next
  await again.rt.ledger.flush()
  const seqs = readFileSync(book, 'utf8').trim().split('\n').map(row => JSON.parse(row).seq).filter(seq => seq !== undefined)
  assert.equal(new Set(seqs).size, seqs.length)
  assert.ok(again.rt.ledger.records(`group-${room.id}`).some(record => record.text === 'Two' && record.seq === seq + 2))
})

async function startPausedStatusRound(t) {
  const ctx = start()
  t.after(ctx.stop)
  const { call, emit, relay, sent, rt } = ctx
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const state = () => rt.state.rooms[room.id]
  state().idleRelays = ROOM_IDLE_RELAY_LIMIT
  state().idlePaused = { from: chief, count: ROOM_IDLE_RELAY_LIMIT, noticed: true }

  let releaseSave
  let markSaving
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  const saving = new Promise((resolve) => { markSaving = resolve })
  const origSave = rt.save
  rt.save = async (...args) => {
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id && round.starting)) {
      rt.save = origSave
      markSaving()
      await saveGate
    }
    return origSave(...args)
  }

  await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: '暂无待办' }, { agent: { id: rt.chatOf(chief) } })
  const idlePost = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: idlePost.message.source, content: idlePost.message.content } })
  const quiet = relay(room.id, 'relay-1')
  await saving
  return { ...ctx, room, chief, state, quiet, releaseSave }
}

test('a user message arriving while a paused status round starts still opens a round of its own', async (t) => {
  const { emit, userMessage, relay, answer, sent, room, state, quiet, releaseSave } = await startPausedStatusRound(t)
  sent.length = 0
  await emit(room.id, userMessage('@Writer 继续'))
  const resumed = relay(room.id, 'relay-2')
  releaseSave()

  const turn = await turnFor(sent)
  assert.ok(turn, "the user's message opens a round again")
  await answer(turn.sessionId, turn.message.source.exchangeId, '继续核对', 1)
  await resumed
  await quiet
  assert.equal(state().idlePaused, undefined)
})

test('a Bot message arriving while a paused status round starts still opens a round of its own', async (t) => {
  const { emit, relay, answer, sent, rt, room, chief, quiet, releaseSave } = await startPausedStatusRound(t)
  sent.length = 0
  await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: '@Writer 看一下新报错' }, { agent: { id: rt.chatOf(chief) } })
  const workPost = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  await emit(room.id, { type: 'user/message', data: { source: workPost.message.source, content: workPost.message.content } })
  const work = relay(room.id, 'relay-2')
  releaseSave()

  const turn = await turnFor(sent)
  assert.ok(turn, "the Bot's message opens a round again")
  await answer(turn.sessionId, turn.message.source.exchangeId, '我看过了', 1)
  await work
  await quiet
})

test('a Bot post during an empty round closing drain takes the group Session path to the next round', async (t) => {
  const { emit, relay, answer, sent, rt, room, chief, quiet, releaseSave } = await startPausedStatusRound(t)
  const holder = [...rt.roomProgress.values()].find(round => round.roomId === room.id && round.starting)
  assert.ok(holder)
  sent.length = 0
  const postedDuringClose = holder.ready.then(() => rt.postToRoom(rt.roomOf(room.id), rt.botOf(chief), '@Writer 收尾时发的帖'))
  releaseSave()
  await postedDuringClose

  const queuedPost = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.ok(queuedPost, 'the closing round leaves the Bot post in the group Session')
  await emit(room.id, { type: 'user/message', data: { source: queuedPost.message.source, content: queuedPost.message.content } })
  const next = relay(room.id, 'relay-2')

  const turn = await turnFor(sent)
  assert.ok(turn, 'the next round calls the member named in the Bot post')
  await answer(turn.sessionId, turn.message.source.exchangeId, '收到了', 1)
  await next
  await quiet
})

test('a message arriving while a closing round saves an admin-passed notice still opens the next round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  let releaseSave
  let markSaving
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  const saving = new Promise((resolve) => { markSaving = resolve })
  const origSave = rt.save
  rt.save = async (...args) => {
    if (rt.roomOf(room.id).log.some(line => line.kind === 'notice' && line.reason === 'admin-passed')) {
      rt.save = origSave
      markSaving()
      await saveGate
    }
    return origSave(...args)
  }

  await emit(room.id, userMessage('Anyone?'))
  const first = relay(room.id, 'relay-1')
  const chiefTurn = await turnFor(sent)
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, '[PASS]', 1)
  await saving

  sent.length = 0
  await emit(room.id, userMessage('@Writer 看一下'))
  const second = relay(room.id, 'relay-2')
  releaseSave()

  const writerTurn = await turnFor(sent)
  assert.ok(writerTurn, 'the message sent while admin-passed saves still opens the next round')
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, '好的', 2)
  await second
  await first
})

test('a stopped notice during a round closing drain still logs into the draining round', async (t) => {
  const { call, emit, userMessage, relay, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')

  await emit(room.id, userMessage('@Writer 看看日志'))
  const running = relay(room.id, 'relay-1')
  const turn = await turnFor(sent)
  assert.ok(turn)

  rt.stopRoomRound(room.id)
  await rt.postToRoom(rt.roomOf(room.id), rt.botOf(writer.id), '', { quiet: true, stopped: true })
  await running

  const stoppedRows = rt.roomOf(room.id).log.filter(line => line.kind === 'stopped' && line.botId === writer.id)
  assert.equal(stoppedRows.length, 1, 'stopped notice logs into the draining round without waiting for another message')
  assert.equal(sent.filter(entry => entry.sessionId === room.id && entry.message.source.role === 'post').length, 0)
})

test('in admin mode the Main Bot takes the user\'s plain message even when another Bot is the admin; @Name skips it', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id], admin: writer.id })).value
  await call('update-room', { id: room.id, mode: 'admin' })
  sent.length = 0

  await emit(room.id, userMessage('Can someone draft the release notes?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.equal(first.sessionId, rt.state.rooms[room.id].sessions[chief])
  assert.match(first.message.content[0].text, /You are the Main Bot: the user's plain messages in this group come to you first/)
  assert.doesNotMatch(first.message.content[0].text, /You are this group's admin/)
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.passed, ['Chief'])
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'admin-passed').map(reply => reply.name), ['Chief'])

  await emit(room.id, userMessage('@Writer what do you think?'))
  const next = relay(room.id, 'relay-2')
  const second = await turnFor(sent, first)
  assert.equal(second.sessionId, rt.state.rooms[room.id].sessions[writer.id])
  assert.match(second.message.content[0].text, /You are this group's admin\. "@all" calls every member/)
  await answer(second.sessionId, second.message.source.exchangeId, 'Looks fine.', 2)
  await next
})

test('without the Main Bot in the group, the admin takes plain messages as before', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const editor = (await call('create-bot', { name: 'Editor' })).value
  const room = (await call('create-room', { name: 'R2', members: [writer.id, editor.id], admin: editor.id })).value
  await call('update-room', { id: room.id, mode: 'admin' })
  sent.length = 0
  await emit(room.id, userMessage('Status?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.equal(first.sessionId, rt.state.rooms[room.id].sessions[editor.id])
  assert.match(first.message.content[0].text, /Plain messages come to you first/)
  await answer(first.sessionId, first.message.source.exchangeId, 'All good.', 1)
  await running
})
