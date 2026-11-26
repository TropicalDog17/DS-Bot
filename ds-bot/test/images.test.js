import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as imagesInstall, lastAssistantSeq, offloadTargets } from '../src/host/images.ts'
import { assembleLlmStream } from '../src/host/models.ts'

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})

test('image OCR retries transient TRANSPORT failures instead of caching a 2-minute failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let calls = 0
  const ctx = {
    on: () => () => {},
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Image: Retry banner.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    catalog: async () => [{ ref: 'deepseek-account/deepseek-flash', name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'] }],
    defaultRef: () => 'deepseek-account/deepseek-flash',
    isLocalAgentRef: () => false,
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)
  const [line] = await rt.imagesForGroup([{ attachmentId: 'sha256:abcdef1234567890', name: 'shot.png' }], 'g1')
  assert.equal(calls, 2)
  assert.match(line, /Image: Retry banner\./)
})

test('assembleLlmStream forwards lifetime disposal signal to in-flight streams and stops on disabled retry policies', async () => {
  const lifetime = new AbortController()
  let seenSignal
  const streaming = assembleLlmStream({
    llm: {
      async *stream(options) {
        seenSignal = options.signal
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'disposed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [], signal: AbortSignal.timeout(60_000) }, { signal: lifetime.signal })
  lifetime.abort()
  const aborted = await streaming
  assert.equal(seenSignal.aborted, true)
  assert.equal(aborted.finish.kind, 'aborted')

  let disabledCalls = 0
  const disabled = await assembleLlmStream({
    llm: {
      providerRetryPolicy: () => ({ mode: 'disabled', initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      async *stream() {
        disabledCalls += 1
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [] })
  assert.equal(disabledCalls, 1)
  assert.equal(disabled.finish.kind, 'error')
})

test('agent/pre-step offloads images already seen before the last assistant message and keeps newer tool images live', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-mid-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
  ]
  const messages = new Map([
    [events[0], { content: [{ type: 'image', attachment: { attachmentId: 'seen' } }] }],
    [events[1], { content: [{ type: 'text', text: 'checking screenshot' }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'unseen' } }] }],
  ])
  const appended = []
  let flushes = 0
  const session = {
    surface: { nodes: [0, 1, 2] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
    append: (type, data) => appended.push({ type, data }),
  }
  assert.equal(lastAssistantSeq(session), 1)
  assert.equal(lastAssistantSeq({ surface: { nodes: [0] }, eventAt: () => events[0] }), undefined)

  const listeners = new Map()
  const ctx = {
    on: (name, fn) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
      return () => {}
    },
    sessions: {
      messageProjections: [{ type: 'image/offload' }],
      flush: async () => { flushes += 1 },
    },
    llm: {},
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    isBotSession: id => id === 'bot-1',
    readOnly: () => undefined,
  }
  imagesInstall(rt)

  const preStep = listeners.get('agent/pre-step')?.[0]
  assert.ok(preStep)
  const result = await preStep({ agent: { id: 'bot-1', session }, step: 2, signal: new AbortController().signal }, async () => 'entered')
  assert.equal(result, 'entered')
  assert.equal(flushes, 1)
  assert.deepEqual(appended, [{ type: 'image/offload', data: { targets: [{ seq: 0, imageIndexes: [0] }] } }])
})

test('image OCR prefers backgroundModel when it supports images', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-bg-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const seen = []
  const ctx = {
    on: () => () => {},
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream(options) {
        seen.push(`${options.provider}/${options.model}`)
        yield { type: 'text-delta', index: 0, text: 'Image: Fast OCR.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    catalog: async () => [
      { ref: 'gateway/opus', name: 'Opus', input: ['text', 'image'] },
      { ref: 'gateway/flash', name: 'Flash', input: ['text', 'image'] },
    ],
    defaultRef: () => 'gateway/opus',
    backgroundModel: async () => 'gateway/flash',
    isLocalAgentRef: () => false,
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)
  const [line] = await rt.imagesForGroup([{ attachmentId: 'sha256:0123456789abcdef', name: 'bg.png' }], 'g1')
  assert.deepEqual(seen, ['gateway/flash'])
  assert.match(line, /read by Flash/)
})


