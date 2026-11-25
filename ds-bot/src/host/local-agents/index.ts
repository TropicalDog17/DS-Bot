import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '../tool-schema.ts'
import { serviceOf } from '../services.ts'
import { splitRef } from '../text.ts'
import { output } from '../tools.ts'
import { LocalAgentAdapter } from './adapter.ts'
import { AcpEngine } from './acp.ts'
import { CodexEngine } from './codex.ts'
import { ClaudeEngine } from './claude.ts'
import { ENGINES, customRoute, isLocalAgentRoute, validateCustom } from './engines.ts'
import { cleanEnv, findEngineExecutable, findExecutable, probeSignIn, probeVersion, refreshSearchDirs } from './discover.ts'

const SIGNED_IN_TTL_MS = 60_000

const spawnEngine = (kind, route, spec) => (kind === 'acp' ? new AcpEngine(route, spec, { findExecutable })
  : kind === 'codex' ? new CodexEngine(route, spec, { findExecutable })
    : new ClaudeEngine(route, spec, { findExecutable }))

export function bridgedTools(rt, tools = []) {
  const names = new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action', ...(rt.bridgedTools?.() ?? [])])
  return tools.filter(tool => names.has(tool.name))
}

export function install(rt) {
  const { ctx, state } = rt
  const store = () => {
    const live = state.localAgents ??= { custom: [], sessions: {} }
    live.custom ??= []
    live.sessions ??= {}
    return live
  }

  const customAgents = () => store().custom
  const customRouteId = () => store().custom.map(agent => customRoute(agent.id))
  const allRoutes = () => [...Object.keys(ENGINES), ...customRouteId()]

  const found = new Map()
  let disposed = false
  async function scan() {
    await refreshSearchDirs()
    if (disposed) return []
    for (const route of Object.keys(ENGINES)) {
      const spec = ENGINES[route]
      const path = findEngineExecutable(spec, findExecutable)
      if (path === undefined) found.delete(route)
      else if (found.get(route)?.path !== path) found.set(route, { route, name: spec.name, path, version: undefined, signIn: spec.signIn })
    }
    applyRoutes()
    return [...found.values()]
  }
  async function probeVersions() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.version !== undefined) return
      const spec: any = ENGINES[entry.route]
      const result = await probeVersion(entry.path, spec.version ?? ['--version'], cleanEnv(spec.env ?? {})).catch(() => undefined)
      entry.version = result?.version
    }))
  }
  async function probeSignIns() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.signedIn !== undefined && Date.now() - entry.signedInAt < SIGNED_IN_TTL_MS) return
      entry.signedIn = await probeSignIn(entry.path, (ENGINES[entry.route] as any).signedIn)
      entry.signedInAt = Date.now()
    }))
  }
  async function freshList() {
    await Promise.all([probeVersions(), probeSignIns()])
    return { available: supported(), detected: detected(), custom: customView() }
  }

  const adapter = new LocalAgentAdapter({
    rt,
    customAgents,
    findExecutable,
    spawnEngine,
    usedModels: route => usedRefs().map(ref => splitRef(ref)).filter(used => used?.provider === route).map(used => used.model),
    record: sessionId => store().sessions[sessionId],
    saveRecord: (sessionId, record) => {
      store().sessions[sessionId] = record
      void rt.save().catch(() => {})
    },
    recordUsage: entry => rt.recordUsage?.(entry),
    patchRecord: (sessionId, patch) => {
      const record = store().sessions[sessionId]
      if (record !== undefined) Object.assign(record, patch)
    },
    presetFor: (sessionId) => {
      const bot = rt.botOf(rt.selfOf(sessionId))
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      return room?.permission ?? bot?.permission ?? 'workspace-write'
    },
    cwdFor: async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        return agent.session.header?.cwd ?? rt.workDirOf?.({ botId: rt.selfOf(sessionId), roomId: rt.groupOwners.get(sessionId)?.roomId }) ?? rt.teamFolder?.() ?? tmpdir()
      } catch {
        return rt.teamFolder?.() ?? tmpdir()
      }
    },
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: options => bridgedTools(rt, options.tools),
  })

  let registration
  const llm = () => serviceOf(ctx, 'llm')
  const supported = () => typeof llm()?.registerAdapter === 'function'
  const usedRefs = () => [...new Set((Object.values(state.bots ?? {}) as any[]).flatMap(bot => [bot.model, bot.appliedModel]).filter(Boolean))]
  const servedRoutes = () => [...new Set([...found.keys(), ...customRouteId(), ...usedRefs().map(ref => splitRef(ref)?.provider).filter(isLocalAgentRoute)])]
  function applyRoutes() {
    if (!supported()) return
    const routes = servedRoutes()
    if (registration === undefined) {
      if (routes.length === 0) return
      registration = llm().registerAdapter(routes, adapter)
    } else registration.replace(routes)
  }
  applyRoutes()
  const initialScan = scan()
  void rt.load?.().then(() => { if (!disposed) applyRoutes() }).catch(() => {})
  // The callback returns the disposer: running adapter.dispose() inside the
  // setup would leave the adapter disposed from the moment it installs.
  ctx.effect(() => async () => {
    disposed = true
    registration?.()
    await Promise.all([initialScan, adapter.dispose()])
  }, 'ds-bot: local agents')

  const isLocalAgentRef = ref => isLocalAgentRoute(splitRef(ref)?.provider ?? '')
  const engineOf = (ref) => {
    if (!ref) return undefined
    return isLocalAgentRef(ref) ? splitRef(ref).provider : 'model'
  }
  const engineOfBot = bot => engineOf(bot?.model ?? bot?.appliedModel)
  const localAgentOf = (bot) => {
    const ref = bot?.model ?? bot?.appliedModel
    return ref !== undefined && isLocalAgentRef(ref) ? ref : undefined
  }
  const isLocalAgentSession = (sessionId) => {
    const bot = rt.botOf(rt.selfOf(sessionId))
    return bot !== undefined && localAgentOf(bot) !== undefined
  }

  rt.localAgentTools = [defineTool({
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action you want to take: running a command, changing files, or reaching the network. The agent runtime asks this on your behalf when its own permission system wants a decision.',
    parameters: {
      action: { type: 'string', required: true, description: 'What the action does, in one line' },
      detail: { type: 'string', description: 'The exact command, paths, or arguments, when it helps the decision' },
    },
    output,
    localAgentOnly: true,
    async execute(args, exec) {
      const approval = ctx.get?.('approval')
      if (approval === undefined || exec.agent?.session === undefined) return 'denied: approvals are not available here'
      const text = `${args.action}${args.detail ? `\n${args.detail}` : ''}`
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason: text.slice(0, 500),
        displayReason: { en: text.slice(0, 500) },
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })]

  const detected = () => [...found.values()].map(entry => ({ route: entry.route, name: entry.name, path: entry.path, version: entry.version ?? null, signIn: entry.signIn, signedIn: entry.signedIn ?? null }))
  const customView = () => store().custom.map(agent => ({ ...agent, route: customRoute(agent.id) }))

  const localAgentModels = route => (servedRoutes().includes(route) ? adapter.probeModels(route) : Promise.resolve([]))

  async function localAgentsEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'local-agents': {
        await scan()
        return freshList()
      }
      case 'local-agent-refresh': {
        adapter.dropModelCache()
        for (const entry of found.values()) delete entry.signedIn
        await scan()
        await rt.catalog?.({ fresh: true })
        return freshList()
      }
      case 'local-agent-models': {
        const models = await localAgentModels(String(body.route ?? ''))
        await rt.catalog?.({ fresh: true })
        return models
      }
      case 'local-agent-add': {
        const clean = validateCustom(body)
        await refreshSearchDirs()
        if (findExecutable(clean.command) === undefined && !clean.command.includes('/') && !clean.command.includes('\\')) {
          throw new Error(`No program named ${clean.command} was found`)
        }
        const entry = { id: `agent-${Date.now().toString(36)}`, ...clean }
        store().custom.push(entry)
        applyRoutes()
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-update': {
        const entry = store().custom.find(agent => agent.id === body.id)
        if (entry === undefined) throw new Error('Unknown agent')
        const clean = validateCustom({ name: body.name ?? entry.name, command: body.command ?? entry.command, args: body.args ?? entry.args })
        Object.assign(entry, clean)
        adapter.dropModelCache(customRoute(entry.id))
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-remove': {
        const at = store().custom.findIndex(agent => agent.id === body.id)
        if (at === -1) throw new Error('Unknown agent')
        store().custom.splice(at, 1)
        applyRoutes()
        await rt.save()
        return customView()
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, {
    isLocalAgentRoute, isLocalAgentRef, engineOf, engineOfBot, localAgentOf, isLocalAgentSession,
    localAgentRoutes: allRoutes, localAgentsEndpoint, localAgentModels,
    engineNameOf: ref => (isLocalAgentRef(ref) ? adapter.providerInfo(splitRef(ref).provider).name : `the model ${ref}`),
    closeLocalAgentSession: (sessionId, reason) => adapter.closeSession(sessionId, reason),
    localAgentContext: sessionId => adapter.contextOf(String(sessionId)),
    localAgentCompact: (sessionId, signal) => adapter.compact(String(sessionId), signal),
    localAgentNote: (sessionId, text, signal) => adapter.note(String(sessionId), text, signal),
    localAgentAsk: (sessionId, request) => adapter.ask(String(sessionId), request),
    localAgentBadge: (ref) => {
      const provider = splitRef(ref)?.provider
      return provider !== undefined && isLocalAgentRoute(provider) ? provider : undefined
    },
  })
}
