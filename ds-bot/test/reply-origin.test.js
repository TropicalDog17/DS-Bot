import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import './harness-resolve.mjs'
import { createReplyOrigin } from '../src/host/reply-origin.js'

const { startSwitchHarness } = await import('./im-fixture.js')

const chat = { key: 'dm-u1', kind: 'direct', title: 'U1' }
const sender = { id: 'u1', name: 'U1' }
const complete = { reason: { kind: 'completed' } }
const text = value => [{ type: 'text', text: value }]
const say = (s, id, value) => s.emitEvent(id, 'assistant/message', { message: { content: text(value) } })
const sent = async (s) => {
  await s.flush()
  return s.fake.sent.map(job => [job.chat.key, job.text])
}

async function askOnTelegram(s, value, from = { chat, sender }) {
  await s.fake.handlers.onMessage({ ...from, text: value })
  const { requestId, sessionId } = s.prompts.at(-1)
  assert.match(requestId, /^im:telegram:/)
  assert.equal(sessionId, 'a')
  const message = { source: { kind: 'user', rpcId: requestId }, content: text(value) }
  s.emitEvent('a', 'turn/start', { turn: 1 })
  s.emitEvent('a', 'user/message', message)
  return message
}

async function dispatch(s, when = 'now') {
  const tool = s.rt.teamTools.find(definition => definition.name === 'message_bot')
  const receipt = await tool.execute({ to: 'Writer', message: 'Write the docs', reply_to: 'user', when }, { agent: s.agentOf('a') })
  assert.match(receipt, /Its reply will arrive later as a new message/)
  const [method, request] = s.agentOf('b').calls.at(-1)
  assert.equal(method, when === 'queue' ? 'followup' : 'steer')
  return request
}

const completeTurn = (s, id, turn) => s.emitEvent(id, 'turn/end', { turn, ...complete })

async function answerDispatch(s, request) {
  completeTurn(s, 'a', 1)
  s.emitEvent('b', 'turn/start', { turn: 1 })
  s.emitEvent('b', 'user/message', request)
  say(s, 'b', 'The docs are ready.')
  completeTurn(s, 'b', 1)
  await s.waitHandoff(() => 'a')
  const reply = s.agentOf('a').inbox.nextTurn.shift()
  assert.equal(reply.source.role, 'reply')
  assert.equal(reply.source.replyTo, request.source.exchangeId)
  return reply
}

test('a Dispatch from an IM turn comes back to the IM chat', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'Please write the docs')
  const request = await dispatch(s)
  const reply = await answerDispatch(s, request)

  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', reply)
  say(s, 'a', 'Writer finished the docs.')
  completeTurn(s, 'a', 2)
  assert.deepEqual(await sent(s), [['dm-u1', 'Writer finished the docs.']])
})

test("an IM turn's Dispatch carries the origin to the peer's answer", async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'Please queue the docs')
  const request = await dispatch(s, 'queue')
  const { imOrigin } = s.rt.state.works[request.source.exchangeId]
  assert.equal(typeof imOrigin, 'string')
  assert.equal(request.source.imOrigin, undefined)

  const reply = await answerDispatch(s, request)
  assert.equal(reply.source.imOrigin, imOrigin)
  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', reply)
  say(s, 'a', 'First answer.')
  completeTurn(s, 'a', 2)

  s.emitEvent('a', 'turn/start', { turn: 3 })
  s.emitEvent('a', 'user/message', reply)
  say(s, 'a', 'Replayed answer.')
  completeTurn(s, 'a', 3)
  assert.deepEqual(await sent(s), [['dm-u1', 'First answer.']])
})

test('queued Dispatches join only when their replies go to the same chat', async (t) => {
  const s = await startSwitchHarness(t)
  s.rt.state.im.connections[s.conn.id].paired.push({ id: 'u2', name: 'U2' })
  await s.rt.save()
  await askOnTelegram(s, 'Please queue the docs')
  const first = await dispatch(s, 'queue')
  const sameChat = await dispatch(s, 'queue')
  assert.equal(sameChat.source.exchangeId, first.source.exchangeId)
  completeTurn(s, 'a', 1)

  await askOnTelegram(s, 'Please queue the docs for me too', {
    chat: { ...chat, key: 'dm-u2' }, sender: { id: 'u2', name: 'U2' },
  })
  const otherChat = await dispatch(s, 'queue')
  assert.notEqual(otherChat.source.exchangeId, first.source.exchangeId)
  assert.deepEqual(s.agentOf('b').inbox.nextTurn.map(message => message.source.exchangeId), [
    first.source.exchangeId, otherChat.source.exchangeId,
  ])
})

test('a Part switch keeps the IM origin on the fresh part', async (t) => {
  const note = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
    .map(heading => `## ${heading}\n- Continue the task from Telegram.`).join('\n\n')
  const stream = function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: note } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const s = await startSwitchHarness(t, { stream })
  const message = await askOnTelegram(s, 'Run a long task')
  assert.equal((await s.preStep('a', [message], 1)).kind, 'enter')
  s.tokens.set('a', 195_000)
  assert.equal((await s.preStep('a', [], 2)).kind, 'reject')
  s.emitEvent('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'pre-step' } } })

  const fresh = await s.waitHandoff(() => {
    const sessionId = s.rt.chatOf('a')
    return sessionId === 'a' ? undefined : sessionId
  })
  const handoff = s.agentOf(fresh).inbox.nextTurn.shift()
  assert.equal(s.rt.botOf('a').segments.at(-1).note, note)
  assert.ok(handoff.content.some(block => block.text?.includes(note)))
  s.emitEvent(fresh, 'turn/start', { turn: 1 })
  assert.equal((await s.preStep(fresh, [handoff], 1)).kind, 'enter')
  s.emitEvent(fresh, 'user/message', handoff)
  say(s, fresh, 'Finished on the fresh part.')
  completeTurn(s, fresh, 1)
  assert.deepEqual(await sent(s), [['dm-u1', 'Finished on the fresh part.']])
})

test('a web reply after the IM turn ends stays in the app', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'First question')
  say(s, 'a', 'Telegram answer.')
  completeTurn(s, 'a', 1)
  say(s, 'a', 'Output after turn end.')

  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'web:1' }, content: text('Second question') })
  say(s, 'a', 'Web answer.')
  completeTurn(s, 'a', 2)
  assert.deepEqual(await sent(s), [['dm-u1', 'Telegram answer.']])
})

const conn = { id: 'telegram', chats: { [chat.key]: chat } }
const claim = { connId: conn.id, chatKey: chat.key, senderId: sender.id }

function originFixture(sessions = new Set(['a', 'b']), now = Date.now) {
  return createReplyOrigin({
    now,
    connections: () => ({ [conn.id]: conn }),
    runners: new Map([[conn.id, {}]]),
    paired: (_conn, id) => id === sender.id,
    bindingOf: (_conn, key) => key === chat.key ? 'bot:a' : undefined,
    chatOfBot: id => id,
    sessionExists: id => sessions.has(id),
  })
}

const originMessage = source => ({ type: 'user/message', seq: 5, data: { source } })
const replyWith = imOrigin => originMessage({ kind: 'bot', role: 'reply', imOrigin })
const route = { conn, chatKey: chat.key, chat }

test('context neither claims nor withdraws the IM origin', () => {
  const origin = originFixture()
  origin.rememberRequest('im:telegram:1', conn, chat.key, sender.id)
  for (const form of ['snapshot', 'catalog', 'instructions', 'notice']) {
    origin.onEvent('a', originMessage({ form, rpcId: 'im:telegram:1' }))
    assert.equal(origin.of('a'), undefined)
  }
  origin.onEvent('a', originMessage({ kind: 'user', rpcId: 'im:telegram:1' }))
  assert.deepEqual(origin.viaView(), { a: { 5: 'telegram' } })
  for (const form of ['snapshot', 'catalog', 'instructions', 'notice']) {
    origin.onEvent('a', originMessage({ form }))
    assert.deepEqual(origin.of('a'), route)
  }
})

test('claim, drop, hold, carry and release follow the turn lifecycle', () => {
  const origin = originFixture()
  assert.ok(Object.isFrozen(origin))
  origin.claim('a', claim)
  assert.deepEqual(origin.of('a'), route)
  const released = origin.hold('a')
  origin.release(released)
  origin.peek('b', released)
  assert.equal(origin.of('b'), undefined)

  const invalidated = origin.carry('a')
  origin.drop('a')
  origin.claim('a', claim)
  assert.equal(origin.of('a'), undefined)
  origin.onEvent('b', replyWith(invalidated))
  assert.equal(origin.of('b'), undefined)

  origin.reset('a')
  origin.reset('b')
  origin.claim('a', claim)
  const carried = origin.carry('a')
  origin.detach('a')
  origin.drop('a')
  origin.onEvent('b', replyWith(carried))
  assert.deepEqual(origin.of('b'), route)
})

test('a restart cannot redeem a persisted Dispatch token or an old request', () => {
  const origin = originFixture()
  origin.claim('a', claim)
  const carried = origin.carry('a')
  assert.equal(typeof carried, 'string')
  const restarted = originFixture()
  restarted.onEvent('a', replyWith(JSON.parse(JSON.stringify(carried))))
  assert.equal(restarted.of('a'), undefined)
  restarted.reset('a')
  restarted.onEvent('a', originMessage({ kind: 'user', rpcId: 'im:telegram:1' }))
  assert.equal(restarted.of('a'), undefined)
})

test('pending Dispatch tokens are bounded and require a Session that still belongs to the team', () => {
  const sessions = new Set(['a', 'b'])
  const origin = originFixture(sessions)
  origin.claim('a', claim)
  const first = origin.carry('a')
  let last
  for (let index = 0; index < 256; index += 1) last = origin.carry('a')

  origin.onEvent('b', replyWith(first))
  assert.equal(origin.of('b'), undefined)
  origin.reset('b')
  origin.onEvent('b', replyWith(last))
  assert.deepEqual(origin.of('b'), route)

  origin.reset('b')
  const gone = origin.carry('a')
  sessions.delete('a')
  origin.onEvent('b', replyWith(gone))
  assert.equal(origin.of('b'), undefined)
})

function readPeerReply(s, reply, value, turn = 2) {
  s.emitEvent('a', 'turn/start', { turn })
  s.emitEvent('a', 'user/message', reply)
  say(s, 'a', value)
  completeTurn(s, 'a', turn)
}

test('redeeming a carry twice sends to Telegram only once', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'Finish the docs')
  const reply = await answerDispatch(s, await dispatch(s))
  readPeerReply(s, reply, 'First read.')
  assert.deepEqual(await sent(s), [['dm-u1', 'First read.']])
  readPeerReply(s, reply, 'Replay.', 3)
  assert.deepEqual(await sent(s), [['dm-u1', 'First read.']])
})

test('an unknown or evicted token cannot claim an IM chat', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'Finish the docs')
  const first = s.rt.replyOrigin.carry('a')
  for (let i = 0; i < 256; i += 1) s.rt.replyOrigin.carry('a')
  completeTurn(s, 'a', 1)
  for (const [i, token] of ['unknown', first].entries()) {
    const reply = { source: { kind: 'bot', role: 'reply', imOrigin: token }, content: text('A peer reply') }
    const turn = i + 2
    s.emitEvent('a', 'turn/start', { turn })
    s.emitEvent('a', 'user/message', reply)
    assert.equal(s.rt.replyOrigin.of('a'), undefined)
    say(s, 'a', 'Keep this in the app.')
    completeTurn(s, 'a', turn)
  }
  assert.deepEqual(await sent(s), [])
})

test('a Dispatch for the target Bot to answer the user carries no origin', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'First question')
  completeTurn(s, 'a', 1)
  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'web:1' }, content: text('Ask Writer directly') })
  const tool = s.rt.teamTools.find(definition => definition.name === 'message_bot')
  await tool.execute({ to: 'Writer', message: 'Answer in your chat', reply_to: 'user' }, { agent: s.agentOf('a') })
  const request = s.agentOf('b').inbox.nextTurn.shift()
  assert.equal(request.source.audience, 'user')
  assert.equal(request.source.imOrigin, undefined)
  assert.equal(s.rt.state.works[request.source.exchangeId], undefined)
  s.emitEvent('b', 'turn/start', { turn: 1 })
  s.emitEvent('b', 'user/message', request)
  say(s, 'b', 'Writer answers the web user.')
  completeTurn(s, 'b', 1)
  assert.deepEqual(await sent(s), [])
})

test('a new host sends the reply to persisted Dispatch work to the original chat', async (t) => {
  const first = await startSwitchHarness(t)
  await askOnTelegram(first, 'Finish after a restart')
  const request = await dispatch(first, 'queue')
  completeTurn(first, 'a', 1)
  await first.flush()
  const state = JSON.parse(await readFile(join(first.home, 'state.json'), 'utf8'))
  const token = state.works[request.source.exchangeId].imOrigin
  assert.equal(typeof token, 'string')
  await first.stop()

  const restarted = await startSwitchHarness(t, { home: first.home })
  assert.notEqual(restarted.rt.replyOrigin, first.rt.replyOrigin)
  const reply = await answerDispatch(restarted, request)
  assert.equal(reply.source.imOrigin, token)
  await restarted.flush()
  await restarted.stop()

  const receiver = await startSwitchHarness(t, { home: first.home })
  readPeerReply(receiver, reply, 'Writer finished after restart.')
  assert.deepEqual(await sent(receiver), [['dm-u1', 'Writer finished after restart.']])
  await receiver.stop()

  const replay = await startSwitchHarness(t, { home: first.home })
  readPeerReply(replay, reply, 'The same answer was already sent.')
  assert.deepEqual(await sent(replay), [])
  await replay.stop()
})

test('a hold followed by turn end cannot send a later web reply', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'First question')
  const held = s.rt.replyOrigin.hold('a')
  assert.equal(typeof held, 'string')
  say(s, 'a', 'Telegram answer.')
  completeTurn(s, 'a', 1)
  s.emitEvent('a', 'turn/start', { turn: 2 })
  s.emitEvent('a', 'user/message', { source: { kind: 'user', rpcId: 'web:1' }, content: text('Web question') })
  say(s, 'a', 'Web answer.')
  completeTurn(s, 'a', 2)
  s.rt.replyOrigin.release(held)
  assert.deepEqual(await sent(s), [['dm-u1', 'Telegram answer.']])
})

test('two failed reply deliveries release the carry', async (t) => {
  const s = await startSwitchHarness(t)
  await askOnTelegram(s, 'Finish the docs')
  const request = await dispatch(s)
  const { imOrigin } = s.rt.state.works[request.source.exchangeId]
  const attempted = []
  t.mock.method(s.rt, 'deliver', async (reply) => {
    attempted.push(reply)
    throw new Error('the reply inbox is unavailable')
  })
  completeTurn(s, 'a', 1)
  s.emitEvent('b', 'turn/start', { turn: 1 })
  s.emitEvent('b', 'user/message', request)
  say(s, 'b', 'The docs are ready.')
  completeTurn(s, 'b', 1)
  await s.flush()
  assert.equal(attempted.length, 2)
  assert.deepEqual(attempted.map(reply => reply.imOrigin), [imOrigin, imOrigin])
  readPeerReply(s, {
    source: { kind: 'bot', role: 'reply', imOrigin, replyTo: request.source.exchangeId },
    content: text('Late duplicate'),
  }, 'Keep it here.')
  assert.deepEqual(await sent(s), [])
})

test('unadmitted IM requests are evicted at the cap and expire', () => {
  let now = 0
  const origin = originFixture(new Set(['a']), () => now)
  for (let i = 0; i <= 256; i += 1) origin.rememberRequest(`im:telegram:${i}`, conn, chat.key, sender.id)
  const admit = i => {
    origin.reset('a')
    origin.onEvent('a', originMessage({ kind: 'user', rpcId: `im:telegram:${i}` }))
    return origin.of('a')
  }
  assert.equal(admit(0), undefined)
  assert.deepEqual(admit(256), route)
  now += 25 * 60 * 60 * 1000
  assert.equal(admit(255), undefined)
  origin.rememberRequest('im:telegram:new', conn, chat.key, sender.id)
  assert.deepEqual(admit('new'), route)
})
