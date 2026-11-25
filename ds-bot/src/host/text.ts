import { COLORS, EXTRA_COLORS, LEGACY_COLORS, OWN_CHAT_LINE_MAX } from './constants.ts'

export const currentColor = (color: any): any => (typeof color === 'string' && Object.hasOwn(LEGACY_COLORS, color) ? (LEGACY_COLORS as Record<string, string>)[color] : color)
export const isColor = (color: any): boolean => typeof color === 'string' && (COLORS.includes(color) || EXTRA_COLORS.includes(color) || /^#[0-9a-f]{6}$/i.test(color))

export const splitRef = (ref: any): { provider: string, model: string } | undefined => {
  const index = typeof ref === 'string' ? ref.indexOf('/') : -1
  return index > 0 ? { provider: ref.slice(0, index), model: ref.slice(index + 1) } : undefined
}

export const textOf = (content: any): string => (Array.isArray(content) ? content : [])
  .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
  .map((block: any) => block.text)
  .join('\n')
  .trim()

export const normalize = (value: any): string => String(value ?? '').trim().toLowerCase()

export const unquote = (text: any): string => String(text ?? '').trim().replace(/^["'“”「『《]+|["'“”」』》]+$/g, '').trim()

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const excerpt = (text: string, wanted: string, max = OWN_CHAT_LINE_MAX): string => {
  if (text.length <= max) return text
  const at = wanted === '' ? 0 : Math.max(0, text.toLowerCase().indexOf(wanted) - 120)
  return `${at > 0 ? '…' : ''}${text.slice(at, at + max)}…`
}

export const estimateTokens = (text: string): number => {
  let tokens = 0
  for (const char of text) tokens += (char.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.34
  return Math.ceil(tokens)
}
export const clip = (text: string, max: number, rest: any): string => (text.length > max ? `${text.slice(0, max)}… (cut; ${rest})` : text)
export const headOf = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max))

export const createClock = (timeZone?: string) => {
  const clockFormat = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return (time: any): string => (Number.isFinite(time) ? clockFormat.format(time).replace(',', '') : '?')
}

// The prompts in a due scheduled task's message. DSH frames it for the model: one
// task as `reminder_prompt_json: "…"`, several as `reminders_json: [{reminder_prompt}]`.
export function reminderPrompts(text: any): string[] {
  const one = /^reminder_prompt_json: (.*)$/m.exec(String(text ?? ''))
  const batch = /^reminders_json: (.*)$/m.exec(String(text ?? ''))
  try {
    const prompts = [...(one ? [JSON.parse(one[1])] : []), ...(batch ? JSON.parse(batch[1]).map((entry: any) => entry?.reminder_prompt) : [])]
    return prompts.filter((prompt: any) => typeof prompt === 'string' && prompt.trim() !== '')
  } catch {
    return []
  }
}
