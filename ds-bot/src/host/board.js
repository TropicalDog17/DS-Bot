// The user's work board: one board for the whole team, a card per piece of work, in the
// columns Todo, In progress, Review, Blocked and Done. A Bot moves its cards with the
// `board` tool from any of its Sessions (its own chat, a group, a talk with another
// Bot); the user adds, moves, notes and cancels cards on the Board page. Cards are
// registered explicitly, never guessed from the chat.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import {
  LINKS_MAX, NOTE_MAX, OPEN_STATUSES, PROGRESS_MAX, REASON_MAX, RESULT_MAX, TITLE_MAX, USER,
  boardOf, isOpen, newCardId, oneLine, ticketKey, webUrl,
} from './board-data.js'

const ACTIONS = ['open', 'update', 'complete', 'cancel', 'show']
const BOT_STATUSES = ['todo', 'active', 'review', 'blocked']
// The user may also drag a card into Done, or back out of it.
const USER_STATUSES = [...OPEN_STATUSES, 'done']
const COLUMN = { todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked' }
const SHOW_DONE = 5

export function install(rt) {
  const cardsOf = () => boardOf(rt.state).cards
  const list = () => Object.values(cardsOf()).sort((a, b) => a.createdAt - b.createdAt)
  const nameOf = id => (id === USER ? 'the user' : rt.botOf(id)?.name ?? id)
  const touch = (card) => { card.updatedAt = Date.now() }

  // A card by id or ticket key; with neither, the caller's newest open card.
  const pick = (ref, botId) => {
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text === '') return list().filter(card => isOpen(card) && card.assignee === botId).at(-1)
    const byId = cardsOf()[text]
    if (byId !== undefined) return byId
    const key = ticketKey(text)
    if (key === undefined) return undefined
    const same = list().filter(card => card.key === key)
    return same.filter(isOpen).at(-1) ?? same.at(-1)
  }
  const openWithKey = key => list().find(card => card.key === key && isOpen(card))
  const label = card => `${card.id}${card.key ? ` · ${card.key}` : ''}`

  // What a card shows a Bot: one line, the progress and the latest note under it.
  const line = (card, self) => {
    const mine = card.assignee === self ? ' (yours)' : ''
    const rows = [`- ${label(card)} · ${nameOf(card.assignee)} · ${card.title}${mine}`]
    if (card.progress) rows.push(`  progress: ${card.progress}`)
    const note = (card.notes ?? []).at(-1)
    if (note !== undefined) rows.push(`  latest note from ${note.by === USER ? 'the user' : nameOf(note.by)}: ${note.text}`)
    return rows.join('\n')
  }
  const show = (self) => {
    const open = list().filter(isOpen)
    const lines = [open.length === 0 ? 'The board has no open cards.' : 'The board:']
    for (const status of OPEN_STATUSES) {
      const cards = open.filter(card => card.status === status)
      if (cards.length > 0) lines.push(`${COLUMN[status]}:`, ...cards.map(card => line(card, self)))
    }
    const done = list().filter(card => card.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    if (done.length > 0) lines.push(`Done (latest ${Math.min(SHOW_DONE, done.length)} of ${done.length}):`, ...done.slice(0, SHOW_DONE).map(card => `- ${label(card)} · ${nameOf(card.assignee)} · ${card.title}`))
    return lines.join('\n')
  }

  // Key and URL as given, checked; an empty string clears them on update.
  const ticketFields = (args, card) => {
    const fields = {}
    if (args.key !== undefined) {
      if (args.key.trim() === '') fields.key = undefined
      else {
        const key = ticketKey(args.key)
        if (key === undefined) return { error: 'key is a ticket key like LIFE-782.' }
        const other = openWithKey(key)
        if (other !== undefined && other !== card) return { error: `${key} is already on the board as ${other.id}; update that card.` }
        fields.key = key
      }
    }
    if (args.url !== undefined) {
      if (args.url.trim() === '') fields.url = undefined
      else {
        const url = webUrl(args.url)
        if (url === undefined) return { error: 'url must be an http(s) address.' }
        fields.url = url
      }
    }
    return { fields }
  }
  const apply = (card, fields) => {
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) delete card[name]
      else card[name] = value
    }
  }

  // Who may change a card: its assignee, the Bot that opened it, or a Main Bot.
  // Cancelling also lets the admin of the group a card came from.
  const mayChange = (card, self) => card.assignee === self || card.openedBy === self || rt.isMain(self)
  const mayCancel = (card, self) => {
    if (mayChange(card, self)) return true
    const room = card.roomId === undefined ? undefined : rt.roomOf(card.roomId)
    return room !== undefined && rt.isAdminOf(room, self)
  }

  const botActions = {
    open(self, args, exec) {
      const title = oneLine(args.title, TITLE_MAX)
      if (title === '') return { error: 'A card needs a one-line title.' }
      let assignee = self
      if (args.assignee !== undefined && args.assignee.trim() !== '') {
        const ref = args.assignee.trim()
        if (/^(user|owner)$/i.test(ref)) assignee = USER
        else {
          const bot = rt.findBot(ref)
          if (bot === undefined) return { error: `No Bot named ${ref}. Use an exact name from list_bots, or "user".` }
          assignee = bot.id
        }
      }
      const status = args.status ?? 'active'
      if (!BOT_STATUSES.includes(status)) return { error: `status is one of ${BOT_STATUSES.join(', ')}.` }
      const ticket = ticketFields(args)
      if (ticket.error !== undefined) return ticket
      const at = Date.now()
      const roomId = rt.groupOwners.get(exec.agent?.id)?.roomId
      const card = {
        id: newCardId(), title, assignee, openedBy: self, status,
        progress: oneLine(args.progress, PROGRESS_MAX), links: [], notes: [],
        createdAt: at, updatedAt: at, ...(roomId !== undefined && rt.roomOf(roomId) !== undefined ? { roomId } : {}),
      }
      apply(card, ticket.fields)
      cardsOf()[card.id] = card
      return { card, said: `Opened ${label(card)}: ${card.title} (${COLUMN[status]}, ${nameOf(assignee)}).` }
    },
    update(self, args) {
      const card = pick(args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key, or open a card first.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      if (args.status !== undefined && !BOT_STATUSES.includes(args.status)) {
        return { error: `status is one of ${BOT_STATUSES.join(', ')}; finish a card with complete or cancel.` }
      }
      const ticket = ticketFields(args, card)
      if (ticket.error !== undefined) return ticket
      let link
      if (args.link !== undefined) {
        link = webUrl(args.link)
        if (link === undefined) return { error: 'link must be an http(s) address.' }
        if ((card.links ?? []).length >= LINKS_MAX && !card.links.some(entry => entry.url === link)) return { error: `A card keeps at most ${LINKS_MAX} links.` }
      }
      if (args.title !== undefined) {
        const title = oneLine(args.title, TITLE_MAX)
        if (title === '') return { error: 'A card needs a one-line title.' }
        card.title = title
      }
      if (args.status !== undefined) card.status = args.status
      if (args.progress !== undefined) card.progress = oneLine(args.progress, PROGRESS_MAX)
      if (link !== undefined && !(card.links ??= []).some(entry => entry.url === link)) card.links.push({ url: link, at: Date.now() })
      apply(card, ticket.fields)
      touch(card)
      return { card, said: `Updated ${label(card)} (${COLUMN[card.status]}).` }
    },
    complete(self, args) {
      const card = pick(args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      const result = oneLine(args.result, RESULT_MAX)
      if (result === '') return { error: 'A finished card needs a one-line result.' }
      if (args.link !== undefined) {
        const link = webUrl(args.link)
        if (link === undefined) return { error: 'link must be an http(s) address.' }
        if (!(card.links ??= []).some(entry => entry.url === link)) card.links.push({ url: link, at: Date.now() })
      }
      card.status = 'done'
      card.result = result
      card.doneAt = Date.now()
      touch(card)
      return { card, said: `Finished ${label(card)}: "${result}"` }
    },
    cancel(self, args) {
      const card = pick(args.id, self)
      if (card === undefined) return { error: 'No open card to cancel. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayCancel(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}; only its assignee, the Bot that opened it or a Main Bot cancels it.` }
      card.status = 'cancelled'
      const why = oneLine(args.reason, REASON_MAX)
      if (why !== '') card.reason = why
      touch(card)
      return { card, said: `Cancelled ${label(card)}.` }
    },
  }

  rt.teamTools.push(defineTool({
    name: 'board',
    description: 'The user\'s work board, shared by the whole team. Put every piece of work you take on it so the user sees it without asking: open when you take it, update as it moves (status, progress, a PR link), complete with a one-line result, cancel with a reason. Works from any chat. show lists the board.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'What to do' },
      id: { type: 'string', description: 'Card id or ticket key; default your newest open card' },
      title: { type: 'string', description: 'open: the work in one line' },
      key: { type: 'string', description: 'Ticket key, e.g. LIFE-782' },
      url: { type: 'string', description: 'Ticket URL' },
      assignee: { type: 'string', description: 'open: exact Bot name, or "user"; default you' },
      status: { type: 'string', enum: BOT_STATUSES, description: 'todo, active (in progress), review (waits for the user), blocked' },
      progress: { type: 'string', description: 'Latest progress, one line' },
      link: { type: 'string', description: 'A URL to attach, e.g. the PR' },
      result: { type: 'string', description: 'complete: the result, one line' },
      reason: { type: 'string', description: 'cancel: why it stops' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use board.'
      // The tool schema has already refused an unknown action or status and a field
      // that is not text.
      if (args.action === 'show') return show(self)
      const result = botActions[args.action](self, args, exec)
      if (result.error !== undefined) return result.error
      await rt.save()
      return `${result.said}\n${line(result.card, self)}`
    },
  }))

  // Where a note on a card goes: into the card's group as the user's `@Bot` message
  // when it came from a group the assignee is still in, else into the assignee's own
  // chat. A card the user holds takes the note and nothing is sent.
  const noteTarget = (card, text) => {
    const bot = card.assignee === USER ? undefined : rt.botOf(card.assignee)
    if (bot === undefined) return undefined
    const room = card.roomId === undefined ? undefined : rt.roomOf(card.roomId)
    if (room !== undefined && room.members?.includes(bot.id)) return { sessionId: room.id, text: `@${bot.name} ${text}` }
    return { sessionId: bot.id, text: `Note on board card ${label(card)} "${card.title}": ${text}` }
  }
  const found = (id) => {
    const card = cardsOf()[String(id ?? '')]
    return card === undefined ? { error: 'No such card.' } : { card }
  }

  Object.assign(rt, {
    boardAdd(input = {}) {
      const title = oneLine(input.title, TITLE_MAX)
      if (title === '') return { error: 'Write a title first.' }
      const status = input.status ?? 'todo'
      if (!OPEN_STATUSES.includes(status)) return { error: 'Unknown column.' }
      let assignee = USER
      if (input.assignee !== undefined && input.assignee !== null && input.assignee !== '' && input.assignee !== USER) {
        if (rt.botOf(String(input.assignee)) === undefined) return { error: 'No such Bot.' }
        assignee = String(input.assignee)
      }
      const ticket = ticketFields({
        key: typeof input.key === 'string' && input.key.trim() !== '' ? input.key : undefined,
        url: typeof input.url === 'string' && input.url.trim() !== '' ? input.url : undefined,
      })
      if (ticket.error !== undefined) return ticket
      const at = Date.now()
      const card = { id: newCardId(), title, assignee, openedBy: USER, status, progress: '', links: [], notes: [], createdAt: at, updatedAt: at }
      apply(card, ticket.fields)
      cardsOf()[card.id] = card
      return { card }
    },
    boardMove(id, status) {
      const { card, error } = found(id)
      if (error !== undefined) return { error }
      if (!USER_STATUSES.includes(status)) return { error: 'Unknown column.' }
      if (card.status === 'cancelled') return { error: 'That card is cancelled.' }
      if (card.status === status) return { card }
      card.status = status
      if (status === 'done') card.doneAt = Date.now()
      else delete card.doneAt
      touch(card)
      return { card }
    },
    boardNote(id, text) {
      const { card, error } = found(id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return { error: 'That card is already finished.' }
      const line_ = oneLine(text, NOTE_MAX)
      if (line_ === '') return { error: 'Write a note first.' }
      ;(card.notes ??= []).push({ at: Date.now(), by: USER, text: line_ })
      touch(card)
      return { card, deliver: noteTarget(card, line_) }
    },
    boardCancel(id, reason) {
      const { card, error } = found(id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return { error: 'That card is already finished.' }
      card.status = 'cancelled'
      const why = oneLine(reason, REASON_MAX)
      if (why !== '') card.reason = why
      touch(card)
      return { card }
    },
  })
}
