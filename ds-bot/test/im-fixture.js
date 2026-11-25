import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { adapters } from '../src/host/im/platforms/index.js'

// A platform adapter that records sends/edits and lets the test feed inbound
// messages, actions and statuses. `fail` makes send throw once per call queued.
export const fakeAdapter = ({ buttons = true, fileLimit } = {}) => {
  const sent = []
  const files = []
  const edited = []
  const typed = []
  const fails = []
  const adapter = {
    id: 'fake',
    sent,
    files,
    edited,
    typed,
    handlers: null,
    async check(fields) {
      if (fields.token === 'bad-token') throw new Error('platform refused the token')
      return { account: { id: 'bot1', name: '@fakebot' } }
    },
    connect(fields, env, handlers) {
      adapter.handlers = handlers
      adapter.env = env
      adapter.connects = (adapter.connects ?? 0) + 1
      handlers.onStatus({ state: 'ready', account: { id: 'bot1', name: '@fakebot' } })
      return {
        send: async (chat, body) => {
          sent.push({ chat, ...body })
          const next = fails.shift()
          if (next !== undefined) throw next
          return { messageId: sent.length }
        },
        // A file goes into `sent` too, so tests see it in order with the text around it.
        ...(fileLimit === undefined ? {} : {
          fileLimit,
          sendFile: async (chat, file) => {
            files.push({ chat, ...file })
            sent.push({ chat, file: file.name })
            return { messageId: sent.length }
          },
        }),
        edit: async (chat, messageId, body) => { edited.push({ chat, messageId, ...body }) },
        typing: async (chat) => { typed.push(chat) },
        stop: () => { adapter.stopped = (adapter.stopped ?? 0) + 1 },
      }
    },
  }
  adapter.fails = fails
  adapter.buttons = buttons
  return adapter
}

export const TEAM = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'everyone', admin: 'a', named: true, log: [], seq: 0 } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

export async function startSwitchHarness(t, { tokens = new Map([['a', 1_000]]), cwd = () => undefined, stream, home: existingHome } = {}) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'dsb-im-switch-'))
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  if (existingHome === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM(), workspace: work }))
  let created = 0
  let failCreate = false
  let idleGate
  let createGate
  const fake = fakeAdapter()
  const real = adapters.telegram
  adapters.telegram = fake
  const ctx = fakeContext({
    services: {
      tokenMeter: {
        measure: session => ({ totalTokens: tokens.get(session.id) ?? 0 }),
        estimateMessage: () => 50,
      },
    },
  })
  const prompts = []
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const nextStep = []
      const nextTurn = []
      const calls = []
      agents.set(id, {
        id,
        calls,
        status: 'idle',
        session: {
          id,
          seq: 1,
          header: { cwd: cwd(id) ?? work },
          requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }),
          deriveMessages: () => [],
          toolHistory: () => [],
        },
        followup(message) {
          this.lastFollowup = message
          this.followed = (this.followed ?? 0) + 1
          calls.push(['followup', message])
          nextTurn.push(message)
        },
        steer(message) { calls.push(['steer', message]); nextStep.push(message) },
        inject(message) { calls.push(['inject', message]); nextStep.push(message) },
        send(message, target) { (target === 'next-turn' ? nextTurn : nextStep).push(message); calls.push(['send', message]) },
        cancel() {},
        whenIdle() { return idleGate ?? Promise.resolve() },
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { (target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
          remove(msgId) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(entry => entry.id === msgId)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: {
      stream,
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 0 }),
    },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: work }),
      resolveByPath: async () => ({ id: 'w1', path: work }),
      create: async () => ({ id: 'w1', path: work }),
      archiveSession: async () => {},
    },
    sessionController: {
      prompt: async (request) => { prompts.push(request); return { ok: true } },
      create: async () => {
        if (createGate) await createGate()
        if (failCreate) throw new Error('create failed')
        return { sessionId: `s${++created}` }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const saves = new Set()
  const save = rt.save
  rt.save = (options) => {
    const pending = save(options)
    saves.add(pending)
    const done = () => saves.delete(pending)
    void pending.then(done, done)
    return pending
  }
  let stopped
  const stop = () => (stopped ??= ctx.dispose().finally(() => { adapters.telegram = real }))
  t.after(async () => {
    await stop()
    if (existingHome === undefined) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  let seq = 0
  const emitEvent = (sessionId, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, { type, seq: ++seq, data, time: Date.now() })
    }
  }
  const runChain = async (eventName, payload) => {
    const chain = [...(ctx.listeners.get(eventName) ?? [])]
    const run = index => (index >= chain.length ? undefined : chain[index](payload, () => run(index + 1)))
    return run(0)
  }
  const preStep = async (sessionId, messages, step) => {
    const agent = agentOf(sessionId)
    const chain = [...(ctx.listeners.get('agent/pre-step') ?? [])]
    const run = index => (index >= chain.length
      ? Promise.resolve({ kind: 'enter', messages })
      : chain[index]({ agent, messages, turn: 1, step, signal: AbortSignal.timeout(60_000), modelSelection: {} }, () => run(index + 1)))
    return run(0)
  }
  const fireRequestError = (sessionId, code) => runChain('agent/request-error', {
    agent: agentOf(sessionId),
    failure: { code },
    signal: AbortSignal.timeout(60_000),
  })
  const fireApprovals = (request, next) => Promise.all((ctx.listeners.get('approval/request') ?? []).map(listener => listener(request, next)))

  await rt.load()
  const conn = existingHome === undefined
    ? await rt.imEndpoint('im-add', { platform: 'telegram', botId: 'a', fields: { token: 'tok-1234' } })
    : Object.values(rt.state.im.connections)[0]
  if (existingHome === undefined) {
    rt.state.im.connections[conn.id].paired.push({ id: 'u1', name: 'U1', at: 1 })
    await rt.save()
  } else {
    for (let i = 0; !fake.handlers && i < 300; i += 1) await delay(10)
    if (!fake.handlers) throw new Error('timed out waiting for Telegram after reloading')
  }

  const flush = async () => {
    await delay(0)
    while (saves.size > 0) await Promise.all(saves)
    await delay(10)
  }
  const waitHandoff = async (sessionIdOf) => {
    for (let i = 0; i < 300; i += 1) {
      const sid = sessionIdOf()
      if (sid !== undefined && agentOf(sid).inbox.nextTurn.length > 0) return sid
      await delay(10)
    }
    throw new Error('timed out waiting for switch handoff message')
  }

  return {
    rt, fake, prompts, tokens, agentOf, emitEvent, preStep, fireRequestError, fireApprovals, waitHandoff, conn, work, home, stop, flush,
    setFailCreate: (value) => { failCreate = value },
    setIdleGate: (gate) => { idleGate = gate },
    setCreateGate: (gate) => { createGate = gate },
  }
}
