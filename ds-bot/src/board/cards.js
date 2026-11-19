// The card shape and its limits, and every change to the board: a Bot's through the
// board tool, the user's on the Board page. Pure functions over the cards object; the
// caller loads and saves it (store.js). Who is who comes from DS Bot's dsBotRoster.
import { randomBytes } from 'node:crypto'

// `active` is the In progress column; the name stays from the group task board.
export const CARD_STATUSES = ['todo', 'active', 'review', 'blocked', 'done', 'cancelled']
export const OPEN_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER = 'user'
export const TITLE_MAX = 200
export const PROGRESS_MAX = 300
export const RESULT_MAX = 2000
export const NOTE_MAX = 500
export const REPLY_MAX = 2000
export const THREAD_MAX = 200
// A note's answer is copied from the Bot's chat only while it is this fresh.
export const AWAIT_MAX_MS = 12 * 60 * 60 * 1000
// Request ids a card keeps for one wait: a note each, so a few is plenty.
export const REQUESTS_MAX = 20
export const REASON_MAX = 500
export const KEY_MAX = 32
export const URL_MAX = 2000
export const LINKS_MAX = 20

export const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
// A Bot's reply keeps its lines; runs of blank lines become one.
export const replyText = (text, max) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
export const newCardId = () => `c_${randomBytes(4).toString('hex')}`
export const isOpen = card => OPEN_STATUSES.includes(card?.status)

// A ticket key as Jira writes it (LIFE-782), upper-cased; undefined for anything else.
export function ticketKey(text) {
  const key = String(text ?? '').trim().toUpperCase()
  return key.length <= KEY_MAX && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined
}

// An http(s) address, or undefined.
export function webUrl(text) {
  const raw = String(text ?? '').trim()
  if (raw === '' || raw.length > URL_MAX) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}


export const ACTIONS = ['open', 'update', 'complete', 'cancel', 'show']
export const BOT_STATUSES = ['todo', 'active', 'review', 'blocked']
// The user may also drag a card into Done, or back out of it.
export const USER_STATUSES = [...OPEN_STATUSES, 'done']
const COLUMN = { todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked' }
const SHOW_DONE = 5

export function createBoard({ roster, now = Date.now }) {
  const list = cards => Object.values(cards).sort((a, b) => a.createdAt - b.createdAt)
  const nameOf = id => (id === USER ? 'the user' : roster.bot(id)?.name ?? id)
  const isMain = id => roster.bot(id)?.main === true
  const label = card => `${card.id}${card.key ? ` · ${card.key}` : ''}`
  const own = (cards, id) => (typeof id === 'string' && Object.hasOwn(cards, id) ? cards[id] : undefined)

  // A card by id or ticket key; with neither, the caller's newest open card.
  const pick = (cards, ref, botId) => {
    const text = typeof ref === 'string' ? ref.trim() : ''
    if (text === '') return list(cards).filter(card => isOpen(card) && card.assignee === botId).at(-1)
    const byId = own(cards, text)
    if (byId !== undefined) return byId
    const key = ticketKey(text)
    if (key === undefined) return undefined
    const same = list(cards).filter(card => card.key === key)
    return same.filter(isOpen).at(-1) ?? same.at(-1)
  }
  const openWithKey = (cards, key) => list(cards).find(card => card.key === key && isOpen(card))

  // What a card shows a Bot: one line, the progress and the latest note under it.
  const line = (card, self) => {
    const mine = card.assignee === self ? ' (yours)' : ''
    const rows = [`- ${label(card)} · ${nameOf(card.assignee)} · ${card.title}${mine}`]
    if (card.progress) rows.push(`  progress: ${card.progress}`)
    const note = (card.notes ?? []).at(-1)
    if (note !== undefined) rows.push(`  latest note from ${note.by === USER ? 'the user' : nameOf(note.by)}: ${note.text}`)
    return rows.join('\n')
  }
  const show = (cards, self) => {
    const open = list(cards).filter(isOpen)
    const lines = [open.length === 0 ? 'The board has no open cards.' : 'The board:']
    for (const status of OPEN_STATUSES) {
      const column = open.filter(card => card.status === status)
      if (column.length > 0) lines.push(`${COLUMN[status]}:`, ...column.map(card => line(card, self)))
    }
    const done = list(cards).filter(card => card.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    if (done.length > 0) lines.push(`Done (latest ${Math.min(SHOW_DONE, done.length)} of ${done.length}):`, ...done.slice(0, SHOW_DONE).map(card => `- ${label(card)} · ${nameOf(card.assignee)} · ${card.title}`))
    return lines.join('\n')
  }

  // Key and URL as given, checked; an empty string clears them on update.
  const ticketFields = (cards, args, card) => {
    const fields = {}
    if (args.key !== undefined) {
      if (args.key.trim() === '') fields.key = undefined
      else {
        const key = ticketKey(args.key)
        if (key === undefined) return { error: 'key is a ticket key like LIFE-782.' }
        const other = openWithKey(cards, key)
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
  const touch = (card) => { card.updatedAt = now() }
  // The card's conversation: the user's notes and the Bots' replies, oldest first, the
  // last THREAD_MAX kept.
  const say = (card, by, text, extra = {}) => {
    const thread = (card.notes ??= [])
    thread.push({ at: now(), by, text, ...extra })
    if (thread.length > THREAD_MAX) thread.splice(0, thread.length - THREAD_MAX)
    touch(card)
  }
  const addLink = (card, link) => {
    if (!(card.links ??= []).some(entry => entry.url === link)) card.links.push({ url: link, at: now() })
  }

  // Who may change a card: its assignee, the Bot that opened it, or a Main Bot.
  // Cancelling also lets the admin of the group a card came from.
  const mayChange = (card, self) => card.assignee === self || card.openedBy === self || isMain(self)
  const mayCancel = (card, self) => mayChange(card, self) || (card.roomId !== undefined && roster.group(card.roomId)?.admin === self)

  const botActions = {
    open(cards, self, roomId, args) {
      const title = oneLine(args.title, TITLE_MAX)
      if (title === '') return { error: 'A card needs a one-line title.' }
      let assignee = self
      if (args.assignee !== undefined && args.assignee.trim() !== '') {
        const ref = args.assignee.trim()
        if (/^(user|owner)$/i.test(ref)) assignee = USER
        else {
          const bot = roster.findBot(ref)
          if (bot === undefined) return { error: `No Bot named ${ref}. Use an exact name from list_bots, or "user".` }
          assignee = bot.id
        }
      }
      const status = args.status ?? 'active'
      if (!BOT_STATUSES.includes(status)) return { error: `status is one of ${BOT_STATUSES.join(', ')}.` }
      const ticket = ticketFields(cards, args)
      if (ticket.error !== undefined) return ticket
      const at = now()
      const card = {
        id: newCardId(), title, assignee, openedBy: self, status,
        progress: oneLine(args.progress, PROGRESS_MAX), links: [], notes: [],
        createdAt: at, updatedAt: at, ...(roomId !== undefined && roster.group(roomId) !== undefined ? { roomId } : {}),
      }
      apply(card, ticket.fields)
      cards[card.id] = card
      return { card, said: `Opened ${label(card)}: ${card.title} (${COLUMN[status]}, ${nameOf(assignee)}).` }
    },
    update(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key, or open a card first.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      if (args.status !== undefined && !BOT_STATUSES.includes(args.status)) {
        return { error: `status is one of ${BOT_STATUSES.join(', ')}; finish a card with complete or cancel.` }
      }
      const ticket = ticketFields(cards, args, card)
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
      if (link !== undefined) addLink(card, link)
      apply(card, ticket.fields)
      touch(card)
      return { card, said: `Updated ${label(card)} (${COLUMN[card.status]}).` }
    },
    complete(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      const result = oneLine(args.result, RESULT_MAX)
      if (result === '') return { error: 'A finished card needs a one-line result.' }
      if (args.link !== undefined) {
        const link = webUrl(args.link)
        if (link === undefined) return { error: 'link must be an http(s) address.' }
        addLink(card, link)
      }
      card.status = 'done'
      card.result = result
      card.doneAt = now()
      touch(card)
      return { card, said: `Finished ${label(card)}: "${result}"` }
    },
    cancel(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
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

  const found = (cards, id) => {
    const card = own(cards, String(id ?? ''))
    return card === undefined ? { error: 'No such card.' } : { card }
  }

  // The user's own changes from the Board page.
  const user = {
    add(cards, input = {}) {
      const title = oneLine(input.title, TITLE_MAX)
      if (title === '') return { error: 'Write a title first.' }
      const status = input.status ?? 'todo'
      if (!OPEN_STATUSES.includes(status)) return { error: 'Unknown column.' }
      let assignee = USER
      if (input.assignee !== undefined && input.assignee !== null && input.assignee !== '' && input.assignee !== USER) {
        if (roster.bot(String(input.assignee)) === undefined) return { error: 'No such Bot.' }
        assignee = String(input.assignee)
      }
      const ticket = ticketFields(cards, {
        key: typeof input.key === 'string' && input.key.trim() !== '' ? input.key : undefined,
        url: typeof input.url === 'string' && input.url.trim() !== '' ? input.url : undefined,
      })
      if (ticket.error !== undefined) return ticket
      const at = now()
      const card = { id: newCardId(), title, assignee, openedBy: USER, status, progress: '', links: [], notes: [], createdAt: at, updatedAt: at }
      apply(card, ticket.fields)
      cards[card.id] = card
      return { card }
    },
    move(cards, id, status) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!USER_STATUSES.includes(status)) return { error: 'Unknown column.' }
      if (card.status === 'cancelled') return { error: 'That card is cancelled.' }
      if (card.status === status) return { card }
      card.status = status
      if (status === 'done') card.doneAt = now()
      else delete card.doneAt
      touch(card)
      return { card }
    },
    // A note joins the card's conversation; `deliver` says where it goes as the user's message
    // (dsBotNotes): the card's group when it came from one, else the Bot's own chat.
    // A card the user holds takes the note and nothing is sent.
    note(cards, id, text) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return { error: 'That card is already finished.' }
      const said = oneLine(text, NOTE_MAX)
      if (said === '') return { error: 'Write a note first.' }
      say(card, USER, said)
      const bot = card.assignee === USER ? undefined : roster.bot(card.assignee)
      return {
        card,
        ...(bot === undefined ? {} : { deliver: { botId: bot.id, ...(card.roomId === undefined ? {} : { roomId: card.roomId }), text: `Note on card ${label(card)} "${card.title}": ${said}` } }),
      }
    },
    // The note reached the Bot (`where` from dsBotNotes): the card waits for its answer
    // there. A wait already running keeps its start, so the first answer still lands.
    // A note to the Bot's own chat also keeps its request id: the answer that read it
    // names it, so it lands here even when the Bot answers other cards in between.
    sent(cards, id, { botId, roomId, since, requestId }) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      const same = card.awaiting?.botId === botId && card.awaiting?.roomId === roomId
      if (!same) card.awaiting = { botId, ...(roomId === undefined ? {} : { roomId }), since }
      if (typeof requestId === 'string') card.awaiting.requests = [...(card.awaiting.requests ?? []), requestId].slice(-REQUESTS_MAX)
      return { card }
    },
    // The user opened the card: its answer is read.
    seen(cards, id) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      delete card.unread
      return { card }
    },
    cancel(cards, id, reason) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return { error: 'That card is already finished.' }
      card.status = 'cancelled'
      const why = oneLine(reason, REASON_MAX)
      if (why !== '') card.reason = why
      touch(card)
      return { card }
    },
  }

  // A Bot's answer in its chat, or in a group (dsBotNotes onReply), joins every card
  // whose note it read (`heard`). A card with no request ids to match (a group note)
  // gets the answer only by waiting longest for that Bot there, from a turn that began
  // after the note. A card waiting on request ids is never matched by order: an answer
  // to another card would land on it. `trace` is how the Bot got there (live.js keep):
  // its reasoning and tool calls.
  const mirror = (cards, { botId, roomId, text, since, heard, trace } = {}) => {
    const said = replyText(text, REPLY_MAX)
    if (said === '') return { error: 'Nothing to copy.' }
    const there = list(cards).filter(card => card.awaiting?.botId === botId && card.awaiting.roomId === roomId)
    const read = new Set(Array.isArray(heard) ? heard : [])
    let answered = there.filter(card => (card.awaiting.requests ?? []).some(requestId => read.has(requestId)))
    if (answered.length === 0) {
      answered = there.filter(card => card.awaiting.requests === undefined
        && card.awaiting.since <= since && since - card.awaiting.since <= AWAIT_MAX_MS)
        .sort((a, b) => a.awaiting.since - b.awaiting.since)
        .slice(0, 1)
    }
    if (answered.length === 0) return { error: 'No card waits for this answer.' }
    for (const card of answered) {
      delete card.awaiting
      say(card, botId, said, trace === undefined ? {} : { trace })
      // New to the user until they open the card.
      card.unread = true
    }
    return { card: answered[0] }
  }

  return { show, line, label, bot: (cards, action, self, roomId, args) => botActions[action](cards, self, roomId, args), user, mirror }
}
