// -------------------------------------------------------------------------
// The composer's "@" in a Bot's chat or a group chat: a Bot group that inserts
// "@Name", and the chats that "+ → Reference a chat" opens in the same menu.
// Both are sources of the shell's trigger menu; the shell's own file and session
// rows stay beside them, because a source cannot be hidden for one Session.
import { t } from './i18n.ts'
import { currentPart, relativeShort } from './text.ts'

export const BOTS_SOURCE = 'ds-bot'
export const CHATS_SOURCE = 'ds-bot-chats'
const ROOM_ALL = ['all', 'everyone', '所有人', '全体']
const OTHER_CHATS_MAX = 8

const conversationOf = (roster, sessionId) => {
  if (!roster.ready) return null
  const room = roster.roomsById[sessionId]
  if (room) return { room }
  const self = roster.byId[sessionId]
  return self ? { self } : null
}

export function mentionRows(roster, sessionId, query = '') {
  const here = conversationOf(roster, sessionId)
  if (here === null) return null
  const bots = here.room
    ? here.room.members.map(id => roster.byId[id]).filter(Boolean)
    : roster.bots.filter(bot => bot.id !== here.self.id)
  const needle = query.trim().toLowerCase()
  const rows = bots.filter(bot => bot.name.toLowerCase().includes(needle)).map(bot => ({ bot, text: `@${bot.name} ` }))
  const everyone = t('Everyone')
  if (here.room && bots.length > 1 && [everyone, ...ROOM_ALL].some(word => word.toLowerCase().startsWith(needle))) {
    rows.push({ room: here.room, text: `@${everyone} ` })
  }
  return rows
}

export function chatRows(roster, list, sessionId) {
  const here = conversationOf(roster, sessionId)
  if (here === null) return []
  const byId = list?.byId ?? {}
  const bots = roster.bots.filter(bot => bot.id !== here.self?.id).map((bot) => {
    const id = currentPart(bot)
    return { sessionId: id, label: t('Chat with {name}', { name: bot.name }), bot, updatedAt: byId[id]?.updatedAt }
  })
  const team = new Set([
    ...roster.bots.flatMap(bot => [bot.id, currentPart(bot), ...(bot.parts ?? [])]),
    ...roster.rooms.flatMap(room => [room.id, room.sessionId, ...(room.ownParts ?? []), ...(room.parts ?? [])].filter(id => id !== undefined)),
  ])
  const others = (list?.ids ?? []).map(id => byId[id])
    .filter(row => row !== undefined && row.id !== sessionId && !team.has(row.id) && row.origin !== 'subagent' && row.blank !== true)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, OTHER_CHATS_MAX)
    .map(row => ({ sessionId: row.id, label: row.displayTitle || row.title || row.id, updatedAt: row.updatedAt }))
  return [...bots, ...others]
}

// DSH's canonical session mention: `@[label](dsh-session:<base64url of the JSON id>)`.
// The host turns it into "@label" plus a read-only snapshot of that Session.
export function sessionMention(sessionId, label) {
  let binary = ''
  for (const byte of new TextEncoder().encode(JSON.stringify(sessionId))) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `@[${label.replace(/[\\\]]/g, mark => `\\${mark}`)}](dsh-session:${payload})`
}

export function atSources({ roster, sessions, launched, iconFor }) {
  const bots = {
    trigger: '@',
    name: BOTS_SOURCE,
    order: -20,
    showGroupTitle: false,
    async candidates(session, { query }) {
      return (mentionRows(roster.getSnapshot(), session.sessionId, query) ?? []).map(row => ({
        name: row.bot ? row.bot.name : t('Everyone'),
        ...(row.bot?.role ? { description: row.bot.role } : {}),
        ...(row.room ? { description: t('{count} members', { count: row.room.members.length }) } : {}),
        icon: iconFor(row),
        section: t('Bots'),
        value: row.text,
      }))
    },
    onPick: ({ candidate }) => (candidate.value ? { text: candidate.value } : undefined),
  }
  const chats = {
    trigger: '@',
    name: CHATS_SOURCE,
    order: -10,
    showGroupTitle: false,
    async candidates(session) {
      if (!launched(session.sessionId)) return []
      return chatRows(roster.getSnapshot(), sessions.list.getSnapshot(), session.sessionId).map(row => ({
        name: row.bot ? row.bot.name : row.label,
        ...(row.updatedAt ? { description: relativeShort(row.updatedAt) } : {}),
        icon: row.bot ? iconFor(row) : 'session',
        section: row.bot ? t('Bots') : t('Conversations'),
        value: JSON.stringify({ sessionId: row.sessionId, label: row.label }),
      }))
    },
    onPick({ candidate }) {
      const { sessionId, label } = JSON.parse(candidate.value)
      const mention = sessionMention(sessionId, label)
      return { insert: { source: CHATS_SOURCE, ref: mention, label, appearance: 'session', clipboardText: mention } }
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return [bots, chats]
}
