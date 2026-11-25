// A Bot's own chat is one or more threads. The current thread is `bot.sessionId` with
// its earlier parts in `bot.segments`; a thread opened while the Bot was busy keeps its
// own session and its own earlier parts in `bot.openParts`. Parts never share a chain:
// a handoff reads only the thread it belongs to, so background work and the foreground
// chat cannot leak into each other.
// A Bot that never ran yet has no stored session id: its first Session is the Bot id
// (store.js chatOf falls back to it).
export const currentSession = bot => bot?.sessionId ?? bot?.id

export function threadOf(bot, sessionId) {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current', segments: bot.segments ?? [] }
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts[at].segments ?? [] }
}

export const threadSegments = (bot, sessionId) => threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot, sessionId) => threadOf(bot, sessionId)?.thread === 'open'

// A thread's current session: the part that a handoff or a kept input belongs to.
export function threadCurrent(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

// The thread a part belongs to, whether it is that thread's current part or one of its
// earlier parts. A Session outside the Bot's own chat (a group Session) belongs to none.
// `threadOf` alone knows only the current part of each thread; the earlier parts are
// still readable, and their history belongs to the thread they came from.
export function threadOfPart(bot, sessionId) {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some(segment => segment.sessionId === sessionId)) return { thread: 'current', segments: bot.segments }
  const at = (bot.openParts ?? []).findIndex(part => (part.segments ?? []).some(segment => segment.sessionId === sessionId))
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts[at].segments ?? [] }
}

// The session a part's thread goes on in: a reply to, or input given to, an earlier part
// of a thread reaches the part that thread has now.
export function threadCurrentOfPart(bot, sessionId) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

// A fresh part replaces a thread's current one; the part it replaces joins that thread's
// own earlier parts. Returns false for a session that belongs to no thread.
export function pushThreadPart(bot, sessionId, freshId, segment) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return false
  if (thread.thread === 'current') {
    ;(bot.segments ??= []).push(segment)
    bot.sessionId = freshId
  } else {
    const part = bot.openParts[thread.index]
    ;(part.segments ??= []).push(segment)
    part.sessionId = freshId
  }
  return true
}

// A fresh part starts in the foreground while the part it replaces stays live in the
// background with its own chain, so its running turn is not interrupted. It starts with
// no earlier parts and no handoff note: the user asked for a new conversation.
export function startOpenPart(bot, freshId, startedAt = Date.now()) {
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], startedAt, ...currentCardFields(bot) })
  bot.sessionId = freshId
  bot.segments = []
  setCurrentCard(bot, {})
}

const cardFields = (card, cardRoomId, closing) => (typeof card === 'string' ? {
  card,
  ...(typeof cardRoomId === 'string' ? { cardRoomId } : {}),
  ...(closing === true ? { closing } : {}),
} : {})
const currentCardFields = bot => cardFields(bot.currentCard, bot.currentCardRoomId, bot.currentCardClosing)

function setCurrentCard(bot, { card, cardRoomId, closing }) {
  if (typeof card === 'string') bot.currentCard = card
  else delete bot.currentCard
  if (typeof cardRoomId === 'string') bot.currentCardRoomId = cardRoomId
  else delete bot.currentCardRoomId
  if (closing === true) bot.currentCardClosing = true
  else delete bot.currentCardClosing
}

// Makes a live background part current. Each chain travels with its parts.
export function focusOpenPart(bot, sessionId) {
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts.splice(at, 1)
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], ...currentCardFields(bot) })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  // A card thread stays the card's when the user opens it: the card goes with it.
  setCurrentCard(bot, target)
  return true
}

// Card threads: one thread per open card, for that card's work only. A card thread is
// an open part with `card`, or the current thread with `bot.currentCard` once the user
// opened it.
export function cardOfThread(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCard : bot.openParts[thread.index].card
}

export function cardRoomOfThread(bot, sessionId) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCardRoomId : bot.openParts[thread.index].cardRoomId
}

export function cardThreadSession(bot, cardId) {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId) return currentSession(bot)
  return (bot.openParts ?? []).find(part => part?.card === cardId)?.sessionId
}

// A new card thread runs beside the Bot's chat: the current thread does not change.
export function addCardThread(bot, freshId, cardId, startedAt = Date.now(), roomId) {
  ;(bot.openParts ??= []).push({ sessionId: freshId, segments: [], startedAt, ...cardFields(cardId, roomId) })
}

// A closed card thread leaves the live threads and joins the Bot's closed card threads,
// which stay readable. The current thread only loses its card: it is where the user
// talks to the Bot now. Returns the closed record, or undefined.
export const CLOSED_CARDS_MAX = 50
export function closeCardThread(bot, cardId, closedAt = Date.now()) {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId) {
    setCurrentCard(bot, {})
    return undefined
  }
  const at = (bot.openParts ?? []).findIndex(part => part?.card === cardId)
  if (at === -1) return undefined
  const [part] = bot.openParts.splice(at, 1)
  const closed = { card: cardId, sessionId: part.sessionId, segments: part.segments ?? [], closedAt }
  ;(bot.closedCards ??= []).push(closed)
  if (bot.closedCards.length > CLOSED_CARDS_MAX) bot.closedCards.splice(0, bot.closedCards.length - CLOSED_CARDS_MAX)
  return closed
}

// The group record owns its members' sessions. User messages enter the shared chat
// with an @mention, even before the addressed member has a session there.
export function reach(bot, { cardId, roomId, room, user = false } = {}) {
  const card = cardThreadSession(bot, cardId)
  if (card !== undefined) return { sessionId: card, where: 'card' }
  if (bot && typeof roomId === 'string' && room?.id === roomId && room.members?.includes(bot.id)) {
    const group = user ? room.id : room.sessions?.[bot.id]
    if (group !== undefined) return { sessionId: group, where: 'group' }
  }
  return { sessionId: currentSession(bot), where: 'own' }
}

const distinct = ids => [...new Set(ids.filter(id => id !== undefined))]
const partSessions = ({ sessionId, segments }) => [sessionId, ...(segments ?? []).map(segment => segment.sessionId)]

// Every session this Bot keeps outside its current thread.
export const openSessions = bot => distinct((bot?.openParts ?? []).flatMap(partSessions))

export const sessionsOf = bot => distinct([...partSessions({ sessionId: currentSession(bot), segments: bot?.segments }), ...openSessions(bot)])

// A part that just moved on records a successor only when it belongs to an open thread:
// the foreground chat keeps its current part in `bot.sessionId`. The thread is read
// again after the move, because the user may have opened another part while the switch
// ran and turned this one into a background thread.
export const successorOfMovedPart = (bot, freshId) => (threadOf(bot, freshId)?.thread === 'open' ? freshId : undefined)

// Every live thread's current session. A change that must reach all of a Bot's own
// chats (its run mode) walks these, so no thread can be left on the other side.
export const ownChatSessions = bot => distinct([currentSession(bot), ...(bot?.openParts ?? []).map(part => part.sessionId)])
