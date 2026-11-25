import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'
import { test } from 'node:test'
import { LATE_ANSWER, MESSAGE_INLINE_MAX } from '../src/host/constants.ts'
import {
  BLOCKING_CODES,
  CUT_OFF_EMPTY_NOTE,
  CUT_OFF_NOTE,
  createSettlement,
  cutOffText,
  failureLine,
  prematureCutOff,
  turnFailure,
  type LongAttachment,
  type ReplySource,
  type SettlementRuntime,
} from '../src/host/settlement.ts'

interface HarnessOptions {
  works?: Record<string, { imOrigin?: string }>
  rooms?: Record<string, { name?: string; sessions?: Record<string, string> }>
  bots?: Record<string, { name?: string; sessionId?: string; threads?: Record<string, { sessionId: string; segments?: Array<{ sessionId: string }> }> }>
  groupOwners?: Map<string, { roomId: string; botId: string }>
  selfMap?: Record<string, string>
  sendImpl?: (input: Record<string, unknown>) => Promise<unknown>
  ownsWork?: (botId: string | undefined, workId: string | undefined) => boolean
  workAsker?: (workId: string) => ReplySource | undefined
  waitsWork?: (workId: string) => boolean
  closeWork?: (exchangeId: string | undefined, name: string, text: string) => string | undefined
  abandonedWork?: (exchangeId: string | undefined) => unknown
  answerText?: (workId: string, reply: string, botName: string) => string
  attachLong?: (text: string, filename: string) => Promise<LongAttachment>
}

function makeHarness(options: HarnessOptions = {}) {
  const sent: Record<string, unknown>[] = []
  const forgotten: string[] = []
  const missed: Array<string | undefined> = []
  const released: Array<string | undefined> = []
  const held: Array<{ workId: string; text: string }> = []
  const failures: Record<string, unknown>[] = []
  const warnings: string[] = []
  const bots = options.bots ?? {
    a: { name: 'Chief', sessionId: 'a' },
    b: { name: 'Writer', sessionId: 'b' },
  }
  const rooms = options.rooms ?? {}
  const rt: SettlementRuntime = {
    state: { works: options.works ?? {} },
    groupOwners: options.groupOwners ?? new Map(),
    selfOf: id => options.selfMap?.[id] ?? id,
    botOf: id => (id === undefined ? undefined : bots[id]),
    roomOf: id => (id === undefined ? undefined : rooms[id]),
    warn: (template, ...args) => { warnings.push([template, ...args].join(' ')) },
    dispatch: {
      sendReply: async (input) => {
        sent.push(input)
        if (options.sendImpl !== undefined) return options.sendImpl(input)
        return undefined
      },
      forgetDelivery: (exchangeId) => { forgotten.push(exchangeId) },
    },
    replyOrigin: {
      release: (origin) => { released.push(origin) },
    },
    noteFailure: (entry) => { failures.push(entry) },
    workOf: source => (source === undefined ? undefined
      : source.role === 'request' && source.audience !== 'user' ? source.exchangeId : source.work),
    ownsWork: options.ownsWork ?? (() => false),
    workAsker: options.workAsker,
    waitsWork: options.waitsWork ?? (() => false),
    holdWork: (workId, text) => { held.push({ workId, text }) },
    answerText: options.answerText ?? ((_workId, reply) => reply),
    attachLong: options.attachLong,
    closeWork: options.closeWork,
    abandonedWork: options.abandonedWork,
    answerMissed: (exchangeId) => { missed.push(exchangeId) },
  }
  return { rt, settlement: createSettlement(rt), sent, forgotten, missed, released, held, failures, warnings }
}

test('turnFailure classifies AUTH redaction, 403 content audit, and wrapped usage limits', () => {
  const session = '502: {"code":"502","message":"claude-code: You\'ve hit your session limit · resets 7:10am (UTC)","type":"upstream_error"}'
  assert.deepEqual(turnFailure({ code: 'SERVER', status: 502, message: session }), { code: 'QUOTA', message: session, status: 502 })
  assert.equal(turnFailure({ code: 'INVALID_REQUEST', status: 400, message: 'Budget has been exceeded! Current cost: 50.03, Max budget: 50' }).code, 'QUOTA')
  assert.equal(turnFailure({ code: 'RATE_LIMIT', status: 429, message: 'gpt returned 429: The usage limit has been reached' }).code, 'QUOTA')
  assert.equal(BLOCKING_CODES.has('QUOTA'), true)
  assert.equal(turnFailure({ code: 'SERVER', status: 502, message: 'bad gateway' }).code, 'SERVER')
  assert.equal(turnFailure({ code: 'RATE_LIMIT', status: 429, message: 'slow down' }).code, 'RATE_LIMIT')
  assert.deepEqual(turnFailure({ code: 'AUTH', status: 401, message: 'usage limit' }), { code: 'AUTH', message: '', status: 401 })

  assert.deepEqual(turnFailure({ code: 'AUTH', status: 401, message: 'bad key sk-12***34' }), { code: 'AUTH', message: '', status: 401 })
  assert.deepEqual(turnFailure({ code: 'RATE_LIMIT', message: ' slow down ', requestId: 'r1' }), { code: 'RATE_LIMIT', message: 'slow down', requestId: 'r1' })
  assert.deepEqual(turnFailure(undefined), { code: 'UNKNOWN', message: '' })
  assert.equal(failureLine({ code: 'SERVER', status: 503, message: 'busy' }), 'SERVER 503: busy')

  const body = 'upstream 403 request-id=00000000-0000-4000-8000-000000000000: {"error":{"message":"内容审计命中风险规则，请调整输入后重试","type":"content_policy_violation"}}'
  assert.deepEqual(turnFailure({ code: 'AUTH', status: 403, message: body }), {
    code: 'CONTENT_POLICY',
    message: body,
    status: 403,
    requestId: '00000000-0000-4000-8000-000000000000',
  })
  assert.deepEqual(turnFailure({ code: 'AUTH', status: 403, message: 'forbidden' }), { code: 'AUTH', message: '', status: 403 })
  assert.equal(turnFailure({ code: 'AUTH', status: 403, message: body, requestId: 'r1' }).requestId, 'r1')
})

test('cutOffText and prematureCutOff handle empty, partial, and premature output cutoffs', () => {
  assert.equal(cutOffText(''), CUT_OFF_EMPTY_NOTE)
  assert.equal(cutOffText('partial'), `partial\n\n${CUT_OFF_NOTE}`)
  assert.equal(prematureCutOff({ outputTokens: 10, inputTokens: 9000 }, { maxTokens: 8192 }), true)
  assert.equal(prematureCutOff({ outputTokens: 2000, inputTokens: 9000 }, { maxTokens: 8192 }), false)
  assert.equal(prematureCutOff({ outputTokens: 10, inputTokens: 1000 }, { maxTokens: 8192 }), false)
})

test('settleDirect answers requester on success, failure, and abort while ignoring user-audience turns', () => {
  const h = makeHarness()
  const req: ReplySource = { kind: 'bot', role: 'request', exchangeId: 'x1', senderSessionId: 'a' }
  h.settlement.settleDirect('b', { ...req, audience: 'user' }, { reply: 'ignored' })
  h.settlement.settleDirect('b', { kind: 'bot', role: 'notice', exchangeId: 'x2', senderSessionId: 'a' }, { reply: 'ignored' })
  assert.equal(h.sent.length, 0)

  h.settlement.settleDirect('b', req, { reply: 'done' })
  h.settlement.settleDirect('b', req, { reply: '', failure: { code: 'SERVER', status: 503, message: 'down' } })
  h.settlement.settleDirect('b', req, { reply: '', aborted: true })

  assert.equal(h.sent.length, 3)
  assert.equal(h.sent[0].text, 'done')
  assert.match(String(h.sent[1].text), /Writer could not answer your message: its model call failed \(SERVER 503: down\)/)
  assert.equal(h.sent[2].text, 'Writer was stopped before it could answer your message.')
})

test('settle holds work waiting on children and attaches long replies above MESSAGE_INLINE_MAX', async () => {
  let waiting = true
  const asker: ReplySource = { kind: 'bot', role: 'request', exchangeId: 'w1', senderSessionId: 'a' }
  const big = 'x'.repeat(MESSAGE_INLINE_MAX + 10)
  const h = makeHarness({
    ownsWork: (botId, workId) => botId === 'b' && workId === 'w1',
    workAsker: workId => (workId === 'w1' ? asker : undefined),
    waitsWork: () => waiting,
    answerText: (_workId, reply) => reply,
    attachLong: async (text, filename) => ({ text: `preview:${filename}`, files: [{ name: filename }], length: text.length }),
  })

  await h.settlement.settle('b', asker, { reply: 'partial answer' })
  assert.deepEqual(h.held, [{ workId: 'w1', text: 'partial answer' }])
  assert.equal(h.sent.length, 0)

  waiting = false
  await h.settlement.settle('b', asker, { reply: big })
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].text, 'preview:Answer from Writer.txt')
  assert.equal(h.sent[0].length, big.length)
  assert.deepEqual(h.sent[0].files, [{ name: 'Answer from Writer.txt' }])
})

test('answerSender prefixes late answers, routes to room/part target, and falls back on delivery failure', async () => {
  let attempts = 0
  const h = makeHarness({
    works: { w1: { imOrigin: 'im-1' } },
    rooms: { r1: { name: 'Ops', sessions: { a: 'room-a' } } },
    abandonedWork: () => ({ id: 'w1' }),
    sendImpl: async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('gone'), { code: 'session/not-found' })
      if (attempts === 2) throw new Error('still gone')
      return undefined
    },
  })

  const source: ReplySource = { kind: 'bot', role: 'request', exchangeId: 'w1', senderSessionId: 'a', senderRoomId: 'r1' }
  h.settlement.answerSender('b', source, 'finished')
  await flush()
  await flush()

  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[0].sessionId, 'room-a')
  assert.equal(h.sent[0].text, `${LATE_ANSWER}finished`)
  assert.equal(h.forgotten.length, 1)
  assert.deepEqual(h.missed, ['w1'])
  assert.match(String(h.sent[1].text), /Writer could not send its reply to you \(session\/not-found: gone\); what it had answered:\nfinished/)
  assert.deepEqual(h.released, ['im-1'])
})

test('recordCutOff logs MAX_TOKENS diagnostic with facts and place', () => {
  const h = makeHarness({
    rooms: { r1: { name: 'Design' } },
    groupOwners: new Map([['gb', { roomId: 'r1', botId: 'b' }]]),
    selfMap: { gb: 'b' },
  })
  h.settlement.recordCutOff('gb', { wroteNothing: true, ref: 'openai/gpt-5', tokensIn: 12000, outputTokens: 0 })
  assert.equal(h.failures.length, 1)
  assert.deepEqual(h.failures[0], {
    level: 'warn',
    source: 'turn',
    code: 'MAX_TOKENS',
    text: 'the turn was cut off at the output limit before it wrote anything (openai/gpt-5, 12000 tokens in, 0 tokens out)',
    bot: 'Writer',
    where: 'group "Design"',
    sessionId: 'gb',
  })
})
