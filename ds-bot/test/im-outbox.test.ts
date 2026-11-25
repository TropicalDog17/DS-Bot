import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'
import { test } from 'node:test'
import { createImOutbox, SEND_ATTEMPTS, type ImChat, type ImSendHandle } from '../src/host/im/outbox.ts'

const CHAT_A: ImChat = { key: 'chat-a', kind: 'direct', title: 'A' }
const CHAT_B: ImChat = { key: 'chat-b', kind: 'direct', title: 'B' }

function makeOutbox(overrides: {
  live?: Set<string>
  stopped?: () => boolean
  readFile?: (path: string, limit: number) => Promise<Buffer | undefined>
} = {}) {
  const live = overrides.live ?? new Set(['c1'])
  const warnings: string[] = []
  const outbox = createImOutbox({
    isLive: id => live.has(id),
    isStopped: overrides.stopped ?? (() => false),
    redact: text => text.replaceAll('SECRET-TOK', '***'),
    warn: (template, ...args) => { warnings.push([template, ...args].join(' ')) },
    readFile: overrides.readFile ?? (async () => undefined),
    unavailableFileText: name => `${name} unavailable`,
  })
  return { outbox, live, warnings }
}

test('outbox queues jobs while connecting and drains in FIFO order once ready', async () => {
  const { outbox } = makeOutbox()
  const sent: string[] = []
  const afters: unknown[] = []
  const token = outbox.open('c1')
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'first', after: res => afters.push(res) })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'second' })
  assert.equal(sent.length, 0)

  const handle: ImSendHandle = {
    send: async (_chat, job) => {
      sent.push(String(job.text))
      return { messageId: sent.length }
    },
  }
  outbox.ready('c1', token, handle)
  await flush()

  assert.deepEqual(sent, ['first', 'second'])
  assert.deepEqual(afters, [{ messageId: 1 }])
})

test('outbox drops jobs when no lane exists or canSend returns false', async () => {
  const { outbox } = makeOutbox()
  let dropped = 0
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'orphan', onDrop: () => { dropped += 1 } })
  await flush()
  assert.equal(dropped, 1)

  const sent: string[] = []
  const token = outbox.open('c1')
  outbox.ready('c1', token, {
    send: async (_chat, job) => { sent.push(String(job.text)) },
  })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'blocked', canSend: () => false, onDrop: () => { dropped += 1 } })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'allowed', canSend: () => true })
  await flush()
  assert.equal(dropped, 2)
  assert.deepEqual(sent, ['allowed'])
})

test('outbox retries retryable errors with backoff, retains exhausted sends, and replays on retry()', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { outbox } = makeOutbox()
  const sent: string[] = []
  let failBudget = SEND_ATTEMPTS
  const token = outbox.open('c1')
  outbox.ready('c1', token, {
    send: async (_chat, job) => {
      sent.push(String(job.text))
      if (job.text === 'flaky' && failBudget > 0) {
        failBudget -= 1
        throw Object.assign(new Error('502 with SECRET-TOK'), { status: 502, retryAfter: 1 })
      }
      return { ok: true }
    },
  })

  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'flaky' })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'next' })
  await flush()

  const retrying = outbox.statusOf('c1', { state: 'ready', at: 1 })
  assert.equal(retrying?.state, 'retrying')
  assert.ok(!retrying?.error?.includes('SECRET-TOK'), 'error status redacts secrets')

  for (let i = 0; i < SEND_ATTEMPTS - 1; i += 1) {
    t.mock.timers.tick(1_000)
    await flush()
  }

  assert.equal(sent.filter(x => x === 'flaky').length, SEND_ATTEMPTS)
  assert.equal(sent.filter(x => x === 'next').length, 1, 'queue advances after exhausting retries')
  const errored = outbox.statusOf('c1', { state: 'ready', at: 1 })
  assert.equal(errored?.state, 'error')
  assert.match(errored?.error ?? '', /Send failed after 4 attempts/)

  outbox.retry('c1')
  await flush()
  assert.equal(sent.filter(x => x === 'flaky').length, SEND_ATTEMPTS + 1)
  assert.equal(outbox.statusOf('c1', { state: 'ready', at: 1 })?.state, 'ready')
})

test('outbox preserves ordering when an interrupted in-flight send rejects after reconnect and retry()', async () => {
  const { outbox } = makeOutbox()
  const sent: string[] = []
  let rejectInFlight!: (error: Error) => void

  const token1 = outbox.open('c1')
  outbox.ready('c1', token1, {
    send: async (_chat, job) => {
      if (job.text === 'first') {
        await new Promise<void>((_resolve, reject) => { rejectInFlight = reject })
      }
      sent.push(String(job.text))
    },
  })

  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'first' })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'second' })
  await flush()

  await outbox.detach('c1', { dropOnly: false })

  const token2 = outbox.open('c1')
  outbox.ready('c1', token2, {
    send: async (_chat, job) => { sent.push(String(job.text)) },
  })
  outbox.retry('c1')
  await flush()
  assert.deepEqual(sent, [], 'follower waits behind interrupted in-flight send')

  rejectInFlight(Object.assign(new Error('502 during reconnect'), { status: 502 }))
  await flush()
  await flush()
  assert.deepEqual(sent, ['first', 'second'])
  assert.equal(outbox.statusOf('c1', { state: 'ready', at: 1 })?.state, 'ready')
})

test('outbox clears retrying status when an interrupted single send drops on stop', async () => {
  const { outbox } = makeOutbox()
  let rejectInFlight!: (error: Error) => void

  const token1 = outbox.open('c1')
  outbox.ready('c1', token1, {
    send: async () => {
      await new Promise<void>((_resolve, reject) => { rejectInFlight = reject })
    },
  })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'only' })
  await flush()

  await outbox.detach('c1', { dropOnly: false })
  const token2 = outbox.open('c1')
  outbox.ready('c1', token2, { send: async () => {} })
  outbox.retry('c1')
  assert.equal(outbox.statusOf('c1', { state: 'ready', at: 1 })?.state, 'retrying')

  rejectInFlight(Object.assign(new Error('stopped'), { stopped: true }))
  await flush()
  assert.equal(outbox.statusOf('c1', { state: 'ready', at: 1 })?.state, 'ready')
})

test('outbox abortOpen drops unready jobs without clearing previously retained failed sends', async () => {
  const { outbox } = makeOutbox()
  const sent: string[] = []
  const token1 = outbox.open('c1')
  outbox.ready('c1', token1, {
    send: async () => { throw Object.assign(new Error('forbidden'), { status: 403, permanent: true }) },
  })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'retained' })
  await flush()
  assert.equal(outbox.statusOf('c1', { state: 'ready', at: 1 })?.state, 'error')

  await outbox.detach('c1', { dropOnly: false })
  const token2 = outbox.open('c1')
  let unreadyDropped = 0
  outbox.enqueue('c1', CHAT_B.key, { chat: CHAT_B, text: 'during-connect', onDrop: () => { unreadyDropped += 1 } })
  await outbox.abortOpen('c1', token2)
  assert.equal(unreadyDropped, 1)

  const token3 = outbox.open('c1')
  outbox.ready('c1', token3, { send: async (_chat, job) => { sent.push(String(job.text)) } })
  outbox.retry('c1')
  await flush()
  assert.deepEqual(sent, ['retained'])
})

test('outbox sends readable files via sendFile and falls back to text when unreadable or unsupported', async () => {
  const files: Array<{ name: string; content: string; caption?: string }> = []
  const texts: string[] = []
  const { outbox } = makeOutbox({
    readFile: async (path, limit) => (path.endsWith('ok.txt') && limit >= 4 ? Buffer.from('data') : undefined),
  })
  const token = outbox.open('c1')
  outbox.ready('c1', token, {
    fileLimit: 100,
    send: async (_chat, job) => { texts.push(String(job.text)) },
    sendFile: async (_chat, payload) => {
      files.push({ name: payload.name, content: payload.data.toString('utf8'), caption: payload.caption })
    },
  })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, file: { path: '/tmp/ok.txt', label: '', caption: 'cap' } })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, file: { path: '/tmp/big.bin', label: '[card] ' } })
  await flush()

  assert.deepEqual(files, [{ name: 'ok.txt', content: 'data', caption: 'cap' }])
  assert.deepEqual(texts, ['[card] big.bin unavailable'])
})

test('statusOf prioritizes adapter error/off over send status, and send error over adapter reconnecting', async () => {
  const { outbox } = makeOutbox()
  const token = outbox.open('c1')
  outbox.ready('c1', token, {
    send: async () => { throw Object.assign(new Error('bad chat'), { status: 400 }) },
  })
  outbox.enqueue('c1', CHAT_A.key, { chat: CHAT_A, text: 'boom' })
  await flush()

  assert.equal(outbox.statusOf('c1', { state: 'error', error: 'adapter down', at: 1 })?.error, 'adapter down')
  assert.equal(outbox.statusOf('c1', { state: 'off', at: 1 })?.state, 'off')
  assert.equal(outbox.statusOf('c1', { state: 'reconnecting', at: 1 })?.state, 'error')
  assert.deepEqual(outbox.statusIds(), ['c1'])

  outbox.remove('c1')
  assert.deepEqual(outbox.statusIds(), [])
})
