import { randomUUID } from 'node:crypto'
import { ownChatSessions, reach } from './threads.ts'

export const NOTE_MAX = 2000
export const BRIEF_MAX = 8000
export const PUSH_MAX = 700

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const keepLines = (text, max) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)

export function rosterService(rt) {
  const botView = bot => Object.freeze({
    id: bot.id,
    name: bot.name,
    role: typeof bot.role === 'string' ? bot.role : '',
    ...(typeof bot.color === 'string' ? { color: bot.color } : {}),
    ...(bot.avatar !== null && typeof bot.avatar === 'object' ? { avatar: Object.freeze({ ...bot.avatar }) } : {}),
    main: rt.isMain(bot.id),
  })
  const groupView = room => Object.freeze({
    id: room.id,
    name: typeof room.name === 'string' ? room.name : '',
    members: Object.freeze((room.members ?? []).filter(id => rt.botOf(id) !== undefined)),
    ...(typeof room.admin === 'string' ? { admin: room.admin } : {}),
  })
  return Object.freeze({
    // The saved team loads once at start; a companion awaits this before a first read.
    ready: () => rt.load(),
    bots: () => Object.values(rt.state.bots).map(botView),
    groups: () => Object.values(rt.state.rooms).map(groupView),
    bot: id => { const bot = typeof id === 'string' ? rt.botOf(id) : undefined; return bot === undefined ? undefined : botView(bot) },
    group: id => { const room = typeof id === 'string' ? rt.roomOf(id) : undefined; return room === undefined ? undefined : groupView(room) },
    // An id or an exact name, as list_bots shows it.
    findBot: ref => { const bot = typeof ref === 'string' ? rt.findBot(ref.trim()) : undefined; return bot === undefined ? undefined : botView(bot) },
    // Called after every save of the team; listeners re-read, they get no diff.
    subscribe: listener => rt.onSaved(listener),
    // part(mainBotId) -> text for the Main Bot's routing digest (routing.js); returns the remover.
    addRoutingPart: part => rt.routingParts?.(part) ?? (() => {}),
  })
}

export function notesService(rt) {
  const listeners = new Set<(...args: any[]) => void>()
  const cardNotes = new Set<(...args: any[]) => any>()
  const cardStatuses = new Set<(...args: any[]) => any>()
  const roomOf = roomId => typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
  const open = (botId, cardId, title, roomId, mayOpen) => rt.openCardThread?.(botId, cardId, oneLine(title, 80), roomId, mayOpen)
  function cardStatus(cardId) {
    for (const status of cardStatuses) {
      const known = status(cardId)
      if (known !== undefined) return known
    }
  }
  const cardOpen = (botId, cardId) => cardStatus(cardId) ?? !rt.cardThreads?.isClosed(botId, cardId)
  const threadOf = (botId, cardId) => {
    const target = reach(typeof botId === 'string' ? rt.botOf(botId) : undefined, { cardId })
    return target.where === 'card' ? target.sessionId : undefined
  }
  const inTurn = sessionId => rt.live?.get(sessionId)?.turn !== undefined
  rt.cardNote = async (note) => {
    for (const listener of cardNotes) {
      try {
        if (await listener(Object.freeze({ ...note })) === true) return true
      } catch (error) { rt.warn?.('ds-bot: card note listener failed: %s', error) }
    }
    return false
  }
  rt.botReplied = reply => {
    const heard = Object.freeze({ ...reply })
    for (const listener of listeners) {
      try { listener(heard) } catch (error) { rt.warn?.('ds-bot: reply listener failed: %s', error) }
    }
  }
  return Object.freeze({
    // { botId, text, roomId? } -> { sessionId, where: 'group' | 'chat', requestId } | { error }.
    // A roomId the Bot is not (or no longer) a member of falls back to its own chat.
    // requestId is the note's id as a user message: an answer in the Bot's own chat or
    // in the group lists it in `heard` once a turn read the note.
    // A note with a cardId opens the thread if needed and goes there (where: 'card').
    // A requestId of the caller's (an IM message's) takes the place of a new one, so the
    // Bot's answer also goes back where that message came from.
    async deliver({ botId, roomId, cardId, title, brief, text, requestId: given }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const line = oneLine(text, NOTE_MAX)
      if (line === '') return { error: 'Write a note first.' }
      let opened = false
      const mayOpen = () => typeof cardId === 'string' && cardId !== '' && cardOpen(botId, cardId)
      if (mayOpen() && reach(bot, { cardId }).where !== 'card') {
        try {
          opened = typeof await open(botId, cardId, title, roomId, mayOpen) === 'string'
        } catch (error) {
          rt.warn?.('ds-bot: could not open a card thread for %s: %s', botId, error)
        }
      }
      if (rt.botOf(botId) === undefined) return { error: 'No such Bot.' }
      const { sessionId, where } = reach(rt.botOf(botId), { cardId: mayOpen() ? cardId : undefined, roomId, room: roomOf(roomId), user: true })
      const seed = opened && where === 'card' ? keepLines(brief, BRIEF_MAX) : ''
      const message = where === 'group' ? `@${bot.name} ${line}` : [seed, line].filter(Boolean).join('\n\n')
      const requestId = typeof given === 'string' && given !== '' ? given : randomUUID()
      await rt.dispatch.sendUser({ sessionId, content: [{ type: 'text', text: message }], requestId, ...(where === 'card' ? { steer: true } : {}) })
      return { sessionId, where: where === 'own' ? 'chat' : where, requestId }
    },
    // { botId, cardId, title?, text } -> { sessionId, requestId } | { error }. Opens the
    // card's thread (or finds the open one) and sends the brief there as the user's
    // message, so the Bot works on the card apart from its chat.
    async startCard({ botId, cardId, title, roomId, text }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      if (typeof cardId !== 'string' || cardId === '') return { error: 'A card thread needs a card id.' }
      const brief = keepLines(text, BRIEF_MAX)
      if (brief === '') return { error: 'A card needs a brief.' }
      const mayOpen = () => cardStatus(cardId) !== false
      const sessionId = await open(botId, cardId, title, roomId, mayOpen)
      if (sessionId === undefined || !mayOpen()) return { error: 'Card threads are not available.' }
      const requestId = randomUUID()
      await rt.dispatch.sendUser({ sessionId, content: [{ type: 'text', text: brief }], requestId })
      return { sessionId, requestId }
    },
    // { botId, cardId } -> the Session of the card's open thread, or undefined.
    async cardThread({ botId, cardId }: Record<string, any> = {}) {
      await rt.load()
      return threadOf(botId, cardId)
    },
    // A synchronous read for callers that already awaited roster.ready().
    hasCardThread: ({ botId, cardId }) => threadOf(botId, cardId) !== undefined,
    // { botId, cardId } -> true while the card's thread is in a turn, false while it is
    // open and quiet, undefined when the card has no thread. Synchronous, as hasCardThread.
    cardBusy({ botId, cardId }: Record<string, any> = {}) {
      const sessionId = threadOf(botId, cardId)
      return sessionId === undefined ? undefined : inTurn(sessionId)
    },
    // { botId, cardId, note, text } -> { where: 'card' } | { error }. DS Bot's own note in
    // the card's thread (not the user's message): it starts a turn there, or with
    // steer: true cuts into the one that runs.
    async tellCard({ botId, cardId, note, text, steer = false }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const body = keepLines(text, NOTE_MAX)
      if (body === '') return { error: 'Write a note first.' }
      const sessionId = threadOf(botId, cardId)
      if (sessionId === undefined) return { error: 'The card has no conversation.' }
      await rt.dispatch.sendNotice({ toId: bot.id, sessionId, role: 'wake', note: oneLine(note, 120) || `card ${cardId}`, text: body, ...(steer ? { steer: true } : {}) })
      return { where: 'card' }
    },
    // { botId } -> true while any conversation of the Bot is in a turn.
    async busy({ botId }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return false
      const sessions = [...ownChatSessions(bot), ...(rt.groupSessionsOf?.(bot.id) ?? [])]
      return sessions.some(sessionId => sessionId !== undefined && rt.live?.get(sessionId)?.turn !== undefined)
    },
    // { botId, cardId, roomId?, text } -> { where } | { error }. How a card the Bot opened
    // ended, to the Bot where it opened it: the group when it is still a member there,
    // else its own chat. It reads as DS Bot's note, not as the user's message. quiet: the
    // user ended the card themself, so the note does not ask the Bot to tell them.
    async cardEnded({ botId, cardId, roomId, text, quiet = false }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const body = keepLines(text, NOTE_MAX)
      if (body === '') return { error: 'Write a note first.' }
      const card = typeof cardId === 'string' ? cardId : 'a card'
      const target = reach(bot, { roomId, room: roomOf(roomId) })
      if (target.where === 'group') {
        await rt.dispatch.sendNotice({ toId: bot.id, sessionId: target.sessionId, role: 'room', roomId, note: `card ${card} ended`, text: body })
        return { where: 'group' }
      }
      await rt.dispatch.sendNotice({ toId: bot.id, role: quiet ? 'wake' : 'card', note: `Card ${card} ended in its own conversation`, text: body })
      return { where: 'chat' }
    },
    // { botId, cardId, stop? } -> { closed: true | 'later' | false }. 'later': the thread's
    // turn still runs and it closes when that turn ends. `stop` is why the card ended when
    // someone else ended it: a turn that still runs hears it at its next step, so it does
    // not work on for a card that is over.
    async closeCard({ botId, cardId, stop }: Record<string, any> = {}) {
      if (typeof botId !== 'string' || typeof cardId !== 'string' || typeof rt.closeCardThread !== 'function') return { closed: false }
      const sessionId = threadOf(botId, cardId)
      const body = keepLines(stop, NOTE_MAX)
      if (body !== '' && sessionId !== undefined && inTurn(sessionId)) {
        await rt.dispatch.sendNotice({ toId: botId, sessionId, role: 'wake', note: `card ${cardId} ended`, text: body, steer: true })
          .catch(error => rt.warn?.('ds-bot: could not tell the thread of %s that it ended: %s', cardId, error))
      }
      return { closed: await rt.closeCardThread(botId, cardId) }
    },
    // { botId, cardId?, roomId?, pane, text } -> { where } | { error }. Wakes a Bot whose
    // wait on a herdr pane is over, where it asked: the card's thread while it is open,
    // else the group when it is still a member there, else its own chat (the part open
    // now, not the one it asked from). It reads as DS Bot's note, not the user's.
    async wake({ botId, cardId, roomId, pane, text }: Record<string, any> = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const body = keepLines(text, BRIEF_MAX)
      if (body === '') return { error: 'Write a note first.' }
      const note = `herdr pane ${oneLine(pane, 40) || '?'} · the wait you started is over`
      const { sessionId, where } = reach(bot, { cardId: typeof cardId === 'string' && cardOpen(botId, cardId) ? cardId : undefined, roomId, room: roomOf(roomId) })
      await rt.dispatch.sendNotice({
        toId: bot.id, note, text: body,
        ...(where === 'group' ? { sessionId, role: 'room', roomId }
          : { role: 'wake', ...(where === 'card' ? { sessionId } : {}) }),
      })
      return { where: where === 'own' ? 'chat' : where }
    },
    // { cardId?, botId?, text } -> { sent: number }. A short line to the user's phone: the
    // Main Bot's own IM chats get it with no message of theirs having asked (im/index.js
    // push). A reply to it there comes back through onCardNote.
    async push({ cardId, botId, text }: Record<string, any> = {}) {
      const line = oneLine(text, PUSH_MAX)
      if (line === '' || typeof rt.imPush !== 'function') return { sent: 0 }
      return { sent: await rt.imPush({ text: line, ...(typeof cardId === 'string' ? { cardId } : {}), ...(typeof botId === 'string' ? { botId } : {}) }) }
    },
    // listener({ cardId, text, requestId }) -> Promise<boolean>: true when it took the
    // reply (the board saves it on the card and delivers it). Returns the unsubscribe.
    onCardNote(listener) {
      cardNotes.add(listener)
      return () => { cardNotes.delete(listener) }
    },
    // The board can tell whether a card is still open, including while its thread closes.
    onCardStatus(read) {
      cardStatuses.add(read)
      return () => { cardStatuses.delete(read) }
    },
    // listener({ botId, sessionId?, roomId?, cardId?, text, since, heard? }) once per finished answer; since is
    // when its turn started, heard the request ids of the user's messages it answers.
    // Returns the unsubscribe.
    onReply(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
}

export function bridgeService(rt) {
  const shared = new Map()
  rt.bridgedTools = () => [...shared.keys()]
  return Object.freeze({
    // Returns the disposer.
    share(name) {
      if (typeof name !== 'string' || name === '') throw new TypeError('dsBotBridge.share needs a tool name')
      shared.set(name, (shared.get(name) ?? 0) + 1)
      let held = true
      return () => {
        if (!held) return
        held = false
        const left = shared.get(name) - 1
        if (left > 0) shared.set(name, left)
        else shared.delete(name)
      }
    },
  })
}

export function install(rt) {
  const roster = rosterService(rt)
  const notes = notesService(rt)
  const bridge = bridgeService(rt)
  rt.companions = { roster, notes, bridge }
  if (typeof rt.ctx.provide !== 'function') return
  rt.ctx.provide('dsBotRoster', roster)
  rt.ctx.provide('dsBotNotes', notes)
  rt.ctx.provide('dsBotBridge', bridge)
}
