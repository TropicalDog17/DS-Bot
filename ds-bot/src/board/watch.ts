import { USER, isOpen, oneLine } from './card-fields.ts'
import { prName, prsOf } from './prs.ts'

export const PUSH_MAX = 700
export const WATCH_MS = 15 * 60 * 1000
export const STUCK_MS = 3 * 60 * 60 * 1000
export const REVIEW_MS = 24 * 60 * 60 * 1000
export const PROGRESS_PUSH_MS = 30 * 60 * 1000
export const PROGRESS_AFTER_MS = 10 * 60 * 1000
export const IDLE_MS = 20 * 60 * 1000

const tagOf = card => card.key ?? card.id
const hours = ms => `${Math.max(1, Math.round(ms / 3_600_000))}h`

export function pushText(card, who, what) {
  return oneLine(`${who} · ${tagOf(card)}: ${what}`, PUSH_MAX)
}

export function pushFor(action, before, card, nameOf, { now = Date.now(), lastPush, progressBefore }: any = {}) {
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
  if (action === 'complete' && card.status === 'review') {
    const prs = prsOf(card.links)
    return pushText(card, who, prs.length === 0
      ? `"${card.title}" is ready for review, move it to Done if you accept it: ${card.result ?? ''}`
      : `"${card.title}" is ready for review, merge ${prs.map(prName).join(', ')}: ${card.result ?? ''}`)
  }
  if (action === 'complete') return pushText(card, who, `"${card.title}" is ready for review: ${card.result ?? ''}`)
  if (action === 'merged') return pushText(card, who, `"${card.title}" is merged and waits for your review: ${card.result ?? ''}`)
  if (action === 'cancel') return pushText(card, who, `stopped "${card.title}"${card.reason ? `: ${card.reason}` : ''}`)
  return undefined
}

export function sweep(cards: Record<string, any>, { now, hasBot, nameOf, stuckMs = STUCK_MS, reviewMs = REVIEW_MS }: any) {
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
      what = `"${card.title}" has waited for you in Review for ${hours(idle)}: review it, then move it to Done if you accept it`
    }
    if (kind === undefined) continue
    if (card.alerted?.kind === kind && card.alerted.updatedAt === card.updatedAt) continue
    alerts.push({ card, kind, text: pushText(card, kind === 'unassigned' ? 'Board' : nameOf(card.assignee), what) })
  }
  return alerts
}

export function idleStep(card, { now, quiet, waited, idleMs = IDLE_MS }: any) {
  if (card.status !== 'active' || waited) return card.idle === undefined ? undefined : 'clear'
  if (!quiet) return undefined
  const since = Math.max(card.updatedAt ?? card.createdAt ?? now, card.idle?.at ?? 0)
  if (now - since < idleMs) return undefined
  return ['nudge', 'tell'][card.idle?.count ?? 0]
}

export const idleNudge = card => [
  `Card ${tagOf(card)} "${card.title}" is In progress, but nothing runs for it: your turn here ended and you keep no wait on a herdr pane.`,
  'Go on with it now. If an agent in a pane still works on it, wait_pane on that pane. If it waits for the user, board update it to review or blocked and say with need what they must do. If it is finished, board complete it: the card goes to Review and waits for the user to accept it.',
].join('\n')

export const idleText = (card, who, ms) => pushText(card, who, `"${card.title}" is In progress but nothing has run for it for ${Math.max(1, Math.round(ms / 60_000))} min; send it a note or move it`)
