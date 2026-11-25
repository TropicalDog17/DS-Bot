// Public read-only identity boundary for optional plugins.

export function ownerOfSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const candidates = []
  const chat = rt.chatOwners.get(sessionId)
  if (chat !== undefined) candidates.push({ botId: chat })
  const group = rt.groupOwners.get(sessionId)
  if (group !== undefined) candidates.push(group)
  const past = rt.pastOwners.get(sessionId)
  if (past?.botId !== undefined) candidates.push(past)
  if (rt.roomOwners.has(sessionId) || past && past.botId === undefined) return undefined
  const first = candidates[0]
  if (!first || !rt.botOf(first.botId)) return undefined
  if (candidates.some(owner => owner.botId !== first.botId || owner.roomId !== first.roomId)) return undefined
  const card = rt.cardThreads?.ofSession(sessionId)
  const cardId = card?.botId === first.botId ? card.cardId : undefined
  const roomId = first.roomId ?? (cardId === undefined ? undefined : rt.cardThreads.roomOfSession(sessionId))
  return Object.freeze({ botId: first.botId, ...(roomId === undefined ? {} : { roomId }), ...(cardId === undefined ? {} : { cardId }) })
}

export function install(rt) {
  const service = Object.freeze({
    ownerOfSession: sessionId => ownerOfSession(rt, sessionId),
    // Subscribers re-read ownership; they must not cache an authorization decision.
    subscribe: listener => rt.onSessionIdentityChange(listener),
  })
  rt.ownerOfSession = service.ownerOfSession
  // A test context may have no Cordis service registry; the service only exists under a real host.
  if (typeof rt.ctx.provide !== 'function') return
  rt.ctx.provide('botSessionIdentity', service)
}
