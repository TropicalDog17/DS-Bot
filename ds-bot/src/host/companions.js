// Public seams for companion plugins: read-only services a separate DSH plugin injects
// the way it injects botSessionIdentity (session-identity.js), so it never reaches into
// the team's state or its modules.
//
//   dsBotRoster  who is on the team: Bots (id, name, role, color, avatar, main) and group
//                chats (id, name, members, admin). Copies, never the saved objects.
//                addRoutingPart adds a companion's lines to the Main Bot's routing digest.
//   dsBotNotes   one short note from the user to a Bot, through the same path as the
//                user's own messages (channel.js sendUser): into a group the Bot is in,
//                as the user's `@Bot` message, else into the Bot's own chat. onReply
//                hears each answer a Bot then writes where the user reads it.
//                startCard opens a card thread (a conversation of the Bot's own for one
//                card) with the card's brief and cardThread finds it (busy: is the Bot
//                in a turn anywhere); deliver with a
//                cardId reaches that thread; closeCard closes it once the card is
//                finished; cardEnded tells the Bot that opened a card, where it
//                opened it, how the card ended. push sends a short line to the user's
//                phone through the Main Bot's IM chat; onCardNote hears a reply there
//                to a push about a card.
//                wake tells a Bot that its wait on a herdr pane is over, where it asked.
//   dsBotBridge  the tools a Bot on a local agent CLI (Claude Code, Codex, ACP) may call
//                through DS Bot's MCP bridge. Only the team tools cross by default; a
//                companion names the tools it registers so those Bots get them too.
import { randomUUID } from 'node:crypto'
import { cardThreadSession } from './threads.js'

export const NOTE_MAX = 2000
// A card's brief keeps its lines: it is everything the assignee needs.
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
  const listeners = new Set()
  const cardNotes = new Set()
  // im/index.js calls this with a reply to a push about a card; false when no companion took it.
  rt.cardNote = async (note) => {
    for (const listener of cardNotes) {
      try {
        if (await listener(Object.freeze({ ...note })) === true) return true
      } catch (error) { rt.warn?.('ds-bot: card note listener failed: %s', error) }
    }
    return false
  }
  // turns.js calls this when a Bot's turn ends with text the user reads: its own chat,
  // answering the user, or any of its turns in a group chat.
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
    // With a cardId whose card thread is open, the note goes there instead (where: 'card').
    // A requestId of the caller's (an IM message's) takes the place of a new one, so the
    // Bot's answer also goes back where that message came from.
    async deliver({ botId, roomId, cardId, text, requestId: given } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const line = oneLine(text, NOTE_MAX)
      if (line === '') return { error: 'Write a note first.' }
      const thread = typeof cardId === 'string' ? cardThreadSession(bot, cardId) : undefined
      const newId = () => (typeof given === 'string' && given !== '' ? given : randomUUID())
      if (thread !== undefined) {
        const requestId = newId()
        await rt.sendUser({ sessionId: thread, content: [{ type: 'text', text: line }], requestId })
        return { sessionId: thread, where: 'card', requestId }
      }
      const room = typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
      const inGroup = room !== undefined && (room.members ?? []).includes(bot.id)
      const target = inGroup ? { sessionId: room.id, text: `@${bot.name} ${line}`, where: 'group' } : { sessionId: bot.id, text: line, where: 'chat' }
      const requestId = newId()
      await rt.sendUser({ sessionId: target.sessionId, content: [{ type: 'text', text: target.text }], requestId })
      return { sessionId: target.sessionId, where: target.where, requestId }
    },
    // { botId, cardId, title?, text } -> { sessionId, requestId } | { error }. Opens the
    // card's thread (or finds the open one) and sends the brief there as the user's
    // message, so the Bot works on the card apart from its chat.
    async startCard({ botId, cardId, title, text } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      if (typeof cardId !== 'string' || cardId === '') return { error: 'A card thread needs a card id.' }
      const brief = keepLines(text, BRIEF_MAX)
      if (brief === '') return { error: 'A card needs a brief.' }
      if (typeof rt.openCardThread !== 'function') return { error: 'Card threads are not available.' }
      const sessionId = await rt.openCardThread(bot.id, cardId, oneLine(title, 80))
      const requestId = randomUUID()
      await rt.sendUser({ sessionId, content: [{ type: 'text', text: brief }], requestId })
      return { sessionId, requestId }
    },
    // { botId, cardId } -> the Session of the card's open thread, or undefined.
    async cardThread({ botId, cardId } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      return bot === undefined || typeof cardId !== 'string' ? undefined : cardThreadSession(bot, cardId)
    },
    // { botId } -> true while any conversation of the Bot is in a turn.
    async busy({ botId } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return false
      const sessions = [rt.chatOf?.(bot.id), ...(bot.openParts ?? []).map(part => part.sessionId), ...(rt.groupSessionsOf?.(bot.id) ?? [])]
      return sessions.some(sessionId => sessionId !== undefined && rt.live?.get(sessionId)?.turn !== undefined)
    },
    // { botId, cardId, roomId?, text } -> { where } | { error }. How a card the Bot opened
    // ended, to the Bot where it opened it: the group when it is still a member there,
    // else its own chat. It reads as DS Bot's note, not as the user's message.
    async cardEnded({ botId, cardId, roomId, text } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const body = keepLines(text, NOTE_MAX)
      if (body === '') return { error: 'Write a note first.' }
      const card = typeof cardId === 'string' ? cardId : 'a card'
      const room = typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
      if (room !== undefined && (room.members ?? []).includes(bot.id) && room.sessions?.[bot.id] !== undefined) {
        await rt.deliver({ toId: bot.id, sessionId: room.sessions[bot.id], role: 'room', roomId: room.id, note: `card ${card} ended`, text: body })
        return { where: 'group' }
      }
      await rt.deliver({ toId: bot.id, role: 'card', note: `Card ${card} ended in its own conversation`, text: body })
      return { where: 'chat' }
    },
    // { botId, cardId } -> { closed: true | 'later' | false }. 'later': the thread's turn
    // still runs and it closes when that turn ends.
    async closeCard({ botId, cardId } = {}) {
      if (typeof botId !== 'string' || typeof cardId !== 'string' || typeof rt.closeCardThread !== 'function') return { closed: false }
      return { closed: await rt.closeCardThread(botId, cardId) }
    },
    // { botId, cardId?, roomId?, pane, text } -> { where } | { error }. Wakes a Bot whose
    // wait on a herdr pane is over, where it asked: the card's thread while it is open,
    // else the group when it is still a member there, else its own chat (the part open
    // now, not the one it asked from). It reads as DS Bot's note, not the user's.
    async wake({ botId, cardId, roomId, pane, text } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const body = keepLines(text, BRIEF_MAX)
      if (body === '') return { error: 'Write a note first.' }
      const note = `herdr pane ${oneLine(pane, 40) || '?'} · the wait you started is over`
      const thread = typeof cardId === 'string' ? cardThreadSession(bot, cardId) : undefined
      if (thread !== undefined) {
        await rt.deliver({ toId: bot.id, sessionId: thread, role: 'wake', note, text: body })
        return { where: 'card' }
      }
      const room = typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
      if (room !== undefined && (room.members ?? []).includes(bot.id) && room.sessions?.[bot.id] !== undefined) {
        await rt.deliver({ toId: bot.id, sessionId: room.sessions[bot.id], role: 'room', roomId: room.id, note, text: body })
        return { where: 'group' }
      }
      await rt.deliver({ toId: bot.id, role: 'wake', note, text: body })
      return { where: 'chat' }
    },
    // { cardId?, botId?, text } -> { sent: number }. A short line to the user's phone: the
    // Main Bot's own IM chats get it with no message of theirs having asked (im/index.js
    // push). A reply to it there comes back through onCardNote.
    async push({ cardId, botId, text } = {}) {
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
    // listener({ botId, roomId?, cardId?, text, since, heard? }) once per finished answer; since is
    // when its turn started, heard the request ids of the user's messages it answers.
    // Returns the unsubscribe.
    onReply(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
}

export function bridgeService(rt) {
  // name -> how many shares hold it: a plugin reloaded before the old copy disposes
  // shares the same name twice, and the first dispose must not drop it.
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
  // A test context may have no Cordis service registry; the services only exist under a real host.
  if (typeof rt.ctx.provide !== 'function') return
  rt.ctx.provide('dsBotRoster', roster)
  rt.ctx.provide('dsBotNotes', notes)
  rt.ctx.provide('dsBotBridge', bridge)
}
