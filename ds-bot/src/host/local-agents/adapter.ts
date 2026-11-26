import { createHash, randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError, offloadedImageText, resolveImageAttachmentAccess, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { textOf } from '../text.ts'
import { engineOf, cliMode } from './engines.ts'
import { LoopbackMcp } from './mcp.ts'

export const DEFAULT_CONTEXT_WINDOW = 200_000
const REPLAY_MESSAGES = 12
const REPLAY_BYTES = 24 * 1024
const IDLE_CLOSE_MS = 10 * 60_000
const APPROVE_TOOL = 'approve_agent_action'
// A CLI that answers its compaction command first and condenses after (Devin) says
// that it started within this long, or it is taken to have condensed without a word.
const COMPACT_START_MS = 15_000
const NO_TOOLS = 'Tools are not available for this request. Answer with text only.'

function titleChunk(text) {
  const title = text.slice(0, 60)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: title },
    { type: 'block-end', index: 0, block: { type: 'text', text: title } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function digestChunks(messages) {
  const lines = []
  let used = 0
  for (const message of messages ?? []) {
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, 300)}`
    if (used + line.length > 8 * 1024) break
    lines.push(line)
    used += line.length
  }
  const text = `[Earlier conversation, condensed]\n${lines.join('\n')}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const RESUME_RETRIED = Symbol('resume retried')

export class LocalAgentAdapter extends LlmAdapter {
  deps: any
  engines: Map<any, any>
  live: Map<any, any>
  modelCache: Map<any, any>
  probes: Map<any, any>
  sideRequests: Set<any>
  disposed: boolean

  constructor(deps) {
    super()
    this.deps = deps
    this.engines = new Map()
    this.live = new Map()
    this.modelCache = new Map()
    this.probes = new Map()
    this.sideRequests = new Set()
    this.disposed = false
  }

  providerInfo(route) {
    const engine = engineOf(route, this.deps.customAgents())
    return { id: route, name: engine?.name ?? route }
  }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }

  engine(route) {
    let driver = this.engines.get(route)
    if (driver === undefined) {
      const spec = engineOf(route, this.deps.customAgents())
      if (spec === undefined) throw new (LlmError as any)(`Unknown local agent ${route}`, 'NO_ADAPTER')
      driver = this.deps.spawnEngine(spec.kind, route, spec)
      this.engines.set(route, driver)
    }
    return driver
  }

  async listModels(route) {
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    const listed = [{ provider: route, id: 'default', name: 'CLI default' }, ...(this.modelCache.get(route) ?? [])]
    const used = (this.deps.usedModels?.(route) ?? []).filter(id => !listed.some(model => model.id === id))
    return [...listed, ...used.map(id => ({ provider: route, id, name: id }))]
  }

  async probeModels(route) {
    if (this.modelCache.has(route)) return this.listModels(route)
    if (engineOf(route, this.deps.customAgents()) === undefined) return []
    let probe = this.probes.get(route)
    if (probe === undefined) {
      probe = this.askModels(route).finally(() => this.probes.delete(route))
      this.probes.set(route, probe)
    }
    await probe
    return this.listModels(route)
  }

  async askModels(route) {
    const engine = this.engine(route)
    try {
      const models = await engine.listModels({ cwd: this.deps.probeCwd(), mcp: undefined })
      this.modelCache.set(route, (models ?? []).filter(model => model.id !== 'default')
        .map(model => ({ provider: route, id: model.id, name: model.name ?? model.id, ...(model.reasoning ? { reasoning: model.reasoning } : {}) })))
    } catch { /* the menu still has the CLI's default */ }
    if (!this.engineInUse(engine)) await engine.close?.().catch(() => {})
  }

  dropModelCache(route?) {
    if (route === undefined) this.modelCache.clear()
    else this.modelCache.delete(route)
  }

  async resolveModel(route, model) {
    const spec: any = engineOf(route, this.deps.customAgents())
    const listed = (await this.listModels(route).catch(() => [])).find(entry => entry.id === model)
    const supportsImage = spec?.kind !== 'acp' || this.engines.get(route)?.supportsImages?.() !== false
    return {
      provider: route,
      id: model,
      name: listed?.name ?? model,
      inputModalities: supportsImage ? ['text', 'image'] : ['text'],
      context: { contextWindow: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      ...(listed?.reasoning ? { reasoning: listed.reasoning } : {}),
    }
  }

  async liveFor(options, preset) {
    const sessionId = String(options.sessionId)
    let live = this.live.get(sessionId)
    const record = this.deps.record(sessionId)
    const route = options.provider
    if (live !== undefined && !live.dead && live.route === route) {
      if (live.engineSession?.dead === true) {
        this.rollbackUnread(live, sessionId)
        live.engineSession = undefined
        live.pumpToken = {}
        live.events.length = 0
      }
      if ((live.model === options.model && live.preset === preset) || live.state !== 'idle') return live
      await this.closeLive(live, { idle: true })
    } else if (live !== undefined) await this.closeLive(live)
    const spec = engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new (LlmError as any)(`Unknown local agent ${route}`, 'LOCAL_AGENT_MISSING')
    const engine = this.engine(route)
    live = {
      sessionId, route, spec, engine, dead: false,
      record,
      cliSessionId: record?.cliSessionId,
      handed: record?.handedId,
      promptHash: record?.promptHash,
      defaultEffort: record?.model === options.model ? record?.defaultEffort : undefined,
      effort: record?.effort,
      engineSession: undefined,
      mcp: undefined,
      events: [],
      waiters: [],
      pending: new Map(),
      started: false,
      state: 'idle',
      // Prompts queued while a turn runs (ACP speaks one prompt at a time);
      // the drain sends the next one when the turn ends.
      queue: [],
      idle: undefined,
      cwd: record?.cwd,
      model: options.model,
      preset,
      context: record?.context,
      compactions: record?.compactions ?? 0,
      // Output of a request DS Bot made for itself may trail its end (Devin's
      // "Context compacted"); until the next prompt, text, thoughts and activity drop.
      mute: false,
    }
    live.push = (event) => {
      this.observe(live, event)
      if (live.mute && live.state === 'idle' && (event?.type === 'text' || event?.type === 'thought' || event?.type === 'activity')) return
      clearTimeout(live.idle)
      live.idle = setTimeout(() => void this.closeLive(live, { idle: true }), IDLE_CLOSE_MS)
      live.idle.unref?.()
      const waiter = live.waiters.shift()
      if (waiter !== undefined) waiter(event)
      else live.events.push(event)
    }
    live.next = () => (live.events.length > 0 ? Promise.resolve(live.events.shift()) : new Promise(resolve => live.waiters.push(resolve)))
    this.live.set(sessionId, live)
    return live
  }

  recordOf(live, extra = {}) {
    return {
      route: live.route,
      cliSessionId: live.cliSessionId,
      cwd: live.cwd,
      handedId: live.handed,
      promptHash: live.promptHash,
      model: live.model,
      ...(live.defaultEffort === undefined ? {} : { defaultEffort: live.defaultEffort }),
      ...(live.effort === undefined ? {} : { effort: live.effort }),
      ...(live.context === undefined ? {} : { context: live.context }),
      ...(live.compactions > 0 ? { compactions: live.compactions } : {}),
      ...extra,
    }
  }

  // The CLI's own word on its context. A size it reports replaces the default
  // window; a compaction makes the last figure stale until the CLI reports again,
  // except where it reported during the compaction itself (Codex).
  observe(live, event) {
    if (event?.type === 'effort') {
      if (event.defaultEffort !== undefined) live.defaultEffort = event.defaultEffort
      live.effort = event.effort
      this.deps.saveRecord(live.sessionId, this.recordOf(live))
      return
    }
    if (event?.type === 'context') {
      const size = Number.isFinite(event.size) && event.size > 0 ? event.size : live.context?.size
      live.context = Number.isFinite(event.used)
        ? { used: event.used, ...(size === undefined ? {} : { size }) }
        : { ...live.context, ...(size === undefined ? {} : { size }) }
      this.deps.patchRecord?.(live.sessionId, { context: live.context })
      return
    }
    if (event?.type !== 'compaction') return
    if (event.status === 'started') {
      live.compacting = { before: live.context }
      live.context = { ...live.context, stale: true }
      return
    }
    const during = live.compacting
    live.compacting = undefined
    if (event.status !== 'completed') {
      if (during !== undefined && live.context?.stale === true) live.context = during.before
      return
    }
    live.compactions += 1
    if (during === undefined) live.context = { ...live.context, stale: true }
    if (live.spec.kind === 'acp') live.promptHash = undefined
    this.deps.saveRecord(live.sessionId, this.recordOf(live))
  }

  contextOf(sessionId) {
    const live = this.live.get(sessionId)
    const record = live === undefined ? this.deps.record(sessionId) : undefined
    const context = live?.context ?? record?.context
    const compactions = live?.compactions ?? record?.compactions ?? 0
    if (context === undefined && compactions === 0) return undefined
    return {
      ...(context?.stale === true || context?.used === undefined ? {} : { used: context.used }),
      ...(context?.size === undefined ? {} : { size: context.size }),
      compactions,
    }
  }

  engineInUse(engine, except?) {
    return [...this.live.values()].some(other => other.engine === engine && !other.dead)
      || [...this.sideRequests].some(request => request !== except && request.engine === engine)
  }

  async closeLive(live, { idle = false } = {}) {
    if (live.dead) return
    live.dead = true
    clearTimeout(live.idle)
    this.live.delete(live.sessionId)
    live.engine.forget?.(live.sessionId)
    live.mcp?.close()
    if (idle) {
      live.engineSession = undefined
      live.started = false
    }
    for (const waiter of live.waiters.splice(0)) waiter({ type: 'done', reason: 'stop' })
    const stillUsed = this.engineInUse(live.engine)
    if (!stillUsed) await live.engine.close?.().catch(() => {})
  }

  stopTurn(live, reason) {
    live.state = 'idle'
    live.queue.length = 0
    const stopped = live.engineSession === undefined ? undefined : live.engine.cancel?.(live.engineSession)
    live.mcp?.failAll(new Error(reason))
    for (const pending of live.pending.values()) pending.resolve({ text: reason, isError: true })
    live.pending.clear()
    return stopped
  }

  async closeSession(sessionId, reason = 'the conversation moved on') {
    const live = this.live.get(String(sessionId))
    if (live === undefined) return
    this.stopTurn(live, reason)
    await this.closeLive(live, { idle: true })
  }

  // A Claude CLI that died before `system/init` never read the prompt it was
  // handed: roll the marker back in the live state and in the saved record, so a
  // host that restarts before the next call still replays the input. ACP and
  // Codex create their session before the prompt, so theirs was read.
  rollbackUnread(live, sessionId) {
    if (live.spec.kind !== 'claude') return
    const session = live.engineSession
    if (session?.dead !== true || session.cliSessionId !== undefined || session.rolledBack === true) return
    session.rolledBack = true
    if (session.resumeMissing === true) {
      live.cliSessionId = undefined
      live.handed = undefined
      live.resumeLost = true
    } else live.handed = live.handedBefore
    this.deps.saveRecord(sessionId, this.recordOf(live))
  }

  async ensureMcp(live, tools) {
    live.tools = tools
    if (live.mcp !== undefined) return live.mcp
    const mcp = new LoopbackMcp(() => live.tools(), ({ name, arguments: args, callId }) => {
      const dshCallId = `dsbot-${callId}`
      return new Promise((resolve) => {
        live.pending.set(dshCallId, { name, mcpCallId: callId, resolve })
        live.push({ type: 'call', name, args, dshCallId })
      })
    })
    await mcp.listen()
    live.mcp = mcp
    return mcp
  }

  async *stream(options) {
    if (this.disposed) throw new (LlmError as any)('the local agents adapter is disposed', 'NO_ADAPTER')
    if (options.purpose === 'session-title') {
      const first = (options.messages ?? []).find(message => message.role === 'user')
      const title = (textOf(first?.content).split('\n').find(line => line.trim() !== '') ?? 'Chat').trim()
      yield* titleChunk(title === '' ? 'Chat' : title)
      return
    }
    if (options.purpose === 'compaction') {
      yield* digestChunks(options.messages)
      return
    }
    const sessionId = options.sessionId
    if (sessionId === undefined) throw new (LlmError as any)('a local agent request needs a session', 'INVALID_REQUEST')
    const preset = this.deps.presetFor(sessionId)
    const live = await this.liveFor(options, preset)

    const messages = options.messages ?? []
    const at = live.handed === undefined ? -1 : messages.findIndex(message => message.id === live.handed)
    const fresh = live.handed === undefined || at === -1
    const delta = fresh ? [] : messages.slice(at + 1)

    const settled = []
    for (const message of delta) {
      if (message.role !== 'tool') continue
      const pending = live.pending.get(message.toolCallId)
      if (pending === undefined) continue
      live.pending.delete(message.toolCallId)
      const text = textOf(message.content) || (message.isError ? 'the call failed' : '')
      pending.resolve({ text, isError: message.isError === true })
      settled.push({ name: pending.name, text, isError: message.isError === true })
    }
    const contextText = delta
      .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .map(message => textOf(message.content)).filter(text => text !== '').join('\n')
    const users = delta.filter(message => message.role === 'user' && message.source?.kind !== 'runtime-context')
    const openCall = [...live.pending.entries()].find(([, entry]) => entry.name !== APPROVE_TOOL)
    const remaining = []
    let answered = openCall === undefined
    for (const message of users) {
      if (!answered && openCall !== undefined) {
        const [id, pending] = openCall
        live.pending.delete(id)
        const answer = textOf(message.content)
        pending.resolve({ text: answer })
        settled.push({ name: openCall[1].name, text: answer, isError: false })
        answered = true
      } else {
        remaining.push(message)
      }
    }

    const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n').trim()
    const promptHash = system === '' ? undefined : createHash('sha256').update(system).digest('hex')
    const mcp = await this.ensureMcp(live, () => this.deps.toolsFor(options))
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd

    const mode = cliMode(live.spec.kind, preset)
    const instructions = system === '' ? undefined : system

    const freshCli = live.cliSessionId === undefined
    if (live.engineSession === undefined) {
      const openArgs = {
        cwd,
        mcp,
        resumeId: live.cliSessionId,
        mode,
        preset,
        model: options.model,
        defaultEffort: live.defaultEffort,
        effort: live.effort,
        // Codex carries the team instructions as developer config on a new
        // thread; Claude gets them appended at spawn; ACP reads them in the
        // first prompt below.
        instructions: live.spec.kind === 'codex' && freshCli ? instructions : undefined,
        system: live.spec.kind === 'claude' ? instructions : undefined,
      }
      live.engineSession = await live.engine.open(sessionId, openArgs)
        .catch(error => { throw toLlmError(error, live) })
      // A resumed CLI reports its id only with `system/init`: keep the saved one
      // in the meantime, or a resume that fails would erase it.
      const reportedId = live.engineSession.acpSessionId ?? live.engineSession.threadId ?? live.engineSession.cliSessionId
      if (reportedId !== undefined) live.cliSessionId = reportedId
      if (live.spec.kind === 'acp') {
        if (live.engineSession.defaultEffort !== undefined) live.defaultEffort = live.engineSession.defaultEffort
        live.effort = live.engineSession.effort
      }
      live.started = true
      const session = live.engineSession
      const token = live.pumpToken = {}
      void (async () => {
        while (live.pumpToken === token && !live.dead) {
          const event = await session.next()
          if (live.pumpToken === token && !live.dead) live.push(event)
        }
      })()
      if (live.spec.kind !== 'acp' && instructions !== undefined) live.promptHash = promptHash
      this.deps.saveRecord(sessionId, this.recordOf(live, { cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
      // Claude reports its session id with `system/init`, after start() resolved:
      // the record above has no id yet, so persist it when it lands or the next
      // host has nothing to resume and the conversation starts over.
      const pendingId = session.whenSessionId?.()
      if (pendingId !== undefined) {
        void pendingId.then((id) => {
          if (id === undefined || live.dead) return
          live.cliSessionId = id
          this.deps.saveRecord(sessionId, this.recordOf(live, { cliSessionId: id, cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
        })
      }
    }

    const supportsImages = live.spec.kind !== 'acp' || live.engine.supportsImages?.(live.engineSession) !== false
    const resolveImage = block => this.resolveImageBlock(block, { supportsImages, signal: options.signal })
    let promptBlocks = fresh
      ? await renderReplay(messages, live.spec.kind === 'claude' ? '' : system, resolveImage)
      : await renderDelta(contextText, remaining, resolveImage)
    let sentInstructions = live.spec.kind !== 'acp' && freshCli && instructions !== undefined
    if (instructions !== undefined && !freshCli && live.promptHash !== promptHash) {
      const updated = `Updated team instructions (replace earlier ones):\n\n${instructions}`
      if (live.spec.kind === 'codex') {
        await live.engine.instruct?.(live.engineSession, updated)
        sentInstructions = true
      } else if (promptBlocks.length > 0 || live.spec.kind === 'acp' || live.spec.kind === 'claude') {
        promptBlocks = mergeTextBlocks([{ type: 'text', text: updated }, ...promptBlocks])
        sentInstructions = true
      }
    }
    let settledText = ''
    if (settled.length > 0) {
      const answer = settled.map(entry => `${entry.name} → ${entry.text === '' ? (entry.isError ? 'failed' : 'no result') : entry.text}`).join('\n')
      settledText = `The calls that were waiting on the user are settled:\n\n${answer}\n\nContinue from where the turn stopped.`
    }
    if (settledText !== '' && live.engine.canSteer?.(live.engineSession) === false) {
      const blocks = mergeTextBlocks([{ type: 'text', text: settledText }, ...promptBlocks])
      this.discardTurnOutput(live)
      if (sentInstructions) live.promptHash = promptHash
      promptBlocks = []
      await this.startTurn(live, blocks, options.signal, options.reasoningEffort)
    } else if (settledText !== '') {
      live.continuation = settledText
    }
    if (promptBlocks.length > 0) {
      await this.sendInput(live, promptBlocks, options.signal, options.reasoningEffort, settledText)
      if (sentInstructions) live.promptHash = promptHash
      // ACP only counts instructions once they reach the agent with a prompt.
      if (live.spec.kind === 'acp' && (freshCli || sentInstructions)) live.promptHash = promptHash
    }
    if (live.spec.kind === 'acp' && freshCli && promptBlocks.length === 0 && instructions !== undefined) {
      await this.sendInput(live, `Follow these instructions from the user's team for everything you do here. They sit on top of your own; when they conflict, these win.\n\n${instructions}`, options.signal, options.reasoningEffort)
      live.promptHash = promptHash
    }

    const last = messages.at(-1)
    if (last !== undefined) {
      live.handedBefore = live.handed
      live.handed = last.id
      this.deps.saveRecord(sessionId, this.recordOf(live, { cwd, promptHash: live.promptHash ?? promptHash, model: options.model }))
    }

    try {
      yield* this.drain(live, options)
    } catch (error) {
      this.rollbackUnread(live, sessionId)
      if (live.resumeLost === true && options[RESUME_RETRIED] !== true) {
        live.resumeLost = false
        yield* this.stream({ ...options, [RESUME_RETRIED]: true })
        return
      }
      throw error
    }
  }

  sendInput(live, input, signal, effort?, settled?) {
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    const steerInput = typeof input === 'string' ? input : blocks
    live.mute = false
    const body = settled === undefined || settled === ''
      ? blocks
      : mergeTextBlocks([{ type: 'text', text: settled }, ...blocks])
    if (live.state !== 'idle') {
      if (live.spec.kind === 'acp') { live.queue.push(blocks); return Promise.resolve() }
      if (live.engine.canSteer?.(live.engineSession) === false) {
        this.discardTurnOutput(live)
        live.continuation = undefined
        return this.startTurn(live, body, signal, effort)
      }
      const recover = () => {
        this.discardTurnOutput(live)
        live.continuation = undefined
        return this.startTurn(live, body, signal, effort)
      }
      try {
        return Promise.resolve(live.engine.steer?.(live.engineSession, steerInput)).then(() => {}, recover)
      } catch {
        return recover()
      }
    }
    this.startTurn(live, blocks, signal, effort)
    return Promise.resolve()
  }

  discardTurnOutput(live) {
    live.events = live.events.filter(event => event.type === 'permission' || event.type === 'call')
  }

  // Codex resolves on acceptance; ACP resolves only when the entire turn ends.
  startTurn(live, input, signal, effort) {
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input
    live.state = 'running'
    live.turnTag = undefined
    try {
      const started = Promise.resolve(live.engine.prompt(live.engineSession, blocks, { signal, effort }))
        .then((turnId) => { if (live.spec.kind === 'codex' && turnId !== undefined) live.turnTag = turnId })
        .catch(error => live.push({ type: 'error', error }))
      return live.spec.kind === 'acp' ? Promise.resolve() : started
    } catch (error) {
      live.push({ type: 'error', error })
      return Promise.resolve()
    }
  }

  async resolveImageBlock(block, { supportsImages, signal }) {
    const ref = block?.attachment
    if (ref === undefined) return { type: 'text', text: '[image unavailable]' }
    const attachments = this.deps.attachments ?? this.deps.rt?.ctx?.get?.('attachments')
    const fsService = this.deps.fs ?? this.deps.rt?.ctx?.get?.('fs')
    let access
    if (attachments !== undefined) {
      try {
        const mapHostPath = path => (fsService?.processPathFromHostPath ? fsService.processPathFromHostPath(path) : path)
        access = resolveImageAttachmentAccess(attachments, mapHostPath, ref)
      } catch {}
    }
    if (block.offloaded === true) return { type: 'text', text: offloadedImageText(ref, access) }
    if (!supportsImages) {
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
    if (attachments === undefined || typeof attachments.readImage !== 'function') {
      this.deps.rt?.warn?.('local-agents: attachments service unavailable; cannot forward image')
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
    try {
      const got = await attachments.readImage(ref, signal)
      return {
        type: 'image',
        mediaType: got.ref?.mediaType ?? ref.mediaType ?? 'image/png',
        data: Buffer.from(got.data).toString('base64'),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.deps.rt?.warn?.(`local-agents: failed to read image ${ref.attachmentId ?? ''}: ${error?.message ?? error}`)
      const base = textOnlyImageText(ref)
      return { type: 'text', text: access?.readonlyPath ? `${base} (file: ${access.readonlyPath})` : base }
    }
  }

  async *drain(live, options) {
    let index = 0
    let textBuf = ''
    let textIndex = -1
    let thinkBuf = ''
    let thinkIndex = -1
    // DSH keeps the last usage chunk of a request, and a CLI may report each of its
    // model calls (Codex): the chunk carries the sum.
    let usage
    const addUsage = (more) => {
      usage = usage === undefined ? { ...more } : Object.fromEntries([...new Set([...Object.keys(usage), ...Object.keys(more)])].map(key => [key, (usage[key] ?? 0) + (more[key] ?? 0)]))
      return { type: 'usage', usage }
    }
    const closeBlocks = function* () {
      if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
      if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
    }
    const emitCalls = (calls) => {
      const chunks = []
      calls.forEach((call, offset) => {
        const at = index + offset
        chunks.push(
          { type: 'block-start', index: at, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: at, id: call.dshCallId, name: call.name, argumentsDelta: JSON.stringify(call.args ?? {}) },
          { type: 'block-end', index: at, block: { type: 'tool-call', id: call.dshCallId, name: call.name, arguments: JSON.stringify(call.args ?? {}) } },
        )
      })
      index += calls.length
      return chunks
    }
    let abortReject
    const abortPromise = new Promise((_, reject) => { abortReject = reject })
    const onAbort = () => abortReject(options.signal?.reason ?? new Error('aborted'))
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort)
    try {
    for (;;) {
      const event = await Promise.race([live.next(), abortPromise]).catch(error => ({ type: 'abort', error }))
      if (event.type === 'abort') {
        this.stopTurn(live, 'the turn was stopped')
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } }
        return
      }
      if (event.type !== 'permission' && event.type !== 'call' && event.turnId !== undefined && live.turnTag !== undefined && event.turnId !== live.turnTag) continue
      switch (event.type) {
        case 'text': {
          if (textIndex === -1) {
            if (thinkIndex !== -1) { yield { type: 'block-end', index: thinkIndex, block: { type: 'reasoning', text: thinkBuf } }; thinkIndex = -1; thinkBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'text' }
            textIndex = index - 1
          }
          textBuf += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
          break
        }
        case 'thought':
        case 'activity': {
          const text = event.type === 'activity' ? `${thinkBuf === '' || thinkBuf.endsWith('\n') ? '' : '\n'}${event.text}\n` : event.text
          if (thinkIndex === -1) {
            if (textIndex !== -1) { yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuf } }; textIndex = -1; textBuf = '' }
            yield { type: 'block-start', index: index++, blockType: 'reasoning' }
            thinkIndex = index - 1
          }
          thinkBuf += text
          yield { type: 'reasoning-delta', index: thinkIndex, text }
          break
        }
        case 'usage': yield addUsage(event.usage); break
        case 'call': {
          yield* closeBlocks()
          live.state = 'suspended'
          for (const chunk of emitCalls([{ name: event.name, args: event.args, dshCallId: event.dshCallId }])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'permission': {
          const answer = presetAnswer(this.deps.presetFor(live.sessionId), event)
          if (answer !== undefined) { event.reply(answer); break }
          yield* closeBlocks()
          live.state = 'suspended'
          const call = { name: APPROVE_TOOL, args: { action: event.action, ...(event.detail ? { detail: event.detail } : {}) }, dshCallId: event.id }
          live.pending.set(event.id, { name: APPROVE_TOOL, resolve: (result) => event.reply(pickAllowOption(event.options, result)) })
          for (const chunk of emitCalls([call])) yield chunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          if (live.continuation !== undefined && index === 0) {
            const continuation = live.continuation
            live.continuation = undefined
            this.discardTurnOutput(live)
            await this.startTurn(live, continuation, options.signal, options.reasoningEffort)
            break
          }
          live.continuation = undefined
          yield* closeBlocks()
          if (event.usage !== undefined) yield addUsage(event.usage)
          live.state = 'idle'
          const next = live.queue.shift()
          if (next !== undefined) {
            this.sendInput(live, next, options.signal, options.reasoningEffort)
            break
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        case 'error': {
          live.state = 'idle'
          throw toLlmError(event.error, live)
        }
        default: break
      }
    }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async compact(sessionId, signal) {
    return this.maintain(sessionId, signal, async (live) => {
      live.state = 'running'
      // Devin says "Context compacted" after the compaction ends, when no prompt runs.
      live.mute = true
      const sent = live.engine.compact?.(live.engineSession) === true
      if (!sent) {
        live.state = 'idle'
        return 'unsupported'
      }
      this.meter(live, await this.collect(live, () => this.take(live), signal, { compaction: true }))
      return 'done'
    })
  }

  async note(sessionId, text, signal) {
    return this.maintain(sessionId, signal, async (live) => {
      await this.sendInput(live, text, signal)
      return this.meter(live, await this.collect(live, () => this.take(live), signal)).text
    })
  }

  async maintain(sessionId, signal, work) {
    let live = this.live.get(sessionId)
    const record = live === undefined ? this.deps.record(sessionId) : undefined
    if (live === undefined && record?.cliSessionId === undefined) throw new (LlmError as any)('this conversation has no session of its local agent yet', 'LOCAL_AGENT_ERROR')
    let opened = false
    if (live === undefined || live.engineSession === undefined || live.engineSession.dead === true) {
      live ??= await this.liveFor({ sessionId, provider: record.route, model: record.model }, this.deps.presetFor(sessionId))
      await this.openFor(live, sessionId)
      opened = true
    }
    if (live.state !== 'idle' || live.pending.size > 0) throw new (LlmError as any)('the local agent is in the middle of a turn', 'LOCAL_AGENT_BUSY')
    live.events.length = 0
    try {
      signal?.throwIfAborted()
      return await work(live)
    } finally {
      if (live.state !== 'idle') await this.stopTurn(live, 'the request was stopped')
      live.events.length = 0
      live.mute = true
      if (opened) await this.closeLive(live, { idle: true })
    }
  }

  async openFor(live, sessionId) {
    const cwd = live.cwd ?? await this.deps.cwdFor(sessionId)
    live.cwd = cwd
    live.engineSession = await live.engine.open(sessionId, {
      cwd,
      mcp: undefined,
      resumeId: live.cliSessionId,
      mode: cliMode(live.spec.kind, live.preset),
      preset: live.preset,
      model: live.model,
      defaultEffort: live.record === undefined || live.record.model === live.model ? live.defaultEffort : undefined,
      effort: live.effort,
    })
      .catch(error => { throw toLlmError(error, live) })
    if (live.spec.kind === 'acp') {
      if (live.engineSession.defaultEffort !== undefined) live.defaultEffort = live.engineSession.defaultEffort
      live.effort = live.engineSession.effort
    }
    const session = live.engineSession
    const token = live.pumpToken = {}
    void (async () => {
      while (live.pumpToken === token && !live.dead) {
        const event = await session.next()
        if (live.pumpToken === token && !live.dead) live.push(event)
      }
    })()
  }

  take(live) {
    if (live.events.length > 0) return { event: Promise.resolve(live.events.shift()), drop: () => {} }
    let resolver
    const event = new Promise((resolve) => { resolver = resolve; live.waiters.push(resolve) })
    return { event, drop: () => { const at = live.waiters.indexOf(resolver); if (at !== -1) live.waiters.splice(at, 1) } }
  }

  async collect(live, take, signal, { compaction = false } = {}) {
    let text = ''
    let usage
    const add = (more) => {
      if (more === undefined) return
      usage = usage === undefined ? { ...more } : Object.fromEntries([...new Set([...Object.keys(usage), ...Object.keys(more)])].map(key => [key, (usage[key] ?? 0) + (more[key] ?? 0)]))
    }
    let ended = false
    let started = false
    let condensed = false
    let abortReject
    const aborted = new Promise((_, reject) => { abortReject = reject })
    aborted.catch(() => {})
    const onAbort = () => abortReject(signal?.reason ?? new Error('aborted'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort)
    try {
      for (;;) {
        signal?.throwIfAborted()
        if (ended && (!compaction || condensed)) {
          live.state = 'idle'
          return { text, usage }
        }
        const next = take()
        const waits = [next.event, aborted]
        let timer
        if (ended && !started) waits.push(new Promise((resolve) => { timer = setTimeout(() => resolve({ type: 'quiet' }), COMPACT_START_MS) }))
        let event
        try {
          event = await Promise.race(waits)
        } finally {
          clearTimeout(timer)
          next.drop()
        }
        switch (event.type) {
          case 'text': text += event.text; break
          case 'call': {
            const pending = live.pending.get(event.dshCallId)
            live.pending.delete(event.dshCallId)
            pending?.resolve({ text: NO_TOOLS, isError: true })
            break
          }
          case 'permission': event.reply(null); break
          case 'compaction':
            if (event.status === 'started') started = true
            else if (event.status === 'completed') condensed = true
            else throw new (LlmError as any)('the local agent did not condense its context', 'LOCAL_AGENT_ERROR')
            break
          case 'quiet':
            live.state = 'idle'
            return { text, usage }
          case 'usage': add(event.usage); break
          case 'done':
            add(event.usage)
            ended = true
            if (!compaction) live.state = 'idle'
            break
          case 'error':
            live.state = 'idle'
            throw toLlmError(event.error, live)
          default: break
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  meter(live, result) {
    if (result.usage !== undefined) this.deps.recordUsage?.({ sessionId: live.sessionId, kind: 'compaction', provider: live.route, model: live.model, usage: result.usage })
    return result
  }

  async ask(sessionId, { system, prompt, signal }) {
    if (this.disposed) throw new (LlmError as any)('the local agents adapter is disposed', 'NO_ADAPTER')
    const record = this.live.get(sessionId) ?? this.deps.record(sessionId)
    const route = record?.route
    const spec = route === undefined ? undefined : engineOf(route, this.deps.customAgents())
    if (spec === undefined) throw new (LlmError as any)('this conversation has no local agent', 'LOCAL_AGENT_MISSING')
    const isolated = spec.kind === 'codex'
    const engine = isolated ? this.deps.spawnEngine(spec.kind, route, spec) : this.engine(route)
    const request = { controller: new AbortController(), done: (Promise as any).withResolvers(), engine, isolated }
    this.sideRequests.add(request)
    signal = AbortSignal.any([request.controller.signal, ...(signal === undefined ? [] : [signal])])
    const sideId = `dsbot-side-${randomUUID()}`
    let session
    try {
      signal.throwIfAborted()
      const efforts = (this.modelCache.get(route) ?? []).find(model => model.id === record.model)?.reasoning?.efforts ?? []
      const effort = efforts.some(entry => entry.id === 'off') ? 'off' : efforts[0]?.id ?? (spec.kind === 'claude' ? 'low' : undefined)
      session = await engine.open(sideId, {
        cwd: this.deps.probeCwd(), mcp: undefined, mode: cliMode(spec.kind, 'read-only'), preset: 'read-only', model: record.model, ephemeral: true, effort,
        instructions: spec.kind === 'codex' ? system : undefined,
        system: spec.kind === 'claude' ? system : undefined,
      }).catch(error => { throw toLlmError(error, { spec }) })
      signal.throwIfAborted()
      const side = { state: 'running', pending: new Map(), spec }
      // An ACP prompt resolves only when its turn ends, and its events wait in the
      // queue; a prompt the CLI refuses ends the request at once.
      const refused = Promise.resolve(engine.prompt(session, [{ type: 'text', text: spec.kind === 'acp' ? `${system}\n\n${prompt}` : prompt }], { signal, effort }))
        .then(() => new Promise(() => {}), error => ({ type: 'error', error }))
      const result = await this.collect(side, () => ({ event: Promise.race([session.next(), refused]), drop: () => {} }), signal)
      return this.meter({ sessionId, route, model: record.model }, result).text
    } finally {
      try {
        if (session !== undefined) {
          if (signal.aborted) await engine.cancel?.(session)
          await engine.closeSession?.(session)
        }
      } finally {
        engine.forget?.(sideId)
        if (isolated || !this.engineInUse(engine, request)) await engine.close?.().catch(() => {})
        this.sideRequests.delete(request)
        request.done.resolve()
      }
    }
  }

  async dispose() {
    this.disposed = true
    const requests = [...this.sideRequests]
    for (const request of requests) request.controller.abort(new (LlmError as any)('the local agents adapter is disposed', 'NO_ADAPTER'))
    await Promise.all(requests.filter(request => request.isolated).map(request => request.engine.close?.().catch(() => {})))
    await Promise.all(requests.map(request => request.done.promise))
    for (const live of Array.from(this.live.values())) await this.closeLive(live)
    for (const engine of Array.from(this.engines.values())) await engine.close?.().catch(() => {})
    this.engines.clear()
  }
}

function pickAllowOption(options, result) {
  if (result.isError === true) return null
  let decision
  try { decision = JSON.parse(result.text ?? '')?.decision } catch { decision = undefined }
  if (decision !== 'allow') return null
  return optionOf(options, 'allow') ?? null
}

const optionOf = (options, kind) => ((options ?? []).find(entry => entry.kind === `${kind}_once`)
  ?? (options ?? []).find(entry => (entry.kind ?? '').startsWith(kind)))?.optionId

function presetAnswer(preset, event) {
  if (preset === 'danger-full-access') return optionOf(event.options, 'allow')
  if (preset === 'read-only' && event.changes === true) return optionOf(event.options, 'reject') ?? null
  return undefined
}

function mergeTextBlocks(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text === '') continue
      const prev = out.at(-1)
      if (prev?.type === 'text') prev.text = `${prev.text}\n\n${block.text}`
      else out.push({ type: 'text', text: block.text })
    } else {
      out.push(block)
    }
  }
  return out
}

async function blocksOfMessage(message, { maxText, resolveImage }: { maxText?: any, resolveImage: any }) {
  const raw = Array.isArray(message.content) ? message.content : []
  const out = []
  let textParts = []
  let textLeft = maxText ?? Infinity
  const flushText = () => {
    const text = textParts.join('\n').trim()
    textParts = []
    if (text !== '') out.push({ type: 'text', text })
  }
  for (const block of raw) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const piece = textLeft === Infinity ? block.text : block.text.slice(0, textLeft)
      if (textLeft !== Infinity) textLeft = Math.max(0, textLeft - piece.length)
      textParts.push(piece)
    } else if (block?.type === 'image') {
      flushText()
      out.push(await resolveImage(block))
    }
  }
  flushText()
  return out
}

async function renderDelta(contextText, remaining, resolveImage) {
  const parts = []
  if (contextText !== '') parts.push({ type: 'text', text: contextText })
  for (const message of remaining) {
    parts.push(...await blocksOfMessage(message, { resolveImage }))
  }
  return mergeTextBlocks(parts)
}

async function renderReplay(messages, system, resolveImage) {
  const picked = []
  let used = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  let full = false
  for (const message of [...body].reverse()) {
    const whole = message === latest || message.source?.handoff === true
    const text = textOf(message.content)
    const prefix = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}:`
    const approxLen = prefix.length + 1 + (whole ? text.length : Math.min(text.length, 2_000))
    if (!whole) {
      full ||= picked.length >= REPLAY_MESSAGES || used + approxLen > REPLAY_BYTES
      if (full) continue
    }
    const blocks = await blocksOfMessage(message, { maxText: whole ? Infinity : 2_000, resolveImage })
    const entry = blocks.length > 0 && blocks[0].type === 'text'
      ? [{ type: 'text', text: `${prefix} ${blocks[0].text}` }, ...blocks.slice(1)]
      : blocks.length > 0
        ? [{ type: 'text', text: prefix }, ...blocks]
        : [{ type: 'text', text: `${prefix} ` }]
    picked.unshift(entry)
    used += approxLen
  }
  if (picked.length === 0) return []
  const head = system === '' ? '' : `The team instructions for this conversation:\n${system}\n\n`
  return mergeTextBlocks([{ type: 'text', text: `${head}The conversation so far (oldest first):` }, ...picked.flat()])
}

function toLlmError(error, live) {
  if (error instanceof LlmError) return error
  const text = String(error?.message ?? error)
  const overflow = /prompt is too long|context.?(window|length).?(exceeded|is full)|context_length_exceeded|exceeds the (model's )?(maximum )?context|too many tokens/i
  const code = error?.code === 'NO_ADAPTER' ? 'LOCAL_AGENT_MISSING'
    : overflow.test(text) ? 'CONTEXT_WINDOW_EXCEEDED'
      : /not signed in|not logged in|login required|unauthorized|authentication/i.test(text) ? 'LOCAL_AGENT_SIGNIN'
        : /quota|rate.?limit|usage limit|exceeded/i.test(text) ? 'LOCAL_AGENT_QUOTA'
          : /exited|spawn|ENOENT/i.test(text) ? 'LOCAL_AGENT_EXIT'
            : error?.code ?? 'LOCAL_AGENT_ERROR'
  const hint = code === 'LOCAL_AGENT_SIGNIN' ? ` Sign in with: ${live?.spec?.signIn ?? `${live?.spec?.command ?? 'the CLI'} login`}.` : ''
  return new (LlmError as any)(`${text}${hint}`, code, error?.status === undefined ? {} : { status: error.status })
}
