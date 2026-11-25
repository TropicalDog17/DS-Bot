import { t } from './i18n.ts'

export const NOTIFY_KEY = 'ds-bot:notify'

export function notifyKind({ before, after, viewing, focused, enabled, muted, group }) {
  if (before === undefined || enabled !== true || muted === true) return undefined
  if (viewing === true && focused === true) return undefined
  const wasPending = before?.pendingInteraction !== undefined
  const isPending = after?.pendingInteraction !== undefined
  if (isPending && (!wasPending || after.pendingInteraction !== before.pendingInteraction)) return 'question'
  if (group === true) return undefined
  if (after?.completionUnread === true && before?.completionUnread !== true) return 'reply'
  return undefined
}

export function noticeText({ title, kind }) {
  const name = String(title ?? '').trim().slice(0, 60)
  const body = t(kind === 'question' ? 'Waiting for your answer' : 'A new reply is waiting')
  return { title: name === '' ? 'DS Bot' : name, body }
}

export function readNotifyPrefs(raw) {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value === null || typeof value !== 'object') return { enabled: true, muted: {} }
    const muted = value.muted !== null && typeof value.muted === 'object' ? Object.fromEntries(Object.entries(value.muted).filter(([, on]) => on === true)) : {}
    return { enabled: value.enabled !== false, muted }
  } catch {
    return { enabled: true, muted: {} }
  }
}

export function writeNotifyPrefs(prefs, change) {
  const enabled = typeof change.enabled === 'boolean' ? change.enabled : prefs.enabled
  const muted = { ...prefs.muted }
  if (change.mute !== undefined) {
    if (change.mute.on === true) muted[change.mute.id] = true
    else delete muted[change.mute.id]
  }
  return { enabled, muted }
}

export function badgeOf(rows) {
  let count = 0
  for (const row of rows ?? []) if (row.unread === true || row.pending === true) count += 1
  return count
}


export function notificationRows({ statuses, roster, approvals = [] }) {
  const rows = []
  for (const [group, entries] of [[false, roster.bots ?? []], [true, roster.rooms ?? []]]) {
    for (const entry of entries) {
      const sessionId = entry.sessionId ?? entry.id
      const status = statuses?.get(sessionId)
      const question = roster.questions?.[sessionId]
      const waiting = approvals.filter(approval => group ? approval.roomId === entry.id : approval.roomId === undefined && approval.botId === entry.id)
      const interaction = status?.pendingInteraction
      const keys = [
        ...(question ? [`question:${question.id}`] : []),
        ...waiting.map(approval => `approval:${approval.id}`),
        ...(interaction !== undefined ? [`interaction:${interaction?.id ?? interaction?.kind ?? 'pending'}`] : []),
      ].sort()
      if (status === undefined && keys.length === 0) continue
      rows.push({
        id: entry.id, sessionId, name: entry.name, group,
        unread: status?.completionUnread === true, pending: keys.length > 0,
        status: { ...status, pendingInteraction: keys.length > 0 ? keys.join('|') : undefined },
      })
    }
  }
  return rows
}
