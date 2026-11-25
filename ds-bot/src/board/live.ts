export const LIVE_STEPS = 60
export const LIVE_THINK_MAX = 4000
const LIVE_INPUT_MAX = 600
const LIVE_OUTPUT_MAX = 1200
export const LEVELS = ['off', 'tools', 'thinking', 'all']
export const DEFAULT_LEVEL = 'thinking'
export const levelOf = value => (LEVELS.includes(value) ? value : DEFAULT_LEVEL)
const KEPT = {
  tools: { steps: 24, think: 0, input: 300, output: 600 },
  thinking: { steps: 24, think: 2000, input: 300, output: 600 },
  all: { steps: 60, think: 8000, input: LIVE_INPUT_MAX, output: LIVE_OUTPUT_MAX },
}
export const KEPT_STEPS = KEPT.thinking.steps
export const KEPT_THINK_MAX = KEPT.thinking.think
const SESSIONS_MAX = 64
const SAME_TURN_MS = 2000
const ACTIVITY = '▸ '

const tail = (text, max) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`)
const head = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const parse = (argumentsText) => {
  try { return typeof argumentsText === 'string' ? JSON.parse(argumentsText || '{}') : argumentsText ?? {} } catch { return argumentsText }
}

export function inputText(argumentsText) {
  const args = parse(argumentsText)
  if (typeof args === 'string') return args.trim()
  if (args === null || typeof args !== 'object') return ''
  return Object.entries(args).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')
}

export function outputText(data) {
  const content = data?.message?.content ?? data?.result ?? data?.output
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '')).join('')
  else if (content !== undefined && content !== null) text = JSON.stringify(content)
  const error = typeof data?.error === 'string' ? data.error : data?.error?.message
  return (text.trim() === '' && typeof error === 'string' ? error : text).trim()
}

// Reasoning can open with a `<signature>` block meant for the model, not the reader.
export function visibleThought(text) {
  if (text[0] !== '<') return text
  if ('<signature>'.startsWith(text)) return ''
  if (!text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}

export function callAbout(argumentsText) {
  const args = parse(argumentsText)
  if (args === null || typeof args !== 'object') return {}
  const first = keys => keys.map(key => args[key]).find(value => typeof value === 'string' && value.trim() !== '')?.replace(/\s+/g, ' ').trim()
  const note = first(['description', 'justification'])
  const path = first(['file_path', 'path'])
  const url = first(['url'])
  let site
  try { site = url && new URL(url).host } catch { site = undefined }
  const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site ?? first(['command', 'cmd'])
  return { ...(note ? { note: note.slice(0, 120) } : {}), ...(target ? { target: target.slice(0, 80) } : {}) }
}

export function stepsOf(trace) {
  const out = []
  for (const step of trace.steps) {
    if (step.kind !== 'think') {
      const { kind, tool, note, target, input, output, state } = step
      out.push({ kind, tool, ...(note ? { note } : {}), ...(target ? { target } : {}), ...(input ? { input } : {}), ...(output ? { output } : {}), state })
      continue
    }
    let thought = []
    const flush = () => {
      const text = thought.join('\n').trim()
      if (text !== '') out.push({ kind: 'think', text })
      thought = []
    }
    for (const line of visibleThought(step.text).split('\n')) {
      if (!line.startsWith(ACTIVITY)) { thought.push(line); continue }
      flush()
      const text = line.slice(ACTIVITY.length).trim()
      if (text !== '') out.push({ kind: 'tool', text, state: 'done' })
    }
    flush()
  }
  const last = out.at(-1)
  if (trace.endedAt === undefined && last?.kind === 'tool' && last.text !== undefined) last.state = 'running'
  return out
}

export const shownAt = (steps, level) => (level === 'off' ? [] : level === 'tools' ? steps.filter(step => step.kind === 'tool') : steps)

export function keep(trace, level = DEFAULT_LEVEL) {
  const limits = KEPT[levelOf(level)]
  if (limits === undefined) return undefined
  const steps = shownAt(stepsOf(trace), level).slice(-limits.steps)
  let budget = limits.think
  const kept = []
  for (const step of steps.reverse()) {
    if (step.kind !== 'think') {
      const { input, output, ...line } = step
      kept.push({
        ...line,
        ...(input ? { input: head(input, limits.input) } : {}),
        ...(output ? { output: head(output, limits.output) } : {}),
        state: step.state === 'failed' ? 'failed' : 'done',
      })
      continue
    }
    if (budget <= 0) continue
    const text = tail(step.text, budget)
    budget -= text.length
    kept.push({ kind: 'think', text })
  }
  if (kept.length === 0) return undefined
  return { ms: Math.max(0, (trace.endedAt ?? trace.since) - trace.since), steps: kept.reverse() }
}

export function createLive({ identity, now = Date.now }) {
  const traces = new Map()
  const attempts = new Map()

  const evict = () => {
    if (traces.size <= SESSIONS_MAX) return
    const ended = [...traces].filter(([, trace]) => trace.endedAt !== undefined).sort((a, b) => a[1].endedAt - b[1].endedAt)
    for (const [id] of ended.slice(0, traces.size - SESSIONS_MAX)) traces.delete(id)
  }
  const begin = (sessionId, at) => {
    traces.delete(sessionId)
    traces.set(sessionId, { since: at, steps: [] })
    evict()
  }
  const traceOf = (sessionId) => {
    if (!traces.has(sessionId)) begin(sessionId, now())
    return traces.get(sessionId)
  }
  const push = (trace, step) => {
    trace.steps.push(step)
    if (trace.steps.length > LIVE_STEPS) trace.steps.splice(0, trace.steps.length - LIVE_STEPS)
  }
  const toolStep = (trace, id) => (typeof id === 'string' ? trace.steps.findLast(step => step.kind === 'tool' && step.id === id) : undefined)
  const isBots = sessionId => typeof sessionId === 'string' && identity.ownerOfSession(sessionId) !== undefined

  function onEvent(sessionId, event) {
    if (!isBots(sessionId)) return
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        begin(sessionId, event.time ?? now())
        break
      case 'turn/end': {
        const trace = traces.get(sessionId)
        if (trace === undefined) break
        trace.endedAt = event.time ?? now()
        for (const step of trace.steps) if (step.state === 'running') step.state = 'done'
        break
      }
      case 'tool/call':
      case 'tool/ptc-dispatch-start': {
        const id = event.type === 'tool/call' ? data.callId : data.subCallId
        const name = String(data.name ?? '')
        if (name === '') break
        const input = head(inputText(data.arguments), LIVE_INPUT_MAX)
        push(traceOf(sessionId), { kind: 'tool', id, tool: name, ...callAbout(data.arguments), ...(input ? { input } : {}), state: 'running' })
        break
      }
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        const trace = traces.get(sessionId)
        const id = event.type === 'tool/result' ? data.message?.toolCallId : data.subCallId
        const step = trace === undefined ? undefined : toolStep(trace, id)
        if (step === undefined) break
        step.state = data.message?.isError === true || data.error !== undefined ? 'failed' : 'done'
        const output = head(outputText(data), LIVE_OUTPUT_MAX)
        if (output) step.output = output
        break
      }
    }
  }

  function onFrame(sessionId, frame) {
    if (frame?.type === 'start') {
      if (isBots(sessionId)) attempts.set(frame.attemptId, sessionId)
      return
    }
    const owner = attempts.get(frame?.attemptId)
    if (owner === undefined) return
    if (frame.type === 'chunk') {
      if (frame.chunk?.type !== 'reasoning-delta' || typeof frame.chunk.text !== 'string') return
      const trace = traceOf(owner)
      const last = trace.steps.at(-1)
      if (last?.kind === 'think' && last.attemptId === frame.attemptId) last.text = tail(last.text + frame.chunk.text, LIVE_THINK_MAX)
      else push(trace, { kind: 'think', attemptId: frame.attemptId, text: frame.chunk.text })
      return
    }
    if (frame.type === 'end') {
      attempts.delete(frame.attemptId)
      if (frame.outcome?.kind === 'abandoned' || frame.outcome?.eventType === 'assistant/attempt') {
        const trace = traces.get(owner)
        if (trace !== undefined) trace.steps = trace.steps.filter(step => step.attemptId !== frame.attemptId)
      }
    }
  }

  const sessionsOf = (botId, roomId, cardId) => [...traces].filter(([id]) => {
    const owner = identity.ownerOfSession(id)
    return owner !== undefined && owner.botId === botId
      && (cardId === undefined ? owner.cardId === undefined && owner.roomId === roomId : owner.cardId === cardId)
  })

  return {
    onEvent,
    onFrame,
    current({ botId, roomId, cardId, since }: any, level = DEFAULT_LEVEL) {
      if (level === 'off') return undefined
      const found = sessionsOf(botId, roomId, cardId).map(([, trace]) => trace).filter(trace => trace.since >= since)
        .sort((a, b) => b.since - a.since)[0]
      if (found === undefined) return undefined
      const steps = shownAt(stepsOf(found), level)
      return steps.length === 0 ? undefined : { since: found.since, ...(found.endedAt === undefined ? {} : { endedAt: found.endedAt }), steps }
    },
    kept({ botId, roomId, cardId, sessionId, since }: any, level = DEFAULT_LEVEL) {
      if (level === 'off') return undefined
      const found = sessionsOf(botId, roomId, cardId).filter(([id]) => sessionId === undefined || id === sessionId).map(([, trace]) => trace)
        .filter(trace => Math.abs(trace.since - since) <= SAME_TURN_MS)
        .sort((a, b) => Math.abs(a.since - since) - Math.abs(b.since - since))[0]
      return found === undefined ? undefined : keep(found, level)
    },
  }
}
