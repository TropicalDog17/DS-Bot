export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const isOpen = card => OPEN_STATUSES.includes(card?.status)
export { NOTE_MAX, REPLY_MAX, CARD_NOTE_MAX, charCount, isBlankNote, noteLengthError, noteText, oneLine } from '../host/note-text.ts'
