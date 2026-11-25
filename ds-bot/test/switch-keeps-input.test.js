import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// The error every ctx service lookup gives once the plugin's fiber is disposed.
const INACTIVE = 'cannot get required service "sessions" in inactive context'

async function start({ fail = {}, services = {}, home: reuse, state: seed = TEAM } = {}) {
  const root = reuse === undefined
    ? realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-switch-')))
    : join(reuse, '..', '..')
  const home = reuse ?? join(root, 'dsh', 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  if (reuse === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))

  const inboxPath = join(home, 'fake-inbox.json')
  const inboxSeed = () => {
    try { return JSON.parse(readFileSync(inboxPath, 'utf8')) } catch { return {} }
  }
  const saved = inboxSeed()
  const persist = (agents) => {
    const all = { ...saved }
    for (const [id, agent] of agents) all[id] = { nextStep: agent.inbox.nextStep, nextTurn: agent.inbox.nextTurn }
    writeFileSync(inboxPath, JSON.stringify(all))
  }

  const ctx = fakeContext({ services })
  const warnings = []
  const infos = []
  ctx.logger = {
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    info: (...args) => infos.push(args.map(String).join(' ')),
  }
  const errorOf = value => (value instanceof Error ? value : new Error(INACTIVE))
  let flushes = 0
  const created = []
  const resolved = []
  const archived = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const nextStep = [...saved[sessionId]?.nextStep ?? []]
      const nextTurn = [...saved[sessionId]?.nextTurn ?? []]
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        ctx: { tools: { register: () => () => {} } },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        send(message, target, wakeup) {
          ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
          calls.push(['send', message, target, wakeup])
          persist(agents)
        },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message); persist(agents) },
          append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message); persist(agents) },
          remove(id) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) { list.splice(at, 1); persist(agents); return true }
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      list: () => [{ id: 'w1', path: team }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async (options) => {
        if (fail.create) throw errorOf(fail.create)
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? team)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => {
        if (fail.resolve?.has(sessionId)) throw errorOf(fail.resolve)
        resolved.push(sessionId)
        return { agent: agentOf(sessionId) }
      },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      flush: async () => {
        flushes += 1
        if (fail.flush === true || fail.flush instanceof Error || fail.flush === flushes) throw errorOf(fail.flush)
      },
    },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  let seq = 0
  const emit = (sessionId, type, data) => {
    const session = agentOf(sessionId).session
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, rt, root, home, team, project, created, resolved, archived, agentOf, call, tool, preStep, emit, state, warnings, infos, fail, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await settle()
  }
}

const text = message => message.content.map(block => block.text ?? '').join('\n')
const inboxTexts = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(text)
const PAUSE = 'DS Bot paused your turn for a context check. Go on with it now from where you stopped.'
const said = (id, body, exchangeId) => ({ id, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user', ...(exchangeId ? { exchangeId } : {}) } })
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  approval: { request: async () => 'allowed-once' },
}

const moveWriter = async (host, input, step = 2) => {
  host.agentOf('b').status = 'running'
  assert.equal((await host.tool('update_bot', { work_dir: host.project }, 'b')).includes('From your next step on'), true)
  assert.deepEqual(await host.preStep('b', input, step), { kind: 'reject' })
}

test('a move that fails while the plugin unloads hands its input back to the part it left', async (t) => {
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  t.after(host.stop)
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry'), said('m2', 'and this too', 'e-carry2')])

  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  assert.deepEqual(inboxTexts(host.agentOf('b')), ['Now build it', 'and this too', 'waiting input'])
  assert.equal(host.warnings.length, 0)
  assert.ok(host.infos.some(line => line.includes('input kept in part')))
})

test('a move that never started keeps carry and one pause note in the inbox; a retry adds none', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.warnings.length, 0)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  const retry = () => Promise.all((host.ctx.listeners.get('agent/request-error') ?? [])
    .map(listener => listener({ agent: host.agentOf('b'), failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000) }, async () => undefined)))
  await retry()
  await until(() => host.infos.filter(line => line.includes('plugin unloaded')).length >= 2)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  fail.create = false
  fail.flush = false
  await retry()
  await until(() => host.state().bots.b.sessionId === 's1' && host.state().switching?.b === undefined)
  const forwarded = host.agentOf('s1').calls.filter(([kind]) => kind === 'followup' || kind === 'inject').map(([, message]) => text(message))
  assert.equal(forwarded.filter(line => line === PAUSE).length, 1)
  assert.equal(forwarded.filter(line => line === 'keep me').length, 1)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [])
  assert.deepEqual(host.state().switching, {})
})

test('an ordinary failure during the move is still a warning, not the unload note', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  assert.equal(host.infos.filter(line => line.includes('plugin unloaded')).length, 0)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
})

test('an ordinary failure in the move that never started wakes the part at once', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  const sends = host.agentOf('b').calls.filter(([kind]) => kind === 'send')
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  const failOff = { create: true, flush: true }
  const silent = await start({ fail: failOff, services })
  t.after(silent.stop)
  await moveWriter(silent, [said('m1', 'keep me', 'e1')])
  await until(() => silent.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(silent.agentOf('b').calls.filter(([kind]) => kind === 'send').length, 0)
})

const BACKGROUND = {
  ...TEAM,
  bots: { ...TEAM.bots, b: { ...TEAM.bots.b, openParts: [{ sessionId: 'bb', segments: [] }] } },
}

test('a background part that cannot move on keeps its input in its own thread', async (t) => {
  const host = await start({ services, state: BACKGROUND, fail: { create: new Error('disk full') } })
  t.after(host.stop)
  host.rt.botOf('b').workDir = host.project
  assert.deepEqual(await host.preStep('bb', [said('m1', 'keep me', 'e1')], 2), { kind: 'reject' })
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  await settle()
  assert.deepEqual(host.agentOf('bb').calls.map(([kind, message]) => [kind, text(message)]), [['followup', PAUSE], ['followup', 'keep me']])
  assert.deepEqual(host.agentOf('b').calls, [])
})

test('a marked earlier part hands its kept input on after a restart, once, and is archived', async (t) => {
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  second.agentOf('s1').inbox.nextTurn.push(said('m1-copy', 'Now build it', 'e-carry'))
  await second.rt.heldBack()

  const delivered = second.agentOf('s1').calls
    .filter(([kind, message]) => (kind === 'followup' || kind === 'inject') && message.source?.role !== 'handoff')
    .map(([, message]) => message.source?.exchangeId)
  assert.equal(delivered.filter(id => id === 'e-carry').length, 0)
  assert.equal(delivered.filter(id => id === 'e-held').length, 1)
  assert.deepEqual(inboxTexts(second.agentOf('b')), [])
  assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(second.state().switching, {})
})

test('a marked part that stayed current is woken for its kept input, once, in order', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  await moveWriter(host, [said('m1', 'keep me', 'e1'), said('m2', 'and me', 'e2')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()

  const sends = second.agentOf('b').calls.filter(([kind]) => kind === 'send')
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
    ['and me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(second.agentOf('b')), [PAUSE, 'keep me', 'and me'])
  assert.deepEqual(second.state().switching, {})
})

test('an earlier part is stopped only after its tasks moved to the fresh part', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  const order = []
  let release
  const moved = new Promise(resolve => { release = resolve })
  host.rt.moveSchedules = async (from, to) => { order.push(['move', from, to]); await moved }
  const archive = host.ctx.workspaceRegistry.archiveSession
  host.ctx.workspaceRegistry.archiveSession = async (id, options) => { order.push(['archive', id]); return archive(id, options) }
  await moveWriter(host, [])
  await until(() => order.length >= 1)
  await settle()
  assert.deepEqual(order, [['move', 'b', 's1']])
  release()
  await until(() => order.some(([kind]) => kind === 'archive'))
  assert.deepEqual(order, [['move', 'b', 's1'], ['archive', 'b']])
})

test('a failed task move leaves the earlier part unarchived and marked for retry', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  host.rt.moveSchedules = async () => { throw new Error('task storage unavailable') }
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('task storage unavailable')))
  await settle()
  assert.deepEqual(host.archived, [])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  host.rt.moveSchedules = async () => {}
  await host.rt.heldBack()
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(host.state().switching, {})
})

test('unmarked earlier parts are never resolved by the restart pass', async (t) => {
  const host = await start({ services })
  await moveWriter(host, [])
  await until(() => host.state().bots.b.sessionId === 's1' && Object.keys(host.state().switching).length === 0)
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()
  assert.equal(second.resolved.includes('b'), false)
})

test('a state write that fails as a switch ends is warned about, not left unhandled', async (t) => {
  const unhandled = []
  const note = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', note)
  t.after(() => { process.off('unhandledRejection', note) })
  const host = await start({ services })
  t.after(host.stop)
  const save = host.rt.save
  host.rt.save = () => (host.rt.state.bots.b.sessionId === 's1' && Object.keys(host.rt.state.switching).length === 0
    ? Promise.reject(new Error('disk full'))
    : save())
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('did not finish') && line.includes('disk full')))
  await settle()
  assert.deepEqual(unhandled, [])
})

const cutOffServices = { ...services, tokenMeter: { measure: () => ({ totalTokens: 129_000 }) } }
const GROUP_TEAM = {
  ...TEAM,
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
}
const cutOff = (host, sessionId, turn) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'turn/end', { turn, reason: { kind: 'max-tokens' } })
}
const finished = (host, sessionId, turn) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
}

test('a Bot cut off at the output limit with nothing written moves on to a fresh part', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    cutOff(host, 'b', turn)
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')

  const entries = (await host.rt.diagnostics.entries()).filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(entries.length, 2)
  assert.match(entries[0].text, /^the turn was cut off at the output limit before it wrote anything \(gateway\/step-5, 129000 tokens in\)$/)
  assert.deepEqual([entries[0].level, entries[0].bot, entries[0].where], ['warn', 'Writer', 'own chat'])

  await until(() => host.archived.length > 0)
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  const handoff = text(host.agentOf('s1').calls.find(([kind]) => kind === 'followup')[1])
  assert.match(handoff, /^\[Handoff · part 2\]/)
  assert.match(handoff, /kept being cut off at the output limit/)
  assert.match(handoff, /Nothing needs an answer now/)
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})

test('a turn that finished in between resets the count, so one cut-off does not move the part', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  cutOff(host, 'b', 1)
  idle()
  await settle()
  finished(host, 'b', 2)
  idle()
  await settle()
  cutOff(host, 'b', 3)
  idle()
  await settle()
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

test('a cut-off turn that wrote text does not move the part without usage to tell it apart', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: `Half ${turn}` }] } })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    idle()
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

const shortCutOff = (host, turn, usage) => {
  host.emit('b', 'turn/start', { turn })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: `Half ${turn}` }] }, usage })
  host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
}

test('a short answer cut off twice in a row makes room like an overflow', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  const sizes = [{ inputTokens: 129_000, outputTokens: 40 }, { inputTokens: 4_000, cacheReadTokens: 125_000, outputTokens: 40 }]
  for (const [index, usage] of sizes.entries()) {
    shortCutOff(host, index + 1, usage)
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')
  const entries = (await host.rt.diagnostics.entries()).filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(entries.length, 2)
  assert.match(entries[0].text, /the turn was cut off at the output limit, so its answer is not complete \(gateway\/step-5, 129000 tokens in, 40 tokens out\)$/)
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})

test('a cut-off at the model output limit is not a window cut, so the part stays', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    shortCutOff(host, turn, { inputTokens: 129_000, outputTokens: 120_000 })
    idle()
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})

test('a group conversation cut off with nothing written moves on too', async (t) => {
  const host = await start({ services: cutOffServices, state: GROUP_TEAM })
  t.after(host.stop)
  const agent = host.agentOf('gb')
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    cutOff(host, 'gb', turn)
    idle()
    await settle()
  }
  await until(() => host.state().rooms.r1.sessions.b === 's1')
  assert.equal(host.state().rooms.r1.segments.b[0].fallback, 'cutoff')
  await until(() => host.archived.length > 0)
  assert.deepEqual(host.archived, [['gb', { stopActivity: true }]])
})

test('stream-only usage on assistant/message also detects premature window cut-offs', async (t) => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5', maxTokens: 16384 } })
  const idle = () => host.ctx.emit('agent/status', { agent, status: 'idle' })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    host.emit('b', 'assistant/message', {
      message: { content: [{ type: 'text', text: `Half ${turn}` }] },
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 129_000, outputTokens: 40 } } }],
    })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    idle()
    await settle()
  }
  await until(() => host.state().bots.b.sessionId === 's1')
  assert.equal(host.state().bots.b.segments[0].fallback, 'cutoff')
})


test('a configured small output limit is an ordinary cutoff, including reasoning-only output', async t => {
  const host = await start({ services: cutOffServices })
  t.after(host.stop)
  const agent = host.agentOf('b')
  agent.session.requestHeader = () => ({ config: { provider: 'gateway', model: 'small-budget', maxTokens: 1024 } })
  for (const turn of [1, 2]) {
    host.emit('b', 'turn/start', { turn })
    host.emit('b', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 129000, outputTokens: 1024 } })
    host.emit('b', 'turn/end', { turn, reason: { kind: 'max-tokens' } })
    host.ctx.emit('agent/status', { agent, status: 'idle' })
    await settle()
  }
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.created, [])
})
