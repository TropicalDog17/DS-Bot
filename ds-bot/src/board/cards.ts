import { randomBytes } from 'node:crypto'
import { prName, prsOf } from './prs.ts'
import { pushFor, pushText } from './watch.ts'
import { OPEN_STATUSES, USER, isOpen, oneLine } from './card-fields.ts'

export { OPEN_STATUSES, USER, isOpen, oneLine } from './card-fields.ts'

export const CARD_STATUSES = ['todo', 'active', 'review', 'blocked', 'done', 'cancelled']
export const TITLE_MAX = 200
export const PROGRESS_MAX = 300
export const RESULT_MAX = 2000
export const NOTE_MAX = 500
export const REPLY_MAX = 20_000
export const THREAD_MAX = 200
export const AWAIT_MAX_MS = 12 * 60 * 60 * 1000
export const REQUESTS_MAX = 20
export const REASON_MAX = 500
export const BRIEF_MAX = 8000
export const KEY_MAX = 32
export const URL_MAX = 2000
export const LINKS_MAX = 20
export const QUESTION_MAX = 1000
export const OPTION_MAX = 80
export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 6
export const NEED_MAX = 500
export const WAITING_STATUSES = ['review', 'blocked']
export const LOG_MAX = 40
export const PANES_MAX = 4
const ADOPT_NOTES = 3
export const MERGE_MISSES = 3
const ADOPT_NOTE_MAX = 300
const ACCEPT_NEED = 'Review the result, then move the card to Done if you accept it.'

export const replyText = (text, max) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
export const newCardId = () => `c_${randomBytes(4).toString('hex')}`

export function ticketKey(text) {
  const key = String(text ?? '').trim().toUpperCase()
  return key.length <= KEY_MAX && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined
}

export function titleKey(title) {
  const match = /^([A-Za-z][A-Za-z0-9_]*-\d+)\s*[:·–—-]\s/.exec(String(title ?? '').trim())
  return match === null ? undefined : ticketKey(match[1])
}

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

export function paneTarget(text) {
  const target = String(text ?? '').trim()
  return /^[A-Za-z0-9][\w.:-]{0,63}$/.test(target) ? target : undefined
}

export const ACTIONS = ['open', 'update', 'ask', 'note', 'complete', 'cancel', 'show']
export const BOT_STATUSES = ['todo', 'active', 'review', 'blocked']
export const USER_STATUSES = [...OPEN_STATUSES, 'done']
const COLUMN = { todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked' }
const SHOW_DONE = 5

export function createBoard({ roster, now = Date.now }) {
  const list = (cards: Record<string, any>) => Object.values<any>(cards).sort((a, b) => a.createdAt - b.createdAt)
  const nameOf = id => (id === USER ? 'the user' : roster.bot(id)?.name ?? id)
  const isMain = id => roster.bot(id)?.main === true
  const label = card => `${card.id}${card.key ? ` · ${card.key}` : ''}`
  const own = (cards, id) => (typeof id === 'string' && Object.hasOwn(cards, id) ? cards[id] : undefined)

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

  const ticketFields = (cards, args, card?) => {
    const fields: Record<string, any> = {}
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
  const dropMerge = (card) => {
    if (card.status === 'review') return
    delete card.waitsMerge
    delete card.mergeIssue
    delete card.mergeMisses
    delete card.toldOpener
  }
  const mergeNeed = urls => `Merge ${urls.map(url => `[${prName(url)}](${url})`).join(', ')}.`
  const addLink = (card, link) => {
    if (!(card.links ??= []).some(entry => entry.url === link)) card.links.push({ url: link, at: now() })
  }
  const addPane = (card, id) => {
    const panes = (card.panes ?? []).filter(entry => entry.id !== id)
    panes.push({ id, at: now() })
    card.panes = panes.slice(-PANES_MAX)
  }

  const mayChange = (card, self) => card.assignee === self || card.openedBy === self || isMain(self)
  const mayCancel = (card, self) => mayChange(card, self) || (card.roomId !== undefined && roster.group(card.roomId)?.admin === self)

  const cardRules = card => `This conversation is for this card only. Keep it moving with board update (id ${card.id}); when you need the user to decide, board ask; finish with board complete and a one-line result: the card waits in Review for the user to accept it, and only the user moves it to Done; or board cancel with the reason.`
  const startOf = (card, from) => ({
    botId: card.assignee,
    cardId: card.id,
    title: card.title,
    ...(card.roomId === undefined ? {} : { roomId: card.roomId }),
    text: [
      `[Card ${label(card)} · "${card.title}"] ${from === card.assignee ? 'opened by you' : `from ${from === USER ? 'the user' : nameOf(from)}`}.`,
      '',
      card.brief ?? card.title,
      '',
      cardRules(card),
    ].join('\n'),
  })
  const adoptOf = (card) => {
    const group = card.roomId === undefined ? undefined : roster.group(card.roomId)
    const where = group === undefined ? 'your own chat (read_own_chat)' : `the group "${group.name}" (read_group_chat)`
    const latest = (card.notes ?? []).slice(-ADOPT_NOTES).map(note => `- ${nameOf(note.by)}: ${oneLine(note.text, ADOPT_NOTE_MAX)}`)
    const links = (card.links ?? []).map(link => link.url)
    return {
      botId: card.assignee,
      cardId: card.id,
      title: card.title,
      ...(card.roomId === undefined ? {} : { roomId: card.roomId }),
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
  const backOf = (card, was, guidance) => {
    const latest = (card.notes ?? []).slice(-ADOPT_NOTES).map(note => `- ${nameOf(note.by)}: ${oneLine(note.text, ADOPT_NOTE_MAX)}`)
    const links = (card.links ?? []).map(link => link.url)
    return {
      botId: card.assignee,
      cardId: card.id,
      title: card.title,
      ...(card.roomId === undefined ? {} : { roomId: card.roomId }),
      text: [
        `[Card ${label(card)} · "${card.title}"] was ${was}; the user moved it back to In progress.`,
        '',
        card.brief ?? card.title,
        '',
        [card.result ? `Result so far: ${card.result}.` : '', links.length > 0 ? `Links: ${links.join(' ')}` : ''].filter(Boolean).join(' '),
        ...(latest.length > 0 ? ['', 'Latest on the card:', ...latest] : []),
        '',
        guidance,
        '',
        cardRules(card),
      ].filter((line, index, lines) => !(line === '' && lines[index - 1] === '')).join('\n'),
    }
  }
  const reopenOf = card => backOf(card, 'Done', 'The user wants more done on it. If the card does not say what, ask with board ask before you change anything; do not redo what is done.')
  const rejectOf = card => backOf(card, 'in Review', 'The user did not accept it. If the card does not say what to change, ask with board ask before you change anything; do not redo what is done.')
  const outcome = (card, said?, effects: any[] = []) => ({ card, said, effects })
  const withPush = (action, result, before?, progressBefore?) => {
    const { card, effects } = result
    const at = now()
    const text = pushFor(action, before, card, nameOf, { now: at, lastPush: card.pushedAt, progressBefore })
    if (text !== undefined) {
      effects.push({ kind: 'push', text })
      if (isOpen(card) && !effects.some(effect => effect.kind === 'close')) card.pushedAt = at
    }
    return result
  }
  const closeOf = (card, stop?) => {
    delete card.pushedAt
    delete card.idle
    return card.assignee !== USER && roster.bot(card.assignee) !== undefined
      ? [{ kind: 'close', payload: { botId: card.assignee, cardId: card.id, ...(stop === undefined ? {} : { stop: `${stop} Stop the work on it now and end your turn.` }) } }]
      : []
  }
  const reportOf = (card, what, self?, sessionId?, { quiet = false } = {}) => {
    if (card.openedBy === USER || roster.bot(card.openedBy) === undefined) return []
    const link = card.links?.at(-1)?.url
    return [{
      kind: 'report',
      ...(self === card.openedBy ? { onlyFrom: { botId: self, sessionId } } : {}),
      payload: {
        botId: card.openedBy,
        cardId: card.id,
        ...(card.roomId === undefined ? {} : { roomId: card.roomId }),
        ...(quiet ? { quiet: true } : {}),
        text: [
          `Card ${label(card)} "${card.title}" ${what}${link === undefined ? '' : ` (${link})`}`,
          quiet
            ? 'The user did this on the board, so there is nothing to tell them. Do not go on with the card, and do not open it again.'
            : 'Tell the user here in a line or two how it ended, with the card id; the whole work stays on the card.',
        ].join('\n'),
      },
    }]
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
      const forBot = assignee !== USER
      const handed = forBot && assignee !== self
      if (handed && brief === '') return { error: `A card for ${nameOf(assignee)} needs a brief: everything it needs to do the work, since it cannot see this conversation.` }
      if (forBot && brief === '') return { error: 'A card needs a brief: the goal, the context, the limits and what done looks like. Its work runs in a conversation of its own that cannot see this one.' }
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
      return outcome(card,
        `Opened ${label(card)}: ${card.title} (${COLUMN[status]}, ${nameOf(assignee)}).${handed ? ` The card reaches ${nameOf(assignee)} by itself; do not also message it.` : forBot ? ' Its work runs in a conversation of its own that starts now: do not do it here. Tell the user in one line that you took it, with the card id.' : ''}`,
        forBot ? [{ kind: 'start', payload: startOf(card, self), fallback: handed }] : [])
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
      if (card.status !== 'review') delete card.completedBy
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
      if (card.status === 'review' && (args.status === 'review' || prsOf([link]).length > 0) && prsOf(card.links).length > 0) card.waitsMerge = true
      dropMerge(card)
      if (card.status !== before || card.progress !== progressBefore) logStep(card, self)
      touch(card)
      const ask = WAITING_STATUSES.includes(card.status) && !card.need ? ' Say with need what the user must do, with the link to it.' : ''
      return withPush('update', outcome(card, `Updated ${label(card)} (${COLUMN[card.status]}).${ask}`), before, progressBefore)
    },
    ask(cards, self, _roomId, args) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
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
      return withPush('ask', outcome(card, `Asked on ${label(card)}: ${options.join(' / ')}. The user's pick reaches you as a note on the card.`))
    },
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
      const effects = bot === undefined ? [] : [{ kind: 'deliver', payload: { botId: bot.id, cardId: card.id, ...(card.roomId === undefined ? {} : { roomId: card.roomId }), text: `Note on card ${label(card)} "${card.title}" from ${nameOf(self)}: ${said}` } }]
      return outcome(card, bot === undefined ? `Noted on ${label(card)}; the user holds it.` : `Passed on to ${bot.name} on ${label(card)}.`, effects)
    },
    complete(cards, self, _roomId, args, { sessionId, unmerged = [] }: any = {}) {
      const card = pick(cards, args.id, self)
      if (card === undefined) return { error: 'No open card of yours. Name one with its id or ticket key.' }
      if (!isOpen(card)) return { error: `${label(card)} is already finished.` }
      if (!mayChange(card, self)) return { error: `${label(card)} belongs to ${nameOf(card.assignee)}.` }
      const result = oneLine(args.result, RESULT_MAX)
      if (result === '') return { error: 'A finished card needs a one-line result.' }
      let link
      if (args.link !== undefined) {
        link = webUrl(args.link)
        if (link === undefined) return { error: 'link must be an http(s) address.' }
      }
      if (card.status === 'review' && card.completedBy !== undefined) {
        const sameResult = result === card.result
        const newLink = link !== undefined && !(card.links ?? []).some(entry => entry.url === link)
        if (sameResult && !newLink) {
          if (unmerged.length === 0 && card.waitsMerge === true) {
            delete card.waitsMerge
            card.need = ACCEPT_NEED
            touch(card)
          }
          return outcome(card, `${label(card)} is already in Review and waits for the user to accept it.`)
        }
      }
      if (link !== undefined) addLink(card, link)
      card.status = 'review'
      card.result = result
      card.completedBy = self
      delete card.doneAt
      if (unmerged.length > 0) {
        card.waitsMerge = true
        card.need = mergeNeed(unmerged)
        logStep(card, self)
        touch(card)
        card.toldOpener = true
        const waitsFor = `${unmerged.map(prName).join(', ')} ${unmerged.length === 1 ? 'is' : 'are'} merged`
        return withPush('complete', outcome(card, `${label(card)} waits in Review until ${waitsFor}; after that the user moves it to Done. Your work on it is done: stop here.`,
          reportOf(card, `is finished (${nameOf(self)}) and waits in Review until ${waitsFor}: ${result}`, self, sessionId)))
      }
      delete card.waitsMerge
      card.need = ACCEPT_NEED
      logStep(card, self)
      touch(card)
      return withPush('complete', outcome(card, `Finished ${label(card)}: "${result}". It waits in Review for the user to accept it; only the user moves it to Done.`, [...closeOf(card), ...reportOf(card, `is finished (${nameOf(self)}) and waits in Review for the user to accept it: ${result}`, self, sessionId)]))
    },
    cancel(cards, self, _roomId, args, { sessionId }: any = {}) {
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
      const stop = self === card.assignee ? undefined : `${nameOf(self)} cancelled card ${label(card)}${why === '' ? '' : `: ${why}`}.`
      return withPush('cancel', outcome(card, `Cancelled ${label(card)}.`, [...closeOf(card, stop), ...reportOf(card, `was cancelled (${nameOf(self)})${why === '' ? '' : `: ${why}`}`, self, sessionId)]))
    },
  }

  const found = (cards, id) => {
    const card = own(cards, String(id ?? ''))
    return card === undefined ? { error: 'No such card.' } : { card }
  }

  const user = {
    add(cards, input: any = {}) {
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
      return outcome(card, undefined, assignee === USER ? [] : [{ kind: 'start', payload: startOf(card, USER), fallback: true }])
    },
    move(cards, id, status) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!USER_STATUSES.includes(status)) return { error: 'Unknown column.' }
      if (card.status === 'cancelled') return { error: 'That card is cancelled.' }
      if (card.status === status) return outcome(card)
      const before = card.status
      const completed = card.completedBy !== undefined
      const rejected = before === 'review' && completed
      const resumed = (before === 'done' || rejected) && status === 'active' && card.assignee !== USER && roster.bot(card.assignee) !== undefined
      card.status = status
      if (status === 'done') card.doneAt = now()
      else delete card.doneAt
      if (status !== 'review') delete card.completedBy
      dropNeed(card)
      dropMerge(card)
      logStep(card, USER)
      touch(card)
      if (status === 'done') {
        return outcome(card, undefined, [
          ...closeOf(card, `The user moved card ${label(card)} to Done on the board.`),
          ...reportOf(card, 'was moved to Done by the user', undefined, undefined, { quiet: true }),
        ])
      }
      return outcome(card, undefined, resumed ? [{ kind: 'start', payload: before === 'done' ? reopenOf(card) : rejectOf(card), fallback: true }] : [])
    },
    note(cards, id, text) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      const bot = card.assignee === USER ? undefined : roster.bot(card.assignee)
      if (!isOpen(card) && bot === undefined) return { error: 'That card is already finished.' }
      const said = oneLine(text, NOTE_MAX)
      if (said === '') return { error: 'Write a note first.' }
      say(card, USER, said)
      delete card.idle
      const effects = bot === undefined ? [] : [{ kind: 'deliver', payload: { botId: bot.id, cardId: card.id, ...(card.roomId === undefined ? {} : { roomId: card.roomId }), text: `Note on card ${label(card)} "${card.title}": ${said}` } }]
      return outcome(card, undefined, effects)
    },
    sent(cards, id, { botId, roomId, cardId, since, requestId }: any) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return outcome(card)
      const same = card.awaiting?.botId === botId && card.awaiting?.roomId === roomId && card.awaiting?.cardId === cardId
      if (!same) card.awaiting = { botId, ...(roomId === undefined ? {} : { roomId }), ...(cardId === undefined ? {} : { cardId }), since }
      if (typeof requestId === 'string') card.awaiting.requests = [...(card.awaiting.requests ?? []), requestId].slice(-REQUESTS_MAX)
      return outcome(card)
    },
    seen(cards, id) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      delete card.unread
      return outcome(card)
    },
    cancel(cards, id, reason?) {
      const { card, error } = found(cards, id)
      if (error !== undefined) return { error }
      if (!isOpen(card)) return { error: 'That card is already finished.' }
      card.status = 'cancelled'
      const why = oneLine(reason, REASON_MAX)
      if (why !== '') card.reason = why
      dropNeed(card)
      dropMerge(card)
      logStep(card, USER)
      touch(card)
      return outcome(card, undefined, [
        ...closeOf(card, `The user cancelled card ${label(card)} on the board${why === '' ? '' : `: ${why}`}.`),
        ...reportOf(card, `was cancelled by the user${why === '' ? '' : `: ${why}`}`, undefined, undefined, { quiet: true }),
      ])
    },
  }

  const mirror = (cards, { botId, roomId, cardId, text, since, heard, trace, hasThread = (() => false) as any }: any = {}) => {
    const said = replyText(text, REPLY_MAX)
    if (said === '') return { error: 'Nothing to copy.' }
    const read = new Set(Array.isArray(heard) ? heard : [])
    const heardNote = card => card.awaiting?.requests?.some(requestId => read.has(requestId))
    if (typeof cardId === 'string') {
      const card = own(cards, cardId)
      if (card === undefined || card.assignee !== botId) return { error: 'No card waits for this answer.' }
      if (card.awaiting?.cardId === cardId && heardNote(card)) delete card.awaiting
      say(card, botId, said, trace === undefined ? {} : { trace })
      card.unread = true
      return outcome(card)
    }
    const there = list(cards).filter(card => card.awaiting?.botId === botId && card.awaiting.roomId === roomId && card.awaiting.cardId === undefined)
    let answered = there.filter(heardNote)
    if (answered.length === 0) {
      answered = there.filter(card => card.awaiting.requests === undefined
        && card.awaiting.since <= since && since - card.awaiting.since <= AWAIT_MAX_MS
        && !hasThread(card.id))
        .sort((a, b) => a.awaiting.since - b.awaiting.since)
        .slice(0, 1)
    }
    if (answered.length === 0) return { error: 'No card waits for this answer.' }
    for (const card of answered) {
      delete card.awaiting
      say(card, botId, said, trace === undefined ? {} : { trace })
      card.unread = true
    }
    return outcome(answered[0])
  }

  const panes = (cards, id, ids) => {
    const card = own(cards, id)
    if (card === undefined || !isOpen(card)) return { error: 'No such open card.' }
    const fresh = ids.map(paneTarget).filter(pane => pane !== undefined)
    const known = (card.panes ?? []).map(entry => entry.id)
    if (fresh.length === 0 || fresh.join('\n') === known.slice(-fresh.length).join('\n')) return { error: 'No new pane.' }
    for (const pane of fresh) addPane(card, pane)
    return outcome(card)
  }

  const prsFor = (cards, args, self) => {
    const card = pick(cards, args.id, self)
    return card === undefined ? [] : prsOf([...(card.links ?? []), args.link])
  }
  const merged = (cards, id) => {
    const card = own(cards, id)
    if (card === undefined || card.status !== 'review' || card.waitsMerge !== true) return { error: 'No card waits for a merge.' }
    const urls = prsOf(card.links)
    card.result ??= `Merged ${urls.map(prName).join(', ')}`
    card.completedBy ??= card.assignee
    delete card.waitsMerge
    card.need = ACCEPT_NEED
    logStep(card, card.assignee)
    touch(card)
    const told = card.toldOpener === true
    delete card.toldOpener
    delete card.mergeIssue
    delete card.mergeMisses
    return withPush('merged', outcome(card, undefined, told ? [] : reportOf(card, `is merged and waits in Review for the user to accept it: ${card.result}`)))
  }
  const mergeWait = (cards, id, { open = [], closed = [], unread = [] } = {}) => {
    const card = own(cards, id)
    if (card === undefined || card.status !== 'review' || card.waitsMerge !== true) return { error: 'No card waits for a merge.' }
    const misses = unread.length > 0 ? Math.min((card.mergeMisses ?? 0) + 1, MERGE_MISSES) : 0
    const issue = closed.length > 0 ? 'closed' : misses >= MERGE_MISSES ? 'unread' : undefined
    if (issue === card.mergeIssue && misses === (card.mergeMisses ?? 0)) return { error: 'Nothing new.' }
    if (misses === 0) delete card.mergeMisses
    else card.mergeMisses = misses
    if (issue === card.mergeIssue) return outcome(card)
    const names = urls => urls.map(url => `[${prName(url)}](${url})`).join(', ')
    if (issue === undefined) {
      delete card.mergeIssue
      card.need = mergeNeed([...open, ...unread])
      touch(card)
      return outcome(card)
    }
    card.mergeIssue = issue
    card.need = issue === 'closed'
      ? `${names(closed)} ${closed.length === 1 ? 'was' : 'were'} closed without merging. Reopen and merge ${closed.length === 1 ? 'it' : 'them'}, send a note with what to do instead, or move the card to Done if you accept it.`
      : `gh could not read ${names(unread)} (not signed in, or no access), so the card stays in Review. Merge ${unread.length === 1 ? 'it' : 'them'}, then move the card to Done.`
    touch(card)
    const what = issue === 'closed'
      ? `"${card.title}": ${closed.map(prName).join(', ')} closed without merging, the card stays in Review`
      : `"${card.title}": cannot read ${unread.map(prName).join(', ')}, the card stays in Review`
    return outcome(card, undefined, [{ kind: 'push', text: pushText(card, nameOf(card.assignee), what) }])
  }

  const briefOf = card => startOf(card, card.openedBy).text
  return { show, line, label, adoptOf, briefOf, panes, prsFor, merged, mergeWait, bot: (cards, action, self, roomId, args, extra?) => botActions[action](cards, self, roomId, args, extra), user, mirror }
}
