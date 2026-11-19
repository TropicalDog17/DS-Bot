// An approval the user does not see where it opened reaches the Bot the user talks to:
// the Bot that gave the waiting Bot its work at once, the Main Bots once it stays open.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { install } from '../src/host/approvals.js'
import { APPROVAL_REMIND_MS } from '../src/host/constants.js'

const bots = {
  chief: { id: 'chief', name: 'Chief' },
  maid: { id: 'maid', name: 'TropMaid' },
  writer: { id: 'writer', name: 'Writer' },
}

function host({ info, works = {}, mainBotIds = ['chief'] } = {}) {
  const listeners = new Map()
  const disposers = []
  const sent = []
  const rt = {
    ctx: {
      on(name, listener) { listeners.set(name, listener) },
      effect(execute) { disposers.push(execute()) },
    },
    state: { mainBotIds, works },
    chatOwners: new Map([['maid-chat', 'maid'], ['writer-chat', 'writer']]),
    groupOwners: new Map([['maid-group', { botId: 'maid', roomId: 'r1' }]]),
    live: new Map(info === undefined ? [] : [['maid-chat', { info }]]),
    botOf: id => bots[id],
    roomOf: id => (id === 'r1' ? { id: 'r1', name: 'Ops' } : undefined),
    workOf: entry => (entry.role === 'request' ? entry.exchangeId : entry.work),
    deliver: async (args) => { sent.push(args) },
    warn() {},
  }
  install(rt)
  // An approval request DSH would answer later; `controller` cancels it.
  const ask = (sessionId, { tool = 'bash', reason = 'rm -rf build' } = {}) => {
    const controller = new AbortController()
    void listeners.get('approval/request')(
      { agent: { session: { id: sessionId } }, toolName: tool, reason, signal: controller.signal },
      () => new Promise(() => {}),
    )
    return controller
  }
  return { rt, sent, ask, dispose: () => disposers.forEach(dispose => dispose?.()) }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('a Bot that asked for the work hears that its delegate waits for approval, once', async (t) => {
  const { sent, ask, dispose } = host({ info: { role: 'request', exchangeId: 'w1', senderSessionId: 'chief' } })
  t.after(dispose)
  ask('maid-chat')
  await tick()
  assert.equal(sent.length, 1)
  const [notice] = sent
  assert.deepEqual([notice.toId, notice.fromId, notice.role, notice.recordExchange], ['chief', 'maid', 'approval', false])
  assert.match(notice.text, /^TropMaid is waiting for the user's approval to run bash \(rm -rf build\)\. The user answers it in TropMaid's own chat\./)
  assert.match(notice.text, /Do not message TropMaid/)
})

test('work handed back to a delegate still names the Bot that asked for it', async (t) => {
  const { sent, ask, dispose } = host({ info: { role: 'reply', work: 'w1', senderSessionId: 'writer' }, works: { w1: { from: 'writer', to: 'maid' } } })
  t.after(dispose)
  ask('maid-chat')
  await tick()
  assert.deepEqual(sent.map(notice => notice.toId), ['writer'])
})

test('no notice for the user\'s own work, for group turns, or for a request cancelled at once', async (t) => {
  const own = host({ info: { role: 'user' } })
  t.after(own.dispose)
  own.ask('maid-chat')
  const group = host({ info: { role: 'request', exchangeId: 'w1', senderSessionId: 'chief' } })
  t.after(group.dispose)
  group.ask('maid-group')
  const cancelled = host({ info: { role: 'request', exchangeId: 'w1', senderSessionId: 'chief' } })
  t.after(cancelled.dispose)
  cancelled.ask('maid-chat').abort()
  await tick()
  assert.deepEqual([own.sent.length, group.sent.length, cancelled.sent.length], [0, 0, 0])
})

test('an approval still open after a while reaches each Main Bot once, skipping the Bots already told', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())
  const { sent, ask, dispose } = host({ info: { role: 'request', exchangeId: 'w1', senderSessionId: 'chief' }, mainBotIds: ['chief', 'writer', 'maid'] })
  t.after(dispose)
  ask('maid-chat')
  await tick()
  mock.timers.tick(APPROVAL_REMIND_MS - 1)
  assert.deepEqual(sent.map(notice => notice.toId), ['chief'])
  mock.timers.tick(1)
  mock.timers.tick(APPROVAL_REMIND_MS)
  assert.deepEqual(sent.map(notice => notice.toId), ['chief', 'writer'])
  assert.match(sent[1].text, /^TropMaid has waited 5 min for the user's approval to run bash/)
})

test('a group approval reminds the Main Bot with the group to answer it in', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())
  const { sent, ask, dispose } = host()
  t.after(dispose)
  ask('maid-group', { reason: '' })
  mock.timers.tick(APPROVAL_REMIND_MS)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /to run bash\. The user answers it in the group chat "Ops"\./)
})

test('an answered approval sends no reminder', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => mock.timers.reset())
  const { sent, ask, dispose } = host()
  t.after(dispose)
  ask('writer-chat').abort()
  mock.timers.tick(APPROVAL_REMIND_MS)
  assert.equal(sent.length, 0)
})
