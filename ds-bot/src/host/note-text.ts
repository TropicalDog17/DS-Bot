export const NOTE_MAX = 20_000
export const REPLY_MAX = NOTE_MAX
export const CARD_NOTE_MAX = NOTE_MAX

export const charCount = text => [...String(text ?? '')].length
export const noteText = text => String(text ?? '').replace(/\r\n?/g, '\n').trimEnd()
export const isBlankNote = text => !/[^\s\p{Cf}\u3164\u115f\u1160]/u.test(String(text ?? ''))
export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function noteLengthError(text, max = NOTE_MAX) {
  const count = charCount(text)
  return count > max ? `The note is ${count} characters; the limit is ${max}. Shorten it and send it again.` : undefined
}
