export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const isOpen = card => OPEN_STATUSES.includes(card?.status)
export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
export const NOTE_MAX = 20_000
export const REPLY_MAX = NOTE_MAX
export const charCount = text => [...String(text ?? '')].length
export const noteText = text => String(text ?? '').replace(/\r\n?/g, '\n').trimEnd()
export const isBlankNote = text => noteText(text).replace(/[\s\u200b-\u200d\ufeff]/gu, '') === ''

export function noteLengthError(text, max = NOTE_MAX) {
  const count = charCount(text)
  return count > max ? `The note is ${count} characters; the limit is ${max}. Shorten it and send it again.` : undefined
}
