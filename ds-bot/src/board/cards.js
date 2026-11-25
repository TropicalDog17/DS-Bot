// The card shape and its limits, and every change to the board: a Bot's through the
// board tool, the user's on the Board page. Pure functions over the cards object; the
// caller loads and saves it (store.js). Who is who comes from DS Bot's dsBotRoster.
import { randomBytes } from 'node:crypto'
import { prName, prsOf } from './prs.js'

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
// A brief keeps its lines: it is all the assignee knows of the work.
export const BRIEF_MAX = 8000
export const KEY_MAX = 32
export const URL_MAX = 2000
export const LINKS_MAX = 20
// A question a Bot asks on a card, and the choices it shows as buttons there.
export const QUESTION_MAX = 1000
export const OPTION_MAX = 80
export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 6
// What the user must do for a card that waits on them (Review or Blocked).
export const NEED_MAX = 500
export const WAITING_STATUSES = ['review', 'blocked']
// The steps a card keeps: each column and progress it moved to, so it shows how the
// work went and not only where it is.
export const LOG_MAX = 40
// The herdr panes a card's work runs in, newest last.
export const PANES_MAX = 4
// A card moved to its own conversation brings this much of its latest conversation along.
const ADOPT_NOTES = 3
const ADOPT_NOTE_MAX = 300

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

// The ticket key a title starts with ("LIFE-782: merge #1209"), or undefined.
export function titleKey(title) {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)\s*[:·–—-]\s/.exec(String(title ?? '').trim())
  return match === null ? undefined : ticketKey(match[1])
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

// A herdr pane: its id (w1:p1T) or an agent's name. It goes to herdr as one argument
// (no shell), and never as a flag.
export function paneTarget(text) {
  const target = String(text ?? '').trim()
  return /^[A-Za-z0-9][\w.:-]{0,63}$/.test(target) ? target : undefined
}

export const ACTIONS = ['open', 'update', 'ask', 'note', 'complete', 'cancel', 'show']
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
    if (card.need) rows.push(`  the user must: ${oneLine(card.need, NEED_MAX)}`)
    if (card.panes?.length > 0) rows.push(`  herdr pane: ${card.panes.map(entry => entry.id).join(', ')}`)
    const note = (card.notes ?? []).at(-1)
    if (note !== undefined) rows.push(`  latest note from ${note.by === USER ? 'the user' : nameOf(note.by)}: ${note.text}${note.options ? ` (options: ${note.options.join(' / ')})` : ''}`)
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
        if (other !== undefined && other !== card) {
          return { error: card === undefined
            ? `${key} already has an open card, ${other.id} (${nameOf(other.assignee)}): put this work on it with board note ${other.id} instead of opening another card.`
            : `${key} is already on the board as ${other.id}; update that card.` }
        }
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
  const logStep = (card, by) => {
    const log = (card.log ??= [])
    log.push({ at: now(), by, status: card.status, ...(card.progress ? { progress: card.progress } : {}) })
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX)
  }
  const dropNeed = (card) => { if (!WAITING_STATUSES.includes(card.status)) delete card.need }
  // A card in Review whose PRs are not all merged yet (`waitsMerge`) moves to Done by
  // itself once they are (plugin.js asks gh). It stops waiting when it leaves Review.
  const dropMerge = (card) => { if (card.status !== 'review') delete card.waitsMerge }
  const mergeNeed = urls => `Merge ${urls.map(url => `[${prName(url)}](${url})`).join(', ')}.`
  const addLink = (card, link) => {
    if (!(card.links ??= []).some(entry => entry.url === link)) card.links.push({ url: link, at: now() })
  }
  // A pane named again moves to the end: the newest is the one the page shows first.
  const addPane = (card, id) => {
    const panes = (card.panes ?? []).filter(entry => entry.id !== id)
    panes.push({ id, at: now() })
    card.panes = panes.slice(-PANES_MAX)
  }

  // Who may change a card: its assignee, the Bot that opened it, or a Main Bot.
  // Cancelling also lets the admin of the group a card came from.
  const mayChange = (card, self) => card.assignee === self || card.openedBy === self || isMain(self)
  const mayCancel = (card, self) => mayChange(card, self) || (card.roomId !== undefined && roster.group(card.roomId)?.admin === self)

  // A card handed to a Bot starts that Bot's card thread with this brief (dsBotNotes
  // startCard); a finished card closes it.
  const cardRules = card => `This conversation is for this card only. Keep it moving with board update (id ${card.id}); when you need the user to decide, board ask; finish with board complete and a one-line result, or board cancel with the reason.`
  const startOf = (card, from) => ({
    botId: card.assignee,
    cardId: card.id,
    title: card.title,
    text: [
      `[Card ${label(card)} · "${card.title}"] ${from === card.assignee ? 'opened by you' : `from ${from === USER ? 'the user' : nameOf(from)}`}.`,
      '',
      card.brief ?? card.title,
      '',
      cardRules(card),
    ].join('\n'),
  })
  // A card that was open before it had a conversation of its own: its earlier work is
  // where it was opened, so the brief says where to read it rather than retelling it.
  const adoptOf = (card) => {
    const group = card.roomId === undefined ? undefined : roster.group(card.roomId)
    const where = group === undefined ? 'your own chat (read_own_chat)' : `the group "${group.name}" (read_group_chat)`
    const latest = (card.notes ?? []).slice(-ADOPT_NOTES).map(note => `- ${nameOf(note.by)}: ${oneLine(note.text, ADOPT_NOTE_MAX)}`)
    const links = (card.links ?? []).map(link => link.url)
    return {
      botId: card.assignee,
      cardId: card.id,
      title: card.title,
      text: [
        `[Card ${label(card)} · "${card.title}"] moved to a conversation of its own.`,
        '',
        card.brief ?? card.title,
        '',
        [`Status: ${COLUMN[card.status] ?? card.status}.`, card.progress ? `Progress: ${card.progress}.` : '', links.length > 0 ? `Links: ${links.join(' ')}` : ''].filter(Boolean).join(' '),
        ...(latest.length > 0 ? ['', 'Latest on the card:', ...latest] : []),
        '',
        `Its earlier work is in ${where}: search it for ${card.key ?? card.id} and read what you need before you act, and do not redo what is done. If the card is waiting (Review or Blocked), say its state in one line and stop.`,
        '',
        cardRules(card),
      ].join('\n'),
    }
  }
  const closeOf = card => (card.assignee !== USER && roster.bot(card.assignee) !== undefined ? { close: { botId: card.assignee, cardId: card.id } } : {})
  // The Bot that opened a card hears how it ended where it opened it (its own chat or the
  // group), since the user asked there and the work ran in the card's own thread.
  const reportOf = (card, what) => {
    if (card.openedBy === USER || roster.bot(card.openedBy) === undefined) return {}
    const link = card.links?.at(-1)?.url
    return {
      report: {
        botId: card.openedBy,
        cardId: card.id,
        ...(card.roomId === undefined ? {} : { roomId: card.roomId }),
        text: [`Card ${label(card)} "${card.title}" ${what}${link === undefined ? '' : ` (${link})`}`, `Tell the user here in a line or two how it ended, with the card id; the whole work stays on the card.`].join('\n'),
      },
    }
  }

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
      const brief = replyText(args.brief, BRIEF_MAX)
      // Every card a Bot holds runs in a card thread of its own, which cannot see this
      // conversation, so the brief carries everything, also for a card the Bot keeps.
      const forBot = assignee !== USER
      const handed = forBot && assignee !== self
      if (handed && brief === '') return { error: `A card for ${nameOf(assignee)} needs a brief: everything it needs to do the work, since it cannot see this conversation.` }
      if (forBot && brief === '') return { error: 'A card needs a brief: the goal, the context, the limits and what done looks like. Its work runs in a conversation of its own that cannot see this one.' }
      // A title that starts with a ticket key is that ticket's card, so a follow-up on the
      // ticket goes to its open card rather than a new card beside it.
      const ticket = ticketFields(cards, { ...args, key: args.key ?? titleKey(title) })
      if (ticket.error !== undefined) return ticket
      const at = now()
      const card = {
        id: newCardId(), title, assignee, openedBy: self, status,
        progress: oneLine(args.progress, PROGRESS_MAX), links: [], notes: [],
        createdAt: at, updatedAt: at, ...(roomId !== undefined && roster.group(roomId) !== undefined ? { roomId } : {}),
        ...(brief === '' ? {} : { brief }),
      }
      apply(card, ticket.fields)
      logStep(card, self)
      cards[card.id] = card
      return {
        card,
        said: `Opened ${label(card)}: ${card.title} (${COLUMN[status]}, ${nameOf(assignee)}).${handed ? ` The card reaches ${nameOf(assignee)} by itself; do not also message it.` : forBot ? ' Its work runs in a conversation of its own that starts now: do not do it here. Tell the user in one line that you took it, with the card id.' : ''}`,
        ...(forBot ? { start: startOf(card, self) } : {}),
      }
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
      let pane
      if (args.pane !== undefined) {
        pane = paneTarget(args.pane)
        if (pane === undefined) return { error: 'pane is a herdr pane id (like w1:p1T) or an agent name.' }
      }
      if (args.title !== undefined) {
        const title = oneLine(args.title, TITLE_MAX)
        if (title === '') return { error: 'A card needs a one-line title.' }
        card.title = title
      }
      const before = card.status
      const progressBefore = card.progress
      if (args.status !== undefined) card.status = args.status
      if (args.progress !== undefined) card.progress = oneLine(args.progress, PROGRESS_MAX)
      if (args.need !== undefined) {
        const need = replyText(args.need, NEED_MAX)
        if (need === '') delete card.need
        else card.need = need
      }
      dropNeed(card)
      if (link !== undefined) addLink(card, link)
      if (pane !== undefined) addPane(card, pane)
      apply(card, ticket.fields)
      // Moved to Review, or given a PR there: it waits for that PR to be merged.
      if (card.status === 'review' && (args.status === 'review' || prsOf([link]).length > 0) && prsOf(card.links).length > 0) card.waitsMerge = true
      dropMerge(card)
      if (card.status !== before || card.progress !== progressBefore) logStep(card, self)
      touch(card)
      const ask = WAITING_STATUSES.includes(card.status) && !card.need ? ' Say with need what the user must do, with the link to it.' : ''
      return { card, before, progressBefore, said: `Updated ${label(card)} (${COLUMN[card.status]}).${ask}` }
    },
    // A question for the user with the choices to pick from. It joins the card's
    // conversation, the card moves to Review, and the user's pick comes back as a note.
    ask(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      // The pick reaches the card's assignee, so only the assignee asks.
      if (card.assignee !== self) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}; only its assignee asks on it.` }
      const question = replyText(args.question, QUESTION_MAX)
      if (question === '') return { error: 'ask needs a question.' }
      const options = [...new Set((Array.isArray(args.options) ? args.options : []).map(option => oneLine(option, OPTION_MAX)).filter(option => option !== ''))]
      if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) return { error: `ask needs ${OPTIONS_MIN} to ${OPTIONS_MAX} different options.` }
      if (card.status !== 'review') {
        card.status = 'review'
        logStep(card, self)
      }
      say(card, self, question, { options })
      card.unread = true
      return { card, said: `Asked on ${label(card)}: ${options.join(' / ')}. The user's pick reaches you as a note on the card.` }
    },
    // Something for the card's assignee, from another Bot (the Main Bot passing on what
    // the user said about the card): it joins the card's conversation and reaches the
    // assignee like the user's own note.
    note(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'Name the card with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (card.assignee === self) return { error: `${label(card)} is yours; just do it.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      const said = oneLine(args.text, NOTE_MAX)
      if (said === '') return { error: 'note needs the text to pass on.' }
      say(card, self, said)
      const bot = card.assignee === USER ? undefined : roster.bot(card.assignee)
      return {
        card,
        said: bot === undefined ? `Noted on ${label(card)}; the user holds it.` : `Passed on to ${bot.name} on ${label(card)}.`,
        ...(bot === undefined ? {} : { deliver: { botId: bot.id, cardId: card.id, ...(card.roomId === undefined ? {} : { roomId: card.roomId }), text: `Note on card ${label(card)} "${card.title}" from ${nameOf(self)}: ${said}` } }),
      }
    },
    // `unmerged`: the card's PRs that gh did not report merged (plugin.js asks before the
    // change). With any, the work is done but the card waits in Review for the merge.
    complete(cards, self, _roomId, args, { unmerged = [] } = {}) {
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
      if (unmerged.length > 0) {
        const before = card.status
        card.status = 'review'
        card.result = result
        card.waitsMerge = true
        card.need = mergeNeed(unmerged)
        logStep(card, self)
        touch(card)
        return { card, before, said: `${label(card)} waits in Review until ${unmerged.map(prName).join(', ')} ${unmerged.length === 1 ? 'is' : 'are'} merged, then moves to Done by itself. Your work on it is done: stop here.` }
      }
      card.status = 'done'
      card.result = result
      delete card.waitsMerge
      card.doneAt = now()
      dropNeed(card)
      logStep(card, self)
      touch(card)
      return { card, said: `Finished ${label(card)}: "${result}"`, ...closeOf(card), ...reportOf(card, `is done (${nameOf(self)}): ${result}`) }
    },
    cancel(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card to cancel. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayCancel(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}; only its assignee, the Bot that opened it or a Main Bot cancels it.` }
      card.status = 'cancelled'
      const why = oneLine(args.reason, REASON_MAX)
      if (why !== '') card.reason = why
      dropNeed(card)
      dropMerge(card)
      logStep(card, self)
      touch(card)
      return { card, said: `Cancelled ${label(card)}.`, ...closeOf(card), ...reportOf(card, `was cancelled (${nameOf(self)})${why === '' ? '' : `: ${why}`}`) }
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
      const brief = replyText(input.brief, BRIEF_MAX)
      const card = { id: newCardId(), title, assignee, openedBy: USER, status, progress: '', links: [], notes: [], createdAt: at, updatedAt: at, ...(brief === '' ? {} : { brief }) }
      apply(card, ticket.fields)
      logStep(card, USER)
      cards[card.id] = card
      return { card, ...(assignee === USER ? {} : { start: startOf(card, USER) }) }
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
      dropNeed(card)
      dropMerge(card)
      logStep(card, USER)
      touch(card)
      return { card, ...(status === 'done' ? closeOf(card) : {}) }
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
        ...(bot === undefined ? {} : { deliver: { botId: bot.id, cardId: card.id, ...(card.roomId === undefined ? {} : { roomId: card.roomId }), text: `Note on card ${label(card)} "${card.title}": ${said}` } }),
      }
    },
    // The note reached the Bot (`where` from dsBotNotes): the card waits for its answer
    // there. A wait already running keeps its start, so the first answer still lands.
    // A note to the Bot's own chat also keeps its request id: the answer that read it
    // names it, so it lands here even when the Bot answers other cards in between.
    // A note that reached the card's own thread (cardId) waits there: every answer in
    // that thread is the card's.
    sent(cards, id, { botId, roomId, cardId, since, requestId }) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      const same = card.awaiting?.botId === botId && card.awaiting?.roomId === roomId && card.awaiting?.cardId === cardId
      if (!same) card.awaiting = { botId, ...(roomId === undefined ? {} : { roomId }), ...(cardId === undefined ? {} : { cardId }), since }
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
      dropNeed(card)
      dropMerge(card)
      touch(card)
      return { card, ...closeOf(card) }
    },
  }

  // A Bot's answer in its chat, or in a group (dsBotNotes onReply), joins every card
  // whose note it read (`heard`). A card with no request ids to match (one that waited
  // before notes had ids) gets the answer only by waiting longest for that Bot there,
  // from a turn that began after the note. A card waiting on request ids is never matched by order: an answer
  // to another card would land on it. `trace` is how the Bot got there (live.js keep):
  // its reasoning and tool calls.
  const mirror = (cards, { botId, roomId, cardId, text, since, heard, trace } = {}) => {
    const said = replyText(text, REPLY_MAX)
    if (said === '') return { error: 'Nothing to copy.' }
    // An answer in a card thread is that card's, whether or not a note waits for it.
    if (typeof cardId === 'string') {
      const card = own(cards, cardId)
      if (card === undefined || card.assignee !== botId) return { error: 'No card waits for this answer.' }
      delete card.awaiting
      say(card, botId, said, trace === undefined ? {} : { trace })
      card.unread = true
      return { card }
    }
    const there = list(cards).filter(card => card.awaiting?.botId === botId && card.awaiting.roomId === roomId && card.awaiting.cardId === undefined)
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

  // Panes the card's Bot drove from the card's thread (plugin.js reads them off its
  // shell commands). Panes already the newest are no change, so nothing is written.
  const panes = (cards, id, ids) => {
    const card = own(cards, id)
    if (card === undefined || !isOpen(card)) return { error: 'No such open card.' }
    const fresh = ids.map(paneTarget).filter(pane => pane !== undefined)
    const known = (card.panes ?? []).map(entry => entry.id)
    if (fresh.length === 0 || fresh.join('\n') === known.slice(-fresh.length).join('\n')) return { error: 'No new pane.' }
    for (const pane of fresh) addPane(card, pane)
    return { card }
  }

  // The PRs a complete would wait on: the card's links and the link it brings.
  const prsFor = (cards, args, self) => {
    const card = pick(cards, args.id, self)
    return card === undefined ? [] : prsOf([...(card.links ?? []), args.link])
  }
  // Every PR of a card that waits for the merge is merged (plugin.js asked gh): Done.
  const merged = (cards, id) => {
    const card = own(cards, id)
    if (card === undefined || card.status !== 'review' || card.waitsMerge !== true) return { error: 'No card waits for a merge.' }
    const urls = prsOf(card.links)
    card.status = 'done'
    card.result ??= `Merged ${urls.map(prName).join(', ')}`
    card.doneAt = now()
    delete card.waitsMerge
    dropNeed(card)
    logStep(card, card.assignee)
    touch(card)
    return { card, ...closeOf(card), ...reportOf(card, `is done: ${card.result} (merged)`) }
  }

  return { show, line, label, adoptOf, panes, prsFor, merged, bot: (cards, action, self, roomId, args, extra) => botActions[action](cards, self, roomId, args, extra), user, mirror }
}
