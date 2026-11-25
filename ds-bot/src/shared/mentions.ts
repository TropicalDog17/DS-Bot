export const ALL_WORDS = ['all', 'everyone', '所有人', '全体']
export const USER_NAMES = ['user', 'you']
export const speakerOf = line => (line.botId !== undefined && USER_NAMES.includes(String(line.who ?? '').trim().toLowerCase()) ? `Bot "${line.who}"` : line.who)
// A letter, digit, "_" or "-" after a name means a longer word ("@Mi" in "@MiniMax"),
// and "/", "\" or a "." that goes on into a word mean a path: DSH writes a file
// reference as "@docs/guide.md", which must not call a Bot named Docs. A letter,
// digit, "_", "." or "/" before "@" means an address ("a@b", "medium.com/@Writer").
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i
const ADDRESS_BEFORE = /[a-z0-9_./]/i
const LITERAL = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g

const fitsAt = (text, at, word) => text.slice(at, at + word.length).toLowerCase() === word.toLowerCase()
  && !NAME_GOES_ON.test(text.slice(at + word.length))
const overlaps = (spans, start, end) => spans.some(span => start < span.end && span.start < end)

export function nameProblem(name) {
  const text = String(name ?? '').trim()
  if (text === '') return 'A Bot needs a name'
  if (/[@`\r\n]/.test(text)) return 'A Bot name cannot contain @, ` or a line break'
  if (ALL_WORDS.includes(text.toLowerCase())) return `"${text}" calls everyone in a group, so it cannot be a Bot name`
  if (USER_NAMES.includes(text.toLowerCase())) return `"${text}" stands for the user in a chat, so it cannot be a Bot name`
  return undefined
}

// DSH writes each referenced conversation into the message once as "@label"; that one
// occurrence per listed label is a reference, not a call. Longest labels go first so
// "@K notes" is never read as the label "K".
export function referenceSpans(text, labels = []) {
  const spans = []
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const mention = `@${label}`
    for (let at = text.indexOf(mention); at !== -1; at = text.indexOf(mention, at + 1)) {
      const end = at + mention.length
      if ((at > 0 && ADDRESS_BEFORE.test(text[at - 1])) || NAME_GOES_ON.test(text.slice(end)) || overlaps(spans, at, end)) continue
      spans.push({ start: at, end, label })
      break
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

export function mentionSpans(text, bots, { references = [] } = {}) {
  const value = String(text ?? '')
  const skip = [
    ...[...value.matchAll(LITERAL)].map(match => ({ start: match.index, end: match.index + match[0].length })),
    ...referenceSpans(value, references),
  ]
  const byLength = bots.filter(bot => bot?.name).sort((a, b) => b.name.length - a.name.length)
  const spans = []
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(value[at - 1])) || overlaps(skip, at, at + 1)) continue
    const bot = byLength.find(candidate => fitsAt(value, at + 1, candidate.name))
    const all = bot ? undefined : ALL_WORDS.find(word => fitsAt(value, at + 1, word))
    if (!bot && !all) continue
    const end = at + 1 + (bot ? bot.name.length : all.length)
    spans.push(bot ? { start: at, end, bot } : { start: at, end, all: true })
    at = end - 1
  }
  return spans
}
