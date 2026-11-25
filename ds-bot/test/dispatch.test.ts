import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDispatch, type DispatchDeps, type ExchangeRecord, type InboxMessage, type ResolvedAgent, type SavedDelivery } from '../src/host/dispatch.ts'

interface FakeAgent extends ResolvedAgent {
  calls: Array<['steer' | 'followup', { content: Array<{ type: string; text?: string; attachment?: unknown }>; source: Record<string, unknown> }]>
  inbox: {
    nextStep: InboxMessage[]
    nextTurn: InboxMessage[]
    remove: (id: string | undefined) => boolean
  }
}

function makeFixture(overrides: Partial<DispatchDeps> = {}) {
  const state: DispatchDeps['state'] = {
    bots: {
      a: { id: 'a', name: 'Chief', sessionId: 'a', segments: [] },
      b: { id: 'b', name: 'Writer', sessionId: 'b', segments: [] },
      c: { id: 'c', name: 'Tester', sessionId: 'c', segments: [] },
    },
    rooms: {
      r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], sessionId: 'r1-cur', sessions: { a: 'ga', b: 'gb' } },
    },
    exchanges: [],
    works: {},
    requests: {},
  }
  const agents = new Map<string, FakeAgent>()
  const prompts: Array<{ requestId: string; sessionId: string; mode: 'steer' | 'queue'; content: unknown[] }> = []
  const books = new Map<string, ExchangeRecord[]>()
  const queued: Array<{ sessionId: string; args: SavedDelivery }> = []
  const forgotten: string[] = []
  const droppedWorks: string[] = []
  const openedWorks: Array<{ id: string; info: Record<string, unknown> }> = []
  const running = new Set<string>()
  const pastOwners = new Map<string, { botId?: string; roomId?: string }>()
  let carriedToken: string | undefined
  let matchesCarryResult = true
  let saveError: Error | undefined
  let readOnlyReason: string | undefined
  let nextMsgId = 0

  const agentOf = (sessionId: string): FakeAgent => {
    let agent = agents.get(sessionId)
    if (agent === undefined) {
      const nextStep: InboxMessage[] = []
      const nextTurn: InboxMessage[] = []
      const calls: FakeAgent['calls'] = []
      agent = {
        session: { id: sessionId },
        calls,
        steer(message: unknown) {
          const msg = { id: `m-${++nextMsgId}`, ...(message as Record<string, unknown>) }
          calls.push(['steer', msg as never])
          nextStep.push(msg as InboxMessage)
        },
        followup(message: unknown) {
          const msg = { id: `m-${++nextMsgId}`, ...(message as Record<string, unknown>) }
          calls.push(['followup', msg as never])
          nextTurn.push(msg as InboxMessage)
        },
        inbox: {
          nextStep,
          nextTurn,
          remove(id: string | undefined) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(item => item.id === id)
              if (at !== -1) { list.splice(at, 1); return true }
            }
            return false
          },
        },
      }
      agents.set(sessionId, agent)
    }
    return agent
  }

  let flushImpl: () => Promise<void> = async () => {}
  const ctx: DispatchDeps['ctx'] = {
    sessionController: {
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      prompt: async input => { prompts.push(input) },
    },
    sessions: { flush: () => flushImpl() },
    get: () => undefined,
  }

  const dispatch = createDispatch({
    state,
    ctx,
    ledger: {
      importer() {},
      records: book => books.get(book) ?? [],
      append: (book, record) => {
        const list = books.get(book) ?? []
        list.push(record)
        books.set(book, list)
      },
      written: async () => {},
    },
    botOf: id => (id !== undefined && Object.hasOwn(state.bots, id) ? state.bots[id] : undefined),
    roomOf: id => (id !== undefined && Object.hasOwn(state.rooms, id) ? state.rooms[id] : undefined),
    chatOf: botId => state.bots[botId]?.sessionId ?? botId,
    sessionOfRoom: room => room?.sessionId ?? room?.id,
    pastOwnerOf: sessionId => pastOwners.get(sessionId),
    own: (obj, key) => (obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined),
    isRunning: sessionId => running.has(sessionId),
    hideBotUnusedTools() {},
    ensureCapabilities: async () => {},
    eventsBackwards: async function* () {},
    openWork(exchangeId, info) {
      state.works![exchangeId] = info
      openedWorks.push({ id: exchangeId, info: info as Record<string, unknown> })
    },
    dropWork(exchangeId) {
      delete state.works![exchangeId]
      droppedWorks.push(exchangeId)
    },
    sameWork: (exchangeId, work) => (exchangeId !== undefined ? state.works?.[exchangeId]?.parent === work : false),
    carryOrigin: () => carriedToken,
    matchesCarry: () => matchesCarryResult,
    readOnly: () => readOnlyReason,
    save: async () => { if (saveError) throw saveError },
    warn() {},
    ...overrides,
  })

  dispatch.attachOutbox({
    queue(sessionId, args) { queued.push({ sessionId, args }) },
    forget(exchangeId) { forgotten.push(exchangeId) },
  })

  return {
    state,
    ctx,
    dispatch,
    agents,
    agentOf,
    prompts,
    books,
    queued,
    forgotten,
    openedWorks,
    droppedWorks,
    running,
    pastOwners,
    setCarriedToken: (token: string | undefined) => { carriedToken = token },
    setMatchesCarry: (value: boolean) => { matchesCarryResult = value },
    setSaveError: (err: Error | undefined) => { saveError = err },
    setReadOnly: (reason: string | undefined) => { readOnlyReason = reason },
    setFlush: (fn: () => Promise<void>) => { flushImpl = fn },
  }
}

test('sendBotRequest enforces idempotency: replay, conflict, concurrent calls, expiry, readonly, and failure uncertainty', async () => {
  const f = makeFixture()

  const first = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'do the thing', text: 'do the thing',
    requestName: 'r-1', formatReceipt: () => 'Delivered once',
  })
  assert.equal(first.status, 'sent')
  if (first.status !== 'sent') return
  assert.equal(first.receipt, 'Delivered once')
  assert.equal(f.agentOf('b').calls.length, 1)

  // Replay returns the stored receipt without sending again.
  const replay = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'do the thing', text: 'do the thing',
    requestName: 'r-1', formatReceipt: () => 'Should not run',
  })
  assert.deepEqual(replay, { status: 'replay', receipt: 'Delivered once' })
  assert.equal(f.agentOf('b').calls.length, 1)

  // Same requestName with different content or target conflicts.
  const conflict = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'other thing', text: 'other thing',
    requestName: 'r-1', formatReceipt: () => 'no',
  })
  assert.deepEqual(conflict, { status: 'conflict' })

  // Old receipts survive volume and age; an expired receipt still blocks resending.
  const key = Object.keys(f.state.requests!)[0]
  f.state.requests![key].at = 0
  f.state.requests![key].receipt = undefined
  const expired = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'do the thing', text: 'do the thing',
    requestName: 'r-1', formatReceipt: () => 'no',
  })
  assert.deepEqual(expired, { status: 'expired' })

  // Concurrent calls with the same requestName admit only once.
  const [c1, c2] = await Promise.all([
    f.dispatch.sendBotRequest({ fromId: 'a', toId: 'b', rawMessage: 'race', text: 'race', requestName: 'r-race', formatReceipt: () => 'one' }),
    f.dispatch.sendBotRequest({ fromId: 'a', toId: 'b', rawMessage: 'race', text: 'race', requestName: 'r-race', formatReceipt: () => 'two' }),
  ])
  assert.equal(c1.status, 'sent')
  assert.deepEqual(c2, { status: 'replay', receipt: 'one' })

  // Readonly host refuses named requests without sending.
  f.setReadOnly('another window owns the team')
  const ro = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'ro', text: 'ro', requestName: 'r-ro', formatReceipt: () => 'no',
  })
  assert.deepEqual(ro, { status: 'readonly' })
  f.setReadOnly(undefined)

  // Failed delivery leaves outcome uncertain so retries do not duplicate side effects.
  f.setFlush(async () => { throw new Error('dsh down') })
  await assert.rejects(f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'fail', text: 'fail', requestName: 'r-fail', formatReceipt: () => 'no',
  }), /dsh down/)
  f.setFlush(async () => {})
  const uncertain = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'fail', text: 'fail', requestName: 'r-fail', formatReceipt: () => 'no',
  })
  assert.deepEqual(uncertain, { status: 'uncertain' })
})

test('sendBotRequest coalesces unread inbox requests, forgets prior outbox entry, and preserves ledger on failed merge', async () => {
  const f = makeFixture()
  f.running.add('b')

  const first = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'Draft the plan', text: 'Draft the plan',
    formatReceipt: ({ joined }) => (joined ? 'merged' : 'first'),
  })
  assert.equal(first.status, 'sent')
  if (first.status !== 'sent') return
  assert.equal(first.joined, false)

  // A second request while the first is unread in inbox joins under the same exchangeId.
  const second = await f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'Add budget', text: 'Add budget',
    formatReceipt: ({ joined }) => (joined ? 'merged' : 'second'),
  })
  assert.equal(second.status, 'sent')
  if (second.status !== 'sent') return
  assert.equal(second.joined, true)
  assert.equal(second.exchangeId, first.exchangeId)
  assert.deepEqual(f.forgotten, [first.exchangeId])
  assert.equal(f.agentOf('b').inbox.nextStep.length, 1)

  // If a subsequent merged send fails before flush, the pair ledger keeps the previously delivered text.
  f.setFlush(async () => { throw new Error('Session is gone') })
  await assert.rejects(f.dispatch.sendBotRequest({
    fromId: 'a', toId: 'b', rawMessage: 'Lost edit', text: 'Lost edit',
    formatReceipt: () => 'never',
  }), /Session is gone/)
  assert.deepEqual(
    f.dispatch.exchangesOf('a', 'b').map(entry => [entry.id, entry.text]),
    [[first.exchangeId, 'Draft the plan\n\nAdd budget']],
  )
})

test('sendBotRequest rolls back opened work when persisting imOrigin fails', async () => {
  const f = makeFixture()
  f.setCarriedToken('tok-im-1')
  f.setSaveError(new Error('disk full'))

  await assert.rejects(f.dispatch.sendBotRequest({
    fromId: 'a', fromSessionId: 'a', toId: 'b', rawMessage: 'check status', text: 'check status',
    formatReceipt: () => 'ok',
  }), /disk full/)

  assert.equal(f.openedWorks.length, 1)
  assert.deepEqual(f.droppedWorks, [f.openedWorks[0].id])
  assert.equal(f.agentOf('b').calls.length, 0)
})

test('admitGroupRequest deduplicates named group Dispatches separately from direct chats', async () => {
  const f = makeFixture()
  let runs = 0
  const run = async () => { runs += 1; return `called-${runs}` }

  const first = await f.dispatch.admitGroupRequest({ caller: 'a', roomId: 'r1', name: 'g-1', payload: { to: 'b', message: 'go' } }, run)
  assert.deepEqual(first, { status: 'sent', receipt: 'called-1' })

  const replay = await f.dispatch.admitGroupRequest({ caller: 'a', roomId: 'r1', name: 'g-1', payload: { to: 'b', message: 'go' } }, run)
  assert.deepEqual(replay, { status: 'replay', receipt: 'called-1' })
  assert.equal(runs, 1)
})

test('sendReply, sendGroupTurn, sendNotice, and resend route through the outbox seam without double-queueing resends', async () => {
  const f = makeFixture()

  await f.dispatch.sendReply({ fromId: 'b', toId: 'a', replyTo: 'ex-1', text: 'All done', imOrigin: 'tok-1' })
  await f.dispatch.sendGroupTurn({ toId: 'b', sessionId: 'gb', roomId: 'r1', note: 'new message', text: 'Check CI', requests: ['req-9'] })
  await f.dispatch.sendNotice({ toId: 'b', role: 'wake', note: 'herdr pane w1:p1 · done', text: 'Build passed' })

  assert.equal(f.queued.length, 3)
  assert.equal(f.queued[0].args.imOrigin, 'tok-1')
  assert.deepEqual(f.queued[1].args.requests, ['req-9'])
  assert.equal(f.queued[2].args.recordExchange, false)

  // Resending a persisted outbox entry delivers with resent: true and never re-queues it.
  const saved = f.queued[0].args
  await f.dispatch.resend(saved)
  assert.equal(f.queued.length, 3)
  const resentCall = f.agentOf('a').calls.at(-1)!
  assert.equal(resentCall[0], 'followup')
  assert.match(resentCall[1].content[0].text ?? '', /DeepSeek Harness restarted before it could reach you/)
})

test('sendUser resolves Bot ids, past Parts, and rooms to their current Session and forwards steer mode', async () => {
  const f = makeFixture()
  f.state.bots.a.sessionId = 'a-part-2'
  f.state.bots.a.segments = [{ sessionId: 'a-part-1' }]
  f.pastOwners.set('a-part-1', { botId: 'a' })
  f.pastOwners.set('r1-old', { roomId: 'r1' })

  await f.dispatch.sendUser({ sessionId: 'a', content: [{ type: 'text', text: 'hi' }], requestId: 'u1' })
  await f.dispatch.sendUser({ sessionId: 'a-part-1', content: [{ type: 'text', text: 'past' }], requestId: 'u2', steer: true })
  await f.dispatch.sendUser({ sessionId: 'r1', content: [{ type: 'text', text: 'group' }], requestId: 'u3' })
  await f.dispatch.sendUser({ sessionId: 'r1-old', content: [{ type: 'text', text: 'old group' }], requestId: 'u4' })

  assert.deepEqual(
    f.prompts.map(p => [p.sessionId, p.mode, p.requestId]),
    [
      ['a-part-2', 'queue', 'u1'],
      ['a-part-2', 'steer', 'u2'],
      ['r1-cur', 'queue', 'u3'],
      ['r1-cur', 'queue', 'u4'],
    ],
  )
})
