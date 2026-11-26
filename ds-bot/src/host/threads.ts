export const currentSession = (bot: any): any => bot?.sessionId ?? bot?.id

export function threadOf(bot: any, sessionId: any) {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current' as const, segments: bot.segments ?? [] }
  const at = (bot.openParts ?? []).findIndex((part: any) => part?.sessionId === sessionId)
  return at === -1 ? undefined : { thread: 'open' as const, index: at, segments: bot.openParts[at].segments ?? [] }
}

export const threadSegments = (bot: any, sessionId: any) => threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot: any, sessionId: any) => threadOf(bot, sessionId)?.thread === 'open'

export function threadCurrent(bot: any, sessionId: any) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

export function threadOfPart(bot: any, sessionId: any) {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some((segment: any) => segment.sessionId === sessionId)) return { thread: 'current' as const, segments: bot.segments }
  const at = (bot.openParts ?? []).findIndex((part: any) => (part.segments ?? []).some((segment: any) => segment.sessionId === sessionId))
  return at === -1 ? undefined : { thread: 'open' as const, index: at, segments: bot.openParts[at].segments ?? [] }
}

export function threadCurrentOfPart(bot: any, sessionId: any) {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
}

export function pushThreadPart(bot: any, sessionId: any, freshId: any, segment: any) {
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

export function startOpenPart(bot: any, freshId: any, startedAt = Date.now()) {
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], startedAt, ...currentCardFields(bot) })
  bot.sessionId = freshId
  bot.segments = []
  setCurrentCard(bot, {})
}

const cardFields = (card: any, cardRoomId?: any, closing?: any) => (typeof card === 'string' ? {
  card,
  ...(typeof cardRoomId === 'string' ? { cardRoomId } : {}),
  ...(closing === true ? { closing } : {}),
} : {})
const currentCardFields = (bot: any) => cardFields(bot.currentCard, bot.currentCardRoomId, bot.currentCardClosing)

function setCurrentCard(bot: any, { card, cardRoomId, closing }: { card?: any, cardRoomId?: any, closing?: any } = {}) {
  if (typeof card === 'string') bot.currentCard = card
  else delete bot.currentCard
  if (typeof cardRoomId === 'string') bot.currentCardRoomId = cardRoomId
  else delete bot.currentCardRoomId
  if (closing === true) bot.currentCardClosing = true
  else delete bot.currentCardClosing
}

export function focusOpenPart(bot: any, sessionId: any) {
  const at = (bot.openParts ?? []).findIndex((part: any) => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts.splice(at, 1)
  bot.openParts.push({ sessionId: currentSession(bot), segments: bot.segments ?? [], ...currentCardFields(bot) })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  setCurrentCard(bot, target)
  return true
}

export function cardOfThread(bot: any, sessionId: any) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCard : bot.openParts[thread.index].card
}

export function cardRoomOfThread(bot: any, sessionId: any) {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCardRoomId : bot.openParts[thread.index].cardRoomId
}

export function cardThreadSession(bot: any, cardId: any) {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId && bot.currentCardClosing !== true) return currentSession(bot)
  return (bot.openParts ?? []).find((part: any) => part?.card === cardId && part.closing !== true)?.sessionId
}

export function closingCardThreadSession(bot: any, cardId: any) {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId && bot.currentCardClosing === true) return currentSession(bot)
  return (bot.openParts ?? []).find((part: any) => part?.card === cardId && part.closing === true)?.sessionId
}

export function addCardThread(bot: any, freshId: any, cardId: any, startedAt = Date.now(), roomId?: any) {
  ;(bot.openParts ??= []).push({ sessionId: freshId, segments: [], startedAt, ...cardFields(cardId, roomId) })
}

export const CLOSED_CARDS_MAX = 50
export function closeCardThread(bot: any, cardId: any, closedAt = Date.now(), sessionId?: any) {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId) {
    if (sessionId === undefined || currentSession(bot) === sessionId) {
      setCurrentCard(bot, {})
      return undefined
    }
  }
  const parts = bot.openParts ?? []
  const matches = (part: any) => part?.card === cardId && (sessionId === undefined || part.sessionId === sessionId)
  const closing = parts.findIndex((part: any) => matches(part) && part.closing === true)
  const at = closing === -1 ? parts.findIndex(matches) : closing
  if (at === -1) return undefined
  const [part] = parts.splice(at, 1)
  const closed = { card: cardId, sessionId: part.sessionId, segments: part.segments ?? [], closedAt }
  ;(bot.closedCards ??= []).push(closed)
  if (bot.closedCards.length > CLOSED_CARDS_MAX) bot.closedCards.splice(0, bot.closedCards.length - CLOSED_CARDS_MAX)
  return closed
}

export function reach(bot: any, { cardId, roomId, room, user = false }: { cardId?: any, roomId?: any, room?: any, user?: boolean } = {}) {
  const card = cardThreadSession(bot, cardId)
  if (card !== undefined) return { sessionId: card, where: 'card' }
  if (bot && typeof roomId === 'string' && room?.id === roomId && room.members?.includes(bot.id)) {
    const group = user ? room.id : room.sessions?.[bot.id]
    if (group !== undefined) return { sessionId: group, where: 'group' }
  }
  return { sessionId: currentSession(bot), where: 'own' }
}

const distinct = (ids: any[]) => [...new Set(ids.filter((id: any) => id !== undefined))]
const partSessions = ({ sessionId, segments }: { sessionId?: any, segments?: any }) => [sessionId, ...(segments ?? []).map((segment: any) => segment.sessionId)]

export const openSessions = (bot: any) => distinct((bot?.openParts ?? []).flatMap(partSessions))

export const sessionsOf = (bot: any) => distinct([...partSessions({ sessionId: currentSession(bot), segments: bot?.segments }), ...openSessions(bot)])

export const successorOfMovedPart = (bot: any, freshId: any) => (threadOf(bot, freshId)?.thread === 'open' ? freshId : undefined)

export const ownChatSessions = (bot: any) => distinct([currentSession(bot), ...(bot?.openParts ?? []).map((part: any) => part.sessionId)])
