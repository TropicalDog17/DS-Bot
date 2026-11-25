// What the board tells the user's phone (dsBotNotes push, through the Main Bot's own
// Telegram chat) and the watchdog that finds cards needing the user. Pure functions over
// the cards object; plugin.js sends and saves.
import { USER, isOpen, oneLine } from './card-fields.js'

// About a hundred words: the detail stays on the card.
export const PUSH_MAX = 700
export const WATCH_MS = 15 * 60 * 1000
// In progress this long without a change: stuck.
export const STUCK_MS = 3 * 60 * 60 * 1000
// In Review this long: the user has forgotten it.
export const REVIEW_MS = 24 * 60 * 60 * 1000
// A card's progress reaches the phone at most this often, and only once the card has
// run this long: a card that is done in minutes says so with its done push.
export const PROGRESS_PUSH_MS = 30 * 60 * 1000
export const PROGRESS_AFTER_MS = 10 * 60 * 1000

const tagOf = card => card.key ?? card.id
const hours = ms => `${Math.max(1, Math.round(ms / 3_600_000))}h`

// `Researcher · LIFE-782: …`, the Bot that did the work and the card.
export function pushText(card, who, what) {
  return oneLine(`${who} · ${tagOf(card)}: ${what}`, PUSH_MAX)
}

// The push a Bot's own board action makes, or undefined: a question, a card moved to
// Review or Blocked, a card finished or given up, and on a long card new progress
// (`lastPush`: when this card last pushed, if it did). The user's own changes on the page
// push nothing.
export function pushFor(action, before, card, nameOf, { now = Date.now(), lastPush, progressBefore } = {}) {
  if (card === undefined) return undefined
  const who = nameOf(card.assignee)
  if (action === 'ask') {
    const asked = (card.notes ?? []).at(-1)
    return pushText(card, who, `asks "${card.title}": ${asked?.text ?? ''}${asked?.options ? ` (${asked.options.join(' / ')})` : ''}`)
  }
  if (action === 'update' && card.status === 'review' && before !== 'review') {
    return pushText(card, who, `"${card.title}" is ready for review${card.progress ? `: ${card.progress}` : ''}`)
  }
  if (action === 'update' && card.status === 'blocked' && before !== 'blocked') {
    return pushText(card, who, `"${card.title}" is blocked${card.need ? `: ${card.need}` : card.progress ? `: ${card.progress}` : ''}`)
  }
  if (action === 'update' && card.progress && card.progress !== progressBefore
    && now - (card.createdAt ?? now) >= PROGRESS_AFTER_MS && (lastPush === undefined || now - lastPush >= PROGRESS_PUSH_MS)) {
    return pushText(card, who, `"${card.title}": ${card.progress}`)
  }
  if (action === 'complete') return pushText(card, who, `done "${card.title}": ${card.result ?? ''}`)
  if (action === 'cancel') return pushText(card, who, `stopped "${card.title}"${card.reason ? `: ${card.reason}` : ''}`)
  return undefined
}

// The cards the user should hear about now, each once per state: the mark is the card's
// updatedAt, so a card that moves and gets stuck again is told again.
export function sweep(cards, { now, hasBot, nameOf, stuckMs = STUCK_MS, reviewMs = REVIEW_MS }) {
  const alerts = []
  for (const card of Object.values(cards)) {
    if (!isOpen(card)) continue
    let kind
    let what
    const idle = now - (card.updatedAt ?? card.createdAt ?? now)
    if (card.assignee !== USER && !hasBot(card.assignee)) {
      kind = 'unassigned'
      what = `"${card.title}" has no assignee: its Bot is gone`
    } else if (card.status === 'active' && card.assignee !== USER && idle >= stuckMs) {
      kind = 'stuck'
      what = `"${card.title}" has not moved for ${hours(idle)}`
    } else if (card.status === 'review' && idle >= reviewMs) {
      kind = 'review'
      what = `"${card.title}" has waited for you in Review for ${hours(idle)}`
    }
    if (kind === undefined) continue
    if (card.alerted?.kind === kind && card.alerted.updatedAt === card.updatedAt) continue
    alerts.push({ card, kind, text: pushText(card, kind === 'unassigned' ? 'Board' : nameOf(card.assignee), what) })
  }
  return alerts
}
