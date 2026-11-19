// Public seams for companion plugins: read-only services a separate DSH plugin injects
// the way it injects botSessionIdentity (session-identity.js), so it never reaches into
// the team's state or its modules.
//
//   dsBotRoster  who is on the team: Bots (id, name, role, color, avatar, main) and group
//                chats (id, name, members, admin). Copies, never the saved objects.
//   dsBotNotes   one short note from the user to a Bot, through the same path as the
//                user's own messages (channel.js sendUser): into a group the Bot is in,
//                as the user's `@Bot` message, else into the Bot's own chat. onReply
//                hears each answer a Bot then writes where the user reads it.
export const NOTE_MAX = 2000

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

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
  })
}

export function notesService(rt) {
  const listeners = new Set()
  // turns.js calls this when a Bot's turn ends with text the user reads: its own chat,
  // answering the user, or any of its turns in a group chat.
  rt.botReplied = reply => {
    const heard = Object.freeze({ ...reply })
    for (const listener of listeners) {
      try { listener(heard) } catch (error) { rt.warn?.('ds-bot: reply listener failed: %s', error) }
    }
  }
  return Object.freeze({
    // { botId, text, roomId? } -> { sessionId, where: 'group' | 'chat' } | { error }.
    // A roomId the Bot is not (or no longer) a member of falls back to its own chat.
    async deliver({ botId, roomId, text } = {}) {
      await rt.load()
      const bot = typeof botId === 'string' ? rt.botOf(botId) : undefined
      if (bot === undefined) return { error: 'No such Bot.' }
      const line = oneLine(text, NOTE_MAX)
      if (line === '') return { error: 'Write a note first.' }
      const room = typeof roomId === 'string' ? rt.roomOf(roomId) : undefined
      const inGroup = room !== undefined && (room.members ?? []).includes(bot.id)
      const target = inGroup ? { sessionId: room.id, text: `@${bot.name} ${line}`, where: 'group' } : { sessionId: bot.id, text: line, where: 'chat' }
      await rt.sendUser({ sessionId: target.sessionId, content: [{ type: 'text', text: target.text }] })
      return { sessionId: target.sessionId, where: target.where }
    },
    // listener({ botId, roomId?, text, since }) once per finished answer; since is when
    // its turn started. Returns the unsubscribe.
    onReply(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
}

export function install(rt) {
  const roster = rosterService(rt)
  const notes = notesService(rt)
  rt.companions = { roster, notes }
  // A test context may have no Cordis service registry; the services only exist under a real host.
  if (typeof rt.ctx.provide !== 'function') return
  rt.ctx.provide('dsBotRoster', roster)
  rt.ctx.provide('dsBotNotes', notes)
}
