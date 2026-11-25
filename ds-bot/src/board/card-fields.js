// A card is open until it is finished or cancelled. "active" is the In progress column.
export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const isOpen = card => OPEN_STATUSES.includes(card?.status)
export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
