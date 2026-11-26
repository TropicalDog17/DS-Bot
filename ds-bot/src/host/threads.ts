export interface ThreadSegment {
  sessionId: string
  endedAt?: number
  tokens?: number
  note?: string
  noteFrom?: number
  fallback?: string
}

export interface OpenPart {
  sessionId: string
  segments?: ThreadSegment[]
  startedAt?: number
  card?: string
  cardRoomId?: string
  closing?: boolean
}

export interface ClosedCardThread {
  card: string
  sessionId: string
  segments: ThreadSegment[]
  closedAt: number
}

export interface BotThreadState {
  id?: string
  sessionId?: string
  segments?: ThreadSegment[]
  openParts?: OpenPart[]
  closedCards?: ClosedCardThread[]
  currentCard?: string
  currentCardRoomId?: string
  currentCardClosing?: boolean
}

export interface RoomThreadState {
  id: string
  members?: string[]
  sessions?: Record<string, string>
}

export type ThreadLocation =
  | { thread: 'current'; segments: ThreadSegment[] }
  | { thread: 'open'; index: number; segments: ThreadSegment[] }

export interface ReachTarget {
  sessionId: string | undefined
  where: 'card' | 'group' | 'own'
}

export const currentSession = (bot: BotThreadState | undefined): string | undefined =>
  bot?.sessionId ?? bot?.id

export function threadOf(bot: BotThreadState | undefined, sessionId: string | undefined): ThreadLocation | undefined {
  if (bot === undefined || sessionId === undefined) return undefined
  if (currentSession(bot) === sessionId) return { thread: 'current', segments: bot.segments ?? [] }
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts![at].segments ?? [] }
}

export const threadSegments = (bot: BotThreadState | undefined, sessionId: string | undefined): ThreadSegment[] =>
  threadOf(bot, sessionId)?.segments ?? []

export const isOpenPart = (bot: BotThreadState | undefined, sessionId: string | undefined): boolean =>
  threadOf(bot, sessionId)?.thread === 'open'

export function threadCurrent(bot: BotThreadState | undefined, sessionId: string | undefined): string | undefined {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined || bot === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts![thread.index].sessionId
}

export function threadOfPart(bot: BotThreadState | undefined, sessionId: string | undefined): ThreadLocation | undefined {
  const found = threadOf(bot, sessionId)
  if (found !== undefined || bot === undefined || sessionId === undefined) return found
  if ((bot.segments ?? []).some(segment => segment.sessionId === sessionId)) {
    return { thread: 'current', segments: bot.segments ?? [] }
  }
  const at = (bot.openParts ?? []).findIndex(part => (part.segments ?? []).some(segment => segment.sessionId === sessionId))
  return at === -1 ? undefined : { thread: 'open', index: at, segments: bot.openParts![at].segments ?? [] }
}

export function threadCurrentOfPart(bot: BotThreadState | undefined, sessionId: string | undefined): string | undefined {
  const thread = threadOfPart(bot, sessionId)
  if (thread === undefined || bot === undefined) return undefined
  return thread.thread === 'current' ? currentSession(bot) : bot.openParts![thread.index].sessionId
}

export function pushThreadPart(bot: BotThreadState, sessionId: string, freshId: string, segment: ThreadSegment): boolean {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined) return false
  if (thread.thread === 'current') {
    ;(bot.segments ??= []).push(segment)
    bot.sessionId = freshId
  } else {
    const part = bot.openParts![thread.index]
    ;(part.segments ??= []).push(segment)
    part.sessionId = freshId
  }
  return true
}

const cardFields = (card: unknown, cardRoomId?: unknown, closing?: unknown) => (typeof card === 'string' ? {
  card,
  ...(typeof cardRoomId === 'string' ? { cardRoomId } : {}),
  ...(closing === true ? { closing } : {}),
} : {})

const currentCardFields = (bot: BotThreadState) =>
  cardFields(bot.currentCard, bot.currentCardRoomId, bot.currentCardClosing)

function setCurrentCard(bot: BotThreadState, { card, cardRoomId, closing }: { card?: string; cardRoomId?: string; closing?: boolean } = {}): void {
  if (typeof card === 'string') bot.currentCard = card
  else delete bot.currentCard
  if (typeof cardRoomId === 'string') bot.currentCardRoomId = cardRoomId
  else delete bot.currentCardRoomId
  if (closing === true) bot.currentCardClosing = true
  else delete bot.currentCardClosing
}

export function startOpenPart(bot: BotThreadState, freshId: string, startedAt = Date.now()): void {
  bot.openParts ??= []
  bot.openParts.push({ sessionId: currentSession(bot)!, segments: bot.segments ?? [], startedAt, ...currentCardFields(bot) })
  bot.sessionId = freshId
  bot.segments = []
  setCurrentCard(bot, {})
}

export function focusOpenPart(bot: BotThreadState, sessionId: string): boolean {
  const at = (bot.openParts ?? []).findIndex(part => part?.sessionId === sessionId)
  if (at === -1) return false
  const [target] = bot.openParts!.splice(at, 1)
  bot.openParts!.push({ sessionId: currentSession(bot)!, segments: bot.segments ?? [], ...currentCardFields(bot) })
  bot.sessionId = target.sessionId
  bot.segments = target.segments ?? []
  setCurrentCard(bot, target)
  return true
}

export function activateSegmentPart(bot: BotThreadState, partId: string, endedAt = Date.now()): string | undefined {
  const segments = bot.segments ?? []
  const at = segments.findIndex(segment => segment.sessionId === partId)
  if (at === -1) return undefined
  const previous = currentSession(bot)!
  segments.splice(at, 1, { sessionId: previous, endedAt })
  bot.sessionId = partId
  return previous
}

export function cardOfThread(bot: BotThreadState | undefined, sessionId: string | undefined): string | undefined {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined || bot === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCard : bot.openParts![thread.index].card
}

export function cardRoomOfThread(bot: BotThreadState | undefined, sessionId: string | undefined): string | undefined {
  const thread = threadOf(bot, sessionId)
  if (thread === undefined || bot === undefined) return undefined
  return thread.thread === 'current' ? bot.currentCardRoomId : bot.openParts![thread.index].cardRoomId
}

export function cardThreadSession(bot: BotThreadState | undefined, cardId: string | undefined): string | undefined {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId && bot.currentCardClosing !== true) return currentSession(bot)
  return (bot.openParts ?? []).find(part => part?.card === cardId && part.closing !== true)?.sessionId
}

export function closingCardThreadSession(bot: BotThreadState | undefined, cardId: string | undefined): string | undefined {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId && bot.currentCardClosing === true) return currentSession(bot)
  return (bot.openParts ?? []).find(part => part?.card === cardId && part.closing === true)?.sessionId
}

export function addCardThread(bot: BotThreadState, freshId: string, cardId: string, startedAt = Date.now(), roomId?: string): void {
  ;(bot.openParts ??= []).push({ sessionId: freshId, segments: [], startedAt, ...cardFields(cardId, roomId) })
}

export const CLOSED_CARDS_MAX = 50

export function closeCardThread(bot: BotThreadState | undefined, cardId: string | undefined, closedAt = Date.now(), sessionId?: string): ClosedCardThread | undefined {
  if (bot === undefined || typeof cardId !== 'string') return undefined
  if (bot.currentCard === cardId) {
    if (sessionId === undefined || currentSession(bot) === sessionId) {
      setCurrentCard(bot, {})
      return undefined
    }
  }
  const parts = bot.openParts ?? []
  const matches = (part: OpenPart | undefined) => part?.card === cardId && (sessionId === undefined || part.sessionId === sessionId)
  const closing = parts.findIndex(part => matches(part) && part.closing === true)
  const at = closing === -1 ? parts.findIndex(matches) : closing
  if (at === -1) return undefined
  const [part] = parts.splice(at, 1)
  const closed: ClosedCardThread = { card: cardId, sessionId: part.sessionId, segments: part.segments ?? [], closedAt }
  ;(bot.closedCards ??= []).push(closed)
  if (bot.closedCards.length > CLOSED_CARDS_MAX) bot.closedCards.splice(0, bot.closedCards.length - CLOSED_CARDS_MAX)
  return closed
}

export function reach(bot: BotThreadState | undefined, { cardId, roomId, room, user = false }: { cardId?: string; roomId?: string; room?: RoomThreadState; user?: boolean } = {}): ReachTarget {
  const card = cardThreadSession(bot, cardId)
  if (card !== undefined) return { sessionId: card, where: 'card' }
  if (bot?.id !== undefined && typeof roomId === 'string' && room?.id === roomId && room.members?.includes(bot.id)) {
    const group = user ? room.id : room.sessions?.[bot.id]
    if (group !== undefined) return { sessionId: group, where: 'group' }
  }
  return { sessionId: currentSession(bot), where: 'own' }
}

const distinct = (ids: Array<string | undefined>): string[] =>
  [...new Set(ids.filter((id): id is string => id !== undefined))]

const partSessions = ({ sessionId, segments }: { sessionId?: string; segments?: ThreadSegment[] }): Array<string | undefined> =>
  [sessionId, ...(segments ?? []).map(segment => segment.sessionId)]

export const openSessions = (bot: BotThreadState | undefined): string[] =>
  distinct((bot?.openParts ?? []).flatMap(partSessions))

export const sessionsOf = (bot: BotThreadState | undefined): string[] =>
  distinct([...partSessions({ sessionId: currentSession(bot), segments: bot?.segments }), ...openSessions(bot)])

export const successorOfMovedPart = (bot: BotThreadState | undefined, freshId: string): string | undefined =>
  (threadOf(bot, freshId)?.thread === 'open' ? freshId : undefined)

export const ownChatSessions = (bot: BotThreadState | undefined): string[] =>
  distinct([currentSession(bot), ...(bot?.openParts ?? []).map(part => part.sessionId)])
