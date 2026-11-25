import { createHash, randomBytes } from 'node:crypto'

export const MEMORY_LIMITS = { entry: 300, group: 12_000, bot: 8_000, team: 4_000, topic: 16_000, topics: 40 }
export const WINDOW_SHARE = 0.02

export const MAIN = 'MEMORY.md'
export const TEAM_SHARED = 'shared'
export const EMPTY_MAIN = '# Memory\n\n## Index\n'
export const INDEX = /^##\s+index\s*$/i
export const HEADING = /^#{1,6}\s/
const META = /\s*\[([A-Za-z][\w-]*:[^\];]*(?:;\s*[A-Za-z][\w-]*:[^\];]*)*)\]\s*$/

export const NO_MATCH = 'memory/no-match'
export const GONE = 'memory/bot-gone'
export const DENIED = 'memory/denied'
export const ROUTED = new Set([NO_MATCH, GONE, DENIED])
export const REVIEW_MEMORY_MAX = 16_000

export function splitMeta(body) {
  const found = META.exec(body)
  if (found === null) return { text: body.trim(), meta: {} }
  const meta = {}
  for (const pair of found[1].split(';')) {
    const at = pair.indexOf(':')
    const key = pair.slice(0, at).trim().toLowerCase()
    if (key !== '') meta[key] = pair.slice(at + 1).trim()
  }
  return { text: body.slice(0, found.index).trim(), meta }
}

const metaValue = value => String(value ?? '').replace(/[;[\]\n]/g, ' ').replace(/\s+/g, ' ').trim()
export const bodySize = parsed => parsed.entries.reduce((sum, entry) => sum + entry.text.length, 0)

export const entryId = entry => entry.meta?.id ?? createHash('sha256').update(squash(entry.text)).digest('hex').slice(0, 4)
export function newEntryId(entries) {
  const taken = new Set(entries.map(entryId))
  for (;;) {
    const id = randomBytes(2).toString('hex')
    if (!taken.has(id)) return id
  }
}
const ABOUT_MAX = 60
export function topicAbout(parsed) {
  const note = parsed.lines.find(line => /^>\s*\S/.test(line))?.replace(/^>\s*/, '') ?? ''
  return note.length > ABOUT_MAX ? `${note.slice(0, ABOUT_MAX)}…` : note
}

export const isPinned = entry => Boolean(entry.meta?.pinned)
const DAY = /^\d{4}-\d{2}-\d{2}$/
export const cleanDay = raw => (DAY.test(String(raw ?? '').trim()) ? String(raw).trim() : undefined)
export const isExpired = (entry, today) => DAY.test(String(entry.meta?.until ?? '')) && entry.meta.until < today

export function promptEntry(entry) {
  const day = /^\d{4}-(\d{2}-\d{2})$/.exec(String(entry.meta?.added ?? ''))?.[1]
  return `- ${entry.text} [${[entryId(entry), day].filter(Boolean).join(' · ')}]`
}

export function fitWindow(entries, tokens, measure) {
  if (tokens === undefined) return { shown: entries, left: 0 }
  const order = entries.map((entry, at) => ({ entry, at })).sort((a, b) => Number(isPinned(b.entry)) - Number(isPinned(a.entry)) || String(b.entry.meta?.added ?? '').localeCompare(String(a.entry.meta?.added ?? '')) || b.at - a.at)
  const kept = new Set()
  let used = 0
  for (const { entry } of order) {
    const cost = measure(promptEntry(entry))
    if (used + cost > tokens) continue
    used += cost
    kept.add(entry)
  }
  return { shown: entries.filter(entry => kept.has(entry)), left: entries.length - kept.size }
}

export function formatEntry(text, meta = {}) {
  const pairs = Object.entries(meta).filter(([, value]) => metaValue(value) !== '').map(([key, value]) => `${key}: ${metaValue(value)}`)
  return `- ${text}${pairs.length > 0 ? ` [${pairs.join('; ')}]` : ''}`
}

export function cleanEntry(raw) {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^(?:[-*•]\s+)+/, '')
  return splitMeta(line).text
}

// A flat file name: case folds on some file systems, so names are lower case.
export function cleanTopic(raw) {
  const name = String(raw ?? '').trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').trim().toLowerCase().replace(/\s+/g, '-')
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u.test(name) && name !== 'memory' ? name : undefined
}

export function parseMemory(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  const entries = []
  const links = []
  let inIndex = false
  lines.forEach((line, index) => {
    if (HEADING.test(line)) {
      inIndex = INDEX.test(line.trim())
      return
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet === null) return
    if (inIndex) {
      for (const match of bullet[1].matchAll(/\[\[([^\]]+)\]\]/g)) links.push(match[1].trim())
      return
    }
    const { text, meta } = splitMeta(bullet[1])
    if (text !== '') entries.push({ line: index, text, meta })
  })
  return { lines, entries, links }
}

export const joinLines = lines => `${lines.join('\n')}\n`

export function insertEntry(lines, line) {
  const index = lines.findIndex(item => INDEX.test(item.trim()))
  const end = index === -1 ? lines.length : index
  let at = end
  while (at > 0 && lines[at - 1].trim() === '') at -= 1
  const head = lines.slice(0, at)
  if (head.length > 0 && HEADING.test(head.at(-1))) head.push('')
  const tail = lines.slice(end)
  return [...head, line, ...(tail.length > 0 ? ['', ...tail] : [])]
}

export function addLink(lines, topic) {
  const next = [...lines]
  let index = next.findIndex(item => INDEX.test(item.trim()))
  if (index === -1) {
    if (next.length > 0) next.push('')
    next.push('## Index')
    index = next.length - 1
  }
  let end = next.findIndex((item, at) => at > index && HEADING.test(item))
  if (end === -1) end = next.length
  let at = end
  while (at > index + 1 && next[at - 1].trim() === '') at -= 1
  next.splice(at, 0, `- [[${topic}]]`)
  return next
}

export function removeLink(lines, topic) {
  return lines.filter(line => !/^\s*[-*]\s+\[\[([^\]]+)\]\]\s*$/.test(line) || /\[\[([^\]]+)\]\]/.exec(line)[1].trim() !== topic)
}

export const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

export function matchEntries(entries, wanted) {
  const key = squash(cleanEntry(wanted))
  if (key === '') return []
  const named = entries.find(entry => entry.meta?.id === key || (/^[0-9a-f]{4}$/.test(key) && entryId(entry) === key))
  if (named !== undefined) return [named]
  const exact = entries.find(entry => squash(entry.text) === key)
  if (exact !== undefined) return [exact]
  return entries.filter(entry => squash(entry.text).includes(key))
}

const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
]
export function looksLikeKey(text) {
  if (KEY_PATTERNS.some(pattern => pattern.test(text))) return true
  const bare = text.replace(/\bhttps?:\/\/\S+/g, ' ')
  return (bare.match(/[A-Za-z0-9+=]{32,}/g) ?? []).some(run => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run))
}

const PASSWORD_GIVEN = /(?:密码(?!管理|策略|规则)|口令|验证码|校验码|\bpassw(?:or)?d\b(?!\s*(?:managers?|polic(?:y|ies)|rules?|resets?|strength|less)\b)|\bpwd\b|\bpin(?: code)?\b|\bpass(?:code|phrase)\b|\b(?:otp|cvv|cvc)\b|\b(?:security|verification) code\b)[^\n.。;；,，]{0,40}?(?:是|(?<![因作认成以行])为|还是|改成|改为|换成|设为|设成|用(?![户于来途])(?!\s*\S+\s*(?:管理|保存|存|记))|叫|:|：|=|\b(?:is|are|was|remains|stays|becomes)\b|\b(?:set|changed) to\b)\s*\S/i
const PASSWORD_AFTER = /(?:\b(?:use[sd]?|using|set|sets|chose|chosen|picked|picks)\s+(?:[^\s,.;]+\s+){1,8}?(?:as|for)\s+(?:[\w'-]+\s+){0,3}?(?:passw(?:or)?d\b(?!\s*(?:managers?|polic(?:y|ies)|rules?|resets?|strength|fields?|prompts?|screens?|box(?:es)?)\b)|pwd\b|pin\b(?!\s*(?:pads?|entry|fields?|prompts?|screens?)\b)|pass(?:code|phrase)\b|otp\b)|用(?![户于来途])[^\n,，。;；]{1,40}?(?:当作?|作为?|做)\s*\S{0,6}?(?:密码(?!管理)|口令|验证码))/i
const ID_GIVEN = /(?:\bssn\b|\bsocial security\b|\bpassport\b|\btax (?:id|number)\b|\bdriver'?s licen[cs]e\b|\bnational (?:id|insurance)\b|\bid (?:card|number)\b|护照|身份证|社保|税号|驾驶证|驾照)[^\n.。;；,，]{0,30}?(?<![A-Za-z0-9-])(?!\d{4}-\d{1,2}-\d{1,2}(?!\d))[a-z]{0,2}\d[\d -]{4,}\d/i

export function looksSecret(text) {
  if (looksLikeKey(text)) return true
  if (PASSWORD_GIVEN.test(text) || PASSWORD_AFTER.test(text) || ID_GIVEN.test(text)) return true
  return /\d{15,}/.test(text.replace(/\bhttps?:\/\/\S+/g, ' ').replace(/(?<=\d) (?=\d)/g, '').replace(/(?<=\d{3})-(?=\d{3})/g, ''))
}

export function parseAsk(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1))
      if (value !== null && typeof value === 'object') {
        return { reply: String(value.reply ?? '').trim(), changes: Array.isArray(value.changes) ? value.changes : [] }
      }
    } catch {}
  }
  return { reply: text.trim(), changes: [] }
}

export const wordsOf = (text) => {
  const lower = squash(text)
  const words = new Set(lower.match(/[a-z0-9]{3,}/g) ?? [])
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) for (let at = 0; at + 1 < run.length; at += 1) words.add(run.slice(at, at + 2))
  return words
}

export function reviewEntries(home, team, budget = REVIEW_MEMORY_MAX, about = '', tag = 'own') {
  const tagged = (files, scope) => files.flatMap(file => file.entries.map(entry => ({ ...entry, file, scope })))
  const main = [...tagged(home.slice(0, 1), tag), ...tagged(team.slice(0, 1), 'team')]
  const topics = [...tagged(home.slice(1), tag), ...tagged(team.slice(1), 'team')]
  let used = main.reduce((sum, entry) => sum + entry.text.length, 0)
  const asked = wordsOf(about)
  const shared = entry => [...wordsOf(`${entry.text} ${entry.file.topic ?? ''}`)].filter(word => asked.has(word)).length
  const newest = topics.map((entry, at) => ({ entry, at, score: shared(entry) }))
    .sort((a, b) => b.score - a.score || String(b.entry.meta?.added ?? '').localeCompare(String(a.entry.meta?.added ?? '')) || a.at - b.at)
  const shown = new Set()
  for (const { entry } of newest) {
    if (used + entry.text.length > budget) continue
    used += entry.text.length
    shown.add(entry)
  }
  return { numbered: [...main, ...topics.filter(entry => shown.has(entry))], left: topics.length - shown.size }
}

const SENTENCE_END = /[.!?;:](?=\s)|[。！？；：]/g
export function splitEntry(text, max) {
  const pieces = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    const ends = [...window.matchAll(SENTENCE_END)].map(match => match.index + 1).filter(at => at <= max)
    const space = window.lastIndexOf(' ', max)
    const floor = Math.floor(max / 3)
    let cut = ends.findLast(at => at >= floor) ?? (space >= floor ? space : max)
    // A cut between the two halves of a surrogate pair would break the character.
    if (cut === max && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

export function parseShortened(text, count) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let value
  try {
    value = start === -1 || end <= start ? undefined : JSON.parse(text.slice(start, end + 1))
  } catch {
    value = undefined
  }
  const lists = Array.isArray(value?.entries) ? value.entries : []
  return Array.from({ length: count }, (_, at) => {
    const list = lists[at]
    if (!Array.isArray(list) || list.length === 0 || !list.every(item => typeof item === 'string' && item.trim() !== '')) return undefined
    return list
  })
}

export function parseReview(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let value
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || !Array.isArray(value.changes)) return undefined
  const changes = []
  const leftOut = []
  for (const change of value.changes) (wellFormed(change) ? changes : leftOut).push(change)
  return { changes, leftOut }
}
const wellFormed = (change) => {
  if (change === null || typeof change !== 'object') return false
  const texted = typeof change.text === 'string' && change.text.trim() !== ''
  const numbered = Number.isInteger(Number(change.entry)) && Number(change.entry) >= 1
  if (change.op === 'add') return texted && (change.topic === undefined || typeof change.topic === 'string') && (change.team === undefined || typeof change.team === 'boolean') && (change.for === undefined || typeof change.for === 'string') && (change.group === undefined || typeof change.group === 'string') && (change.until === undefined || typeof change.until === 'string')
  if (change.op === 'edit') return texted && numbered
  return change.op === 'remove' && numbered
}
