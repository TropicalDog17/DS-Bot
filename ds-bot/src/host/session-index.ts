export interface GroupOwner {
  botId: string
  roomId: string
}

export interface PastOwner {
  botId?: string
  roomId?: string
}

export interface SessionPlace {
  botId?: string
  roomId?: string
}

interface SegmentLike {
  sessionId?: unknown
}

interface OpenPartLike {
  sessionId?: unknown
  segments?: SegmentLike[]
}

interface ClosedCardLike {
  sessionId?: unknown
  segments?: SegmentLike[]
}

interface BotLike {
  id?: unknown
  sessionId?: unknown
  segments?: SegmentLike[]
  openParts?: OpenPartLike[]
  closedCards?: ClosedCardLike[]
}

interface RoomLike {
  id?: unknown
  sessionId?: unknown
  parts?: SegmentLike[]
  segments?: Record<string, SegmentLike[] | undefined>
  sessions?: Record<string, unknown>
}

export interface SessionIndexState {
  bots: Record<string, BotLike | undefined>
  rooms: Record<string, RoomLike | undefined>
}

export interface SessionIndexOptions {
  warn?: (template: string, ...args: unknown[]) => void
  chatOwners?: Map<string, string>
  groupOwners?: Map<string, GroupOwner>
  roomOwners?: Map<string, string>
  pastOwners?: Map<string, PastOwner>
}

export interface SessionIndex {
  readonly chatOwners: Map<string, string>
  readonly groupOwners: Map<string, GroupOwner>
  readonly roomOwners: Map<string, string>
  readonly pastOwners: Map<string, PastOwner>
  reindex(state: SessionIndexState): void
  registerChat(sessionId: string, botId: string): void
  removeChat(sessionId: string): void
  archiveChat(sessionId: string, botId: string): void
  swapChatPart(currentId: string, nextId: string, botId: string): void
  registerGroupMember(sessionId: string, botId: string, roomId: string): void
  removeGroupMember(sessionId: string): void
  selfOf(sessionId: string | undefined): string | undefined
  isBotSession(sessionId: string | undefined): boolean
  roomOwnerOf(sessionId: string | undefined): string | undefined
  placeOf(sessionId: string | undefined): SessionPlace | undefined
  currentSessionIds(): string[]
  onChange(listener: () => void): () => void
  notifyChanged(): void
}

export const nonEmptyId = (id: unknown): string | undefined =>
  (typeof id === 'string' && id !== '' ? id : undefined)

export function createSessionIndex(options: SessionIndexOptions = {}): SessionIndex {
  const chatOwners = options.chatOwners ?? new Map<string, string>()
  const groupOwners = options.groupOwners ?? new Map<string, GroupOwner>()
  const roomOwners = options.roomOwners ?? new Map<string, string>()
  const pastOwners = options.pastOwners ?? new Map<string, PastOwner>()
  const listeners = new Set<() => void>()
  const warn = options.warn ?? (() => {})

  const notifyChanged = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        warn('ds-bot: identity subscriber failed: %s', error)
      }
    }
  }

  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const indexPast = (segments: SegmentLike[] | undefined, owner: PastOwner): void => {
    if (!Array.isArray(segments)) return
    for (const segment of segments) {
      const sid = nonEmptyId(segment?.sessionId)
      if (sid !== undefined) pastOwners.set(sid, owner)
    }
  }

  const reindex = (state: SessionIndexState): void => {
    chatOwners.clear()
    groupOwners.clear()
    roomOwners.clear()
    pastOwners.clear()
    for (const [id, bot] of Object.entries(state.bots)) {
      const botId = nonEmptyId(bot?.id) ?? nonEmptyId(id)
      if (botId === undefined || bot === undefined) continue
      indexPast(bot.segments, { botId })
      const currentSid = nonEmptyId(bot.sessionId) ?? botId
      chatOwners.set(currentSid, botId)
      for (const part of bot.openParts ?? []) {
        const partSid = nonEmptyId(part?.sessionId)
        if (partSid !== undefined) chatOwners.set(partSid, botId)
        indexPast(part?.segments, { botId })
      }
      for (const closed of Array.isArray(bot.closedCards) ? bot.closedCards : []) {
        indexPast([{ sessionId: closed?.sessionId }, ...(Array.isArray(closed?.segments) ? closed.segments : [])], { botId })
      }
    }
    for (const [id, room] of Object.entries(state.rooms)) {
      const roomId = nonEmptyId(room?.id) ?? nonEmptyId(id)
      if (roomId === undefined || room === undefined) continue
      const roomSid = nonEmptyId(room.sessionId) ?? roomId
      roomOwners.set(roomSid, roomId)
      indexPast(room.parts, { roomId })
      for (const [botId, segments] of Object.entries(room.segments ?? {})) indexPast(segments, { botId, roomId })
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
        const sid = nonEmptyId(sessionId)
        if (sid !== undefined) groupOwners.set(sid, { botId, roomId })
      }
    }
  }

  const registerChat = (sessionId: string, botId: string): void => {
    chatOwners.set(sessionId, botId)
  }

  const removeChat = (sessionId: string): void => {
    chatOwners.delete(sessionId)
  }

  const archiveChat = (sessionId: string, botId: string): void => {
    chatOwners.delete(sessionId)
    pastOwners.set(sessionId, { botId })
  }

  const swapChatPart = (currentId: string, nextId: string, botId: string): void => {
    chatOwners.delete(currentId)
    chatOwners.set(nextId, botId)
    pastOwners.delete(nextId)
    pastOwners.set(currentId, { botId })
  }

  const registerGroupMember = (sessionId: string, botId: string, roomId: string): void => {
    groupOwners.set(sessionId, { botId, roomId })
  }

  const removeGroupMember = (sessionId: string): void => {
    groupOwners.delete(sessionId)
    notifyChanged()
  }

  const selfOf = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined) return undefined
    return chatOwners.get(sessionId) ?? groupOwners.get(sessionId)?.botId ?? pastOwners.get(sessionId)?.botId
  }

  const isBotSession = (sessionId: string | undefined): boolean =>
    sessionId !== undefined && (chatOwners.has(sessionId) || groupOwners.has(sessionId))

  const roomOwnerOf = (sessionId: string | undefined): string | undefined =>
    (sessionId === undefined ? undefined : roomOwners.get(sessionId))

  const placeOf = (sessionId: string | undefined): SessionPlace | undefined => {
    if (sessionId === undefined) return undefined
    const botId = chatOwners.get(sessionId)
    if (botId !== undefined) return { botId }
    const group = groupOwners.get(sessionId)
    if (group !== undefined) return { botId: group.botId, roomId: group.roomId }
    const roomId = roomOwners.get(sessionId)
    return roomId === undefined ? undefined : { roomId }
  }

  const currentSessionIds = (): string[] => [
    ...chatOwners.keys(),
    ...groupOwners.keys(),
    ...roomOwners.keys(),
  ]

  return {
    chatOwners,
    groupOwners,
    roomOwners,
    pastOwners,
    reindex,
    registerChat,
    removeChat,
    archiveChat,
    swapChatPart,
    registerGroupMember,
    removeGroupMember,
    selfOf,
    isBotSession,
    roomOwnerOf,
    placeOf,
    currentSessionIds,
    onChange,
    notifyChanged,
  }
}

export interface SessionIndexRuntime {
  sessionIndex?: SessionIndex
  chatOwners?: Map<string, string>
  groupOwners?: Map<string, GroupOwner>
  roomOwners?: Map<string, string>
  pastOwners?: Map<string, PastOwner>
  warn?: (template: string, ...args: unknown[]) => void
}

export function ensureSessionIndex(rt: SessionIndexRuntime): SessionIndex {
  return rt.sessionIndex ??= createSessionIndex({
    warn: rt.warn,
    chatOwners: rt.chatOwners,
    groupOwners: rt.groupOwners,
    roomOwners: rt.roomOwners,
    pastOwners: rt.pastOwners,
  })
}
