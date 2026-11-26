export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const isOpen = card => OPEN_STATUSES.includes(card?.status)
export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
export const NOTE_MAX = 20_000
export const REPLY_MAX = NOTE_MAX
export const charCount = text => [...String(text ?? '')].length
export const noteText = text => String(text ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/(?<![ \t])[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
