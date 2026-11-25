import { dateLocale, t } from './i18n.ts'
import { mentionSpans } from '../shared/mentions.ts'

export const MENTION_ORIGIN = 'https://bots.local/'

export function linkMentions(text, bots, selfId) {
  if (!text || !text.includes('@')) return text
  let out = ''
  let cursor = 0
  for (const span of mentionSpans(text, bots)) {
    if (!span.bot || span.bot.id === selfId) continue
    out += `${text.slice(cursor, span.start)}[${text.slice(span.start + 1, span.end).replace(/[[\]\\]/g, '\\$&')}](${MENTION_ORIGIN}${span.bot.id})`
    cursor = span.end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

export function mentionTarget(event) {
  const anchor = event.target instanceof Element ? event.target.closest(`a[href^="${MENTION_ORIGIN}"]`) : null
  return anchor ? anchor.getAttribute('href').slice(MENTION_ORIGIN.length) : null
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
}
const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
const daysBefore = (date, now) => Math.round((midnight(new Date(now)) - midnight(date)) / 86400000)
export function dayLabel(ms) {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? t('Today {time}', { time: clock(ms) }) : `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(ms)}`
}

export function clockLabel(time, now = Date.now()) {
  const date = new Date(time)
  const days = daysBefore(date, now)
  const stamp = clock(time)
  if (days === 0) return t('Today {time}', { time: stamp })
  if (days === 1) return t('Yesterday {time}', { time: stamp })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })} ${stamp}`
}

export function messageClock(time, now = Date.now()) {
  return daysBefore(new Date(time), now) === 0 ? clock(time) : clockLabel(time, now)
}

export function relativeShort(ms) {
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return t('just now')
  if (diff < 3_600_000) return t('{n} min', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} h', { n: Math.floor(diff / 3_600_000) })
  if (diff < 30 * 86_400_000) return t('{n} d', { n: Math.floor(diff / 86_400_000) })
  return new Date(ms).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })
}

export function elapsedLabel(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  return `${hours > 0 ? `${hours}h ` : ''}${total >= 60 ? `${Math.floor(total / 60) % 60}m ` : ''}${total % 60}s`
}

// A model that writes its tool call in DSML form can leave the closing tags in
// the text block DSH hands the chat. They are wire syntax, not part of the reply.
const DSML_CLOSING_TAG = /<\/DSML\s+(?:invoke|calls)\s*>/i
const DSML_EDGE_TOP = /^(?:[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*(?:\r?\n|$))+/i
const DSML_EDGE_END = /(?:\r?\n[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*)+$/i
const DSML_TAG_LINE = /\r?\n[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*(?=\r?\n)/gi
const DSML_TAG_INLINE = /[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*/gi
export const stripToolCallTags = (text) => {
  const value = String(text ?? '')
  if (!DSML_CLOSING_TAG.test(value)) return value
  return value
    .replace(DSML_EDGE_TOP, '')
    .replace(DSML_EDGE_END, '')
    .replace(DSML_TAG_LINE, '')
    .replace(DSML_TAG_INLINE, (match, offset, whole) => {
      const before = offset > 0 ? whole[offset - 1] : ''
      const after = whole[offset + match.length] ?? ''
      return before && after && !/\s/.test(before) && !/\s/.test(after) ? ' ' : ''
    })
}
export const contentText = content => (content ?? [])
  .filter(block => block?.type === 'text')
  .map(block => (typeof block.text === 'string' ? stripToolCallTags(block.text) : ''))
  .join('\n')
export const HEADER = /^\[(Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/
export const currentPart = bot => bot.sessionId ?? bot.id
// The prompts in a due scheduled task's message. DSH frames it for the model: one
// task as `reminder_prompt_json: "…"`, several as `reminders_json: [{reminder_prompt}]`.
export function reminderPrompts(text) {
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    const prompts = [...(one ? [JSON.parse(one[1])] : []), ...(batch ? JSON.parse(batch[1]).map(entry => entry.reminder_prompt) : [])]
    return prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  } catch {
    return []
  }
}
export const stripHeader = text => text.replace(HEADER, '')

export function latestMemoryChange(news, ids) {
  const at = id => (news?.[id]?.seen ? news[id].at ?? 0 : 0)
  return ids.reduce((best, id) => (at(id) > at(best) ? id : best), ids[0] ?? null)
}

export function summaryBlocks(text) {
  const blocks = []
  let paragraph = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/\*\*|__/g, '')
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', text: heading[1].trim() })
    } else if (line === '') {
      flush()
    } else {
      paragraph.push(line.replace(/^[-*•]\s+/, ''))
    }
  }
  flush()
  return blocks
}

export function isHiddenTurn(roster, sessionId, turn) {
  if (sessionId === undefined || turn === undefined) return false
  return (roster.exchangeTurns[sessionId] ?? []).includes(turn)
}

export const toolName = root => root.name || root.call?.name

export function toolArgs(root) {
  if (typeof root.args?.text === 'function') {
    return { text: key => root.args.text(key) ?? undefined, value: key => (typeof root.args.value === 'function' ? root.args.value(key) : undefined) }
  }
  let parsed
  const object = () => {
    if (parsed === undefined) {
      try { parsed = JSON.parse(root.argsRaw ?? root.call?.argsRaw ?? '') } catch { parsed = null }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) parsed = null
    }
    return parsed
  }
  return {
    text: (key) => { const value = object()?.[key]; return typeof value === 'string' ? value : undefined },
    value: key => object()?.[key],
  }
}

const RELAY_ROLES = new Set(['request', 'reply', 'stopped'])
export const isRelayContext = (data) => {
  const source = data?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'bot' || source.handoff === true) return false
  if (source.deferred === true || source.resumed === true || source.retried === true) return false
  return RELAY_ROLES.has(source.role) && typeof source.senderSessionId === 'string'
}

// 'context' chat nodes never reach the flow on DSH 0.2, so a relay spliced into
// a running turn would be invisible; the step that answers it renders the line.
// A relay attaches to the next step that renders a cell: tool-only steps mount
// nothing (ui-chat gives them no visible node), so `prev` is the previous step
// with visible content, not the previous step in the list.
// `contexts` and `steps` are the turn's turnDataSource lists (anchor order) and
// `step` is the rendering step's own data. A step is found by its number: the
// cell's node data and the source's entries can be different snapshot objects.
const stepShows = (step) => (step?.blocks ?? []).some(block => {
  // ui-chat's mount rule for a step node: non-empty reasoning, or reply content
  // (`hasAssistantReplyContent`); a tool call alone keeps the node hidden.
  if (block === undefined || block.kind === 'tool-call') return false
  return block.kind === 'text' || block.kind === 'reasoning' ? String(block.text ?? '').trim() !== '' : true
})
const stepHasReasoning = (step) => (step?.blocks ?? []).some(block => block?.kind === 'reasoning' && String(block.text ?? '').trim() !== '')
export const relayPart = (data, groupPart) => groupPart === undefined || (stepHasReasoning(data) ? groupPart === 'reasoning' : groupPart === 'response')
export function relaysBefore(contexts, steps, step) {
  const index = steps.findIndex(entry => entry?.step === step?.step)
  if (index === -1) return []
  let prev = -Infinity
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (stepShows(steps[cursor])) { prev = steps[cursor].time; break }
  }
  return (contexts ?? []).filter(data => isRelayContext(data) && typeof data.time === 'number' && data.time >= prev && data.time < step.time)
}

export function commRunOf(order, peers, turn, hiddenTurns = []) {
  const turns = []
  for (const entry of order) {
    const peer = peers[entry]
    const hidden = hiddenTurns.includes(entry)
    if (hidden && peer === undefined) continue
    turns.push({ turn: entry, peer, hidden })
  }
  const at = turns.findIndex(entry => entry.turn === turn)
  if (at === -1 || turns[at].peer === undefined) return null
  const previous = turns[at - 1]
  if (previous?.peer !== undefined && previous.hidden) return 'folded'
  let count = 0
  const peerIds = []
  for (let index = at; index < turns.length; index += 1) {
    const entry = turns[index]
    if (entry.peer === undefined || (index > at && !turns[index - 1].hidden)) break
    count += entry.hidden ? 2 : 1
    if (!peerIds.includes(entry.peer)) peerIds.push(entry.peer)
  }
  return { count, peerIds }
}

export function previewOf(list, id, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  for (let index = outline.length - 1; index >= 0; index -= 1) {
    const entry = outline[index]
    if (hiddenTurns.includes(entry.turn)) continue
    const text = entry.response || entry.prompt || ''
    if (text !== '') return stripHeader(text).replace(/\s+/g, ' ').trim()
  }
  return ''
}

const formatTokens = count => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count))

export function usageOf(list, ids) {
  let input = 0
  let cacheRead = 0
  let output = 0
  for (const id of ids) {
    const usage = list.projectionsBySession?.[id]?.values?.tokenUsage
    if (!usage) continue
    input += (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    cacheRead += usage.cacheReadTokens ?? 0
    output += usage.outputTokens ?? 0
  }
  if (input + output === 0) return ''
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return t('{tokens} tok · Cache hit {hit}%', { tokens: formatTokens(input + output), hit })
}

function percentText(part, whole) {
  if (part >= whole) return '100'
  for (let places = 0; places < 3; places += 1) {
    const text = ((part / whole) * 100).toFixed(places)
    if (Number(text) < 100) return text
  }
  return '99.99'
}

export function runStatsOf(values) {
  const stats = values?.sessionStats
  const usage = values?.tokenUsage
  const pressure = values?.contextPressure
  const shown = []
  if (stats?.turns > 0) shown.push({ key: 'turns', text: stats.turns === 1 ? t('1 turn') : t('{count} turns', { count: stats.turns }) })
  if (stats?.decodeMs > 0 && stats.decodeTokens > 0) {
    const speed = stats.decodeTokens / (stats.decodeMs / 1000)
    shown.push({ key: 'speed', text: t('{speed} tok/s', { speed: speed >= 10 ? Math.round(speed) : Math.round(speed * 10) / 10 }) })
  }
  const prompt = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
  if (prompt > 0) shown.push({ key: 'cache', text: t('Cache hit {hit}%', { hit: percentText(usage.cacheReadTokens ?? 0, prompt) }) })
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (Number.isFinite(used) && pressure.contextWindow > 0) {
    shown.push({
      key: 'context',
      text: t('Context {percent}%', { percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)) }),
      title: t('{used} of {total} tokens of context in use', { used: formatTokens(used), total: formatTokens(pressure.contextWindow) }),
    })
  }
  return shown
}
