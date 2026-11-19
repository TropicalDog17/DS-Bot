// The user's work board as data: the card shape, its limits, and the one-time move of
// the old per-group task boards onto it. No runtime here, so the store can migrate a
// saved team before any tool or endpoint runs.
import { randomBytes } from 'node:crypto'

// `active` is the In progress column; the name stays from the group task board.
export const CARD_STATUSES = ['todo', 'active', 'review', 'blocked', 'done', 'cancelled']
export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const TITLE_MAX = 200
export const PROGRESS_MAX = 300
export const RESULT_MAX = 2000
export const NOTE_MAX = 500
export const REASON_MAX = 500
export const KEY_MAX = 32
export const URL_MAX = 2000
export const LINKS_MAX = 20

export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
export const newCardId = () => `c_${randomBytes(4).toString('hex')}`
export const isOpen = card => OPEN_STATUSES.includes(card?.status)

// A ticket key as Jira writes it (LIFE-782), upper-cased; undefined for anything else.
export function ticketKey(text) {
  const key = String(text ?? '').trim().toUpperCase()
  return key.length <= KEY_MAX && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined
}

// An http(s) address, or undefined.
export function webUrl(text) {
  const raw = String(text ?? '').trim()
  if (raw === '' || raw.length > URL_MAX) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export const boardOf = state => {
  if (state.board === null || typeof state.board !== 'object' || Array.isArray(state.board)) state.board = { cards: {} }
  if (state.board.cards === null || typeof state.board.cards !== 'object' || Array.isArray(state.board.cards)) state.board.cards = {}
  return state.board
}

// Group tasks saved before the board existed become cards that remember their group,
// so the group's details panel still lists them and a note still goes to the group.
// Returns whether anything moved.
export function migrateRoomTasks(state) {
  let moved = false
  for (const room of Object.values(state.rooms ?? {})) {
    if (room?.tasks === undefined) continue
    const tasks = room.tasks !== null && typeof room.tasks === 'object' ? Object.values(room.tasks) : []
    delete room.tasks
    moved = true
    const cards = boardOf(state).cards
    for (const task of tasks) {
      if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || cards[task.id] !== undefined) continue
      const status = CARD_STATUSES.includes(task.status) ? task.status : 'active'
      const at = Number.isFinite(task.startedAt) ? task.startedAt : Date.now()
      cards[task.id] = {
        id: task.id,
        title: oneLine(task.goal, TITLE_MAX) || 'Task',
        assignee: typeof task.botId === 'string' ? task.botId : USER,
        openedBy: typeof task.botId === 'string' ? task.botId : USER,
        status,
        progress: oneLine(task.progress, PROGRESS_MAX),
        links: [],
        notes: Array.isArray(task.notes) ? task.notes : [],
        roomId: room.id,
        createdAt: at,
        updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : at,
        ...(status === 'done' ? { doneAt: Number.isFinite(task.updatedAt) ? task.updatedAt : at } : {}),
        ...(typeof task.result === 'string' && task.result !== '' ? { result: task.result } : {}),
        ...(typeof task.reason === 'string' && task.reason !== '' ? { reason: task.reason } : {}),
      }
    }
  }
  return moved
}
