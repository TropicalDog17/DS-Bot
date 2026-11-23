// The board plugin under a host: the `board` tool every Bot can call, and the
// POST api/ds-bot-board route the Board page uses. It knows the team only through
// DS Bot's public services: botSessionIdentity (which Bot and group a Session speaks
// for), dsBotRoster (names, marks, Main Bots, group admins) and dsBotNotes (a note
// to a Bot as the user's own message, and the Bot's answer to copy onto the card) and
// dsBotBridge (so a Bot on a local agent CLI gets the tool through DS Bot's MCP bridge).
// While a card waits for its answer, the page also shows the Bot's reasoning and tool
// calls, read from DSH's own Session events (live.js).
// A card handed to another Bot starts that Bot's card thread (dsBotNotes startCard) and a
// finished card closes it. The Main Bot's routing digest lists the open cards
// (dsBotRoster addRoutingPart), the board's rules join every Bot's prompt, and what needs
// the user goes to their phone (dsBotNotes push), with a watchdog for stuck cards.
// Work a Bot hands to a herdr pane runs outside its turns; the card keeps the panes its
// Bot drives and the page reads what they show (herdr.js).
import { join } from 'node:path'
import { defineTool } from '../host/tool-schema.js'
import { dshHomeOf } from '../host/folders.js'
import { ACTIONS, BOT_STATUSES, createBoard, isOpen } from './cards.js'
import { LEVELS, createLive, levelOf } from './live.js'
import { openBoardStore } from './store.js'
import { createHerdr, herdrBinary, panesIn } from './herdr.js'
import { WATCH_MS, pushFor, sweep } from './watch.js'

export const ROUTE = '/api/ds-bot-board'
// After DS Bot's own identity section (640), so the board rules read as part of it.
const RULES_ORDER = 650
const DIGEST_CARDS = 15
// How often a card still without a card thread is tried again; the first try is this
// long after start, when DS Bot has resumed the turns a restart cut off.
const ADOPT_MS = 60_000
const COLUMN_NAME = { todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked' }
const MAIN_BOARD_RULES = [
  '## The board',
  '- A task becomes a card: board open with a one-line title, the assignee (exact Bot name) and a brief with everything that Bot needs: the goal, the context, the limits and what done looks like. It cannot see this conversation.',
  '- The card reaches that Bot by itself, in a conversation of its own for the card: do not also message_bot it. Tell the user in one line who has it and the card id.',
  '- Something the user says about work already on a card goes to that card: board note with the card id and the text. It reaches the card\'s own conversation; never pass card work on with @name in a group or message_bot, even for a card that came from a group.',
  '- When the user asks how a card is going, answer from its status and progress (team snapshot, board show) first. Only when that does not answer it, board note the question to the card and tell the user the answer will come there; do not wait for it.',
  '- A question is never a card. The open cards are in the team snapshot; board show lists the rest.',
]
const BOARD_RULES = [
  '## The board',
  '- Every task you take is a card. When the user asks you for one directly, open the card yourself (board open) with a brief: its work runs in a conversation of its own for the card, so tell the user in one line that you took it and stop there. Do not open a card for a step of the card you are working on.',
  '- A card handed to you arrives in a conversation of its own that starts with "[Card …]". Do that card\'s work there: board update as it moves (when it waits on the user, review or blocked with need: what the user must do and the link to it), board ask when the user must choose, then board complete with a one-line result or board cancel with the reason. Notes on the card arrive in the same conversation.',
  '- Work you run in a herdr pane shows on the card by itself when you drive the pane from the card\'s conversation. From anywhere else, board update with pane (its id, like w1:p1T) so the user can watch it.',
  '- A question the Main Bot passes on is not a card: just answer it.',
]
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

// The shell command of a call's arguments (JSON text or an object), or ''.
export function commandOf(argumentsText) {
  let args = argumentsText
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return args }
  }
  const command = args?.command ?? args?.cmd
  return typeof command === 'string' ? command : ''
}

export const boardFileOf = (config = {}, env = process.env) => config.file ?? join(dshHomeOf(env.DSH_HOME), 'bot-board', 'board.json')

export function install(ctx, config, { identity, roster, notes, bridge, tools, connection, systemPrompt, store = openBoardStore(boardFileOf(config), { warn: (...args) => ctx.logger?.warn?.(...args) }), herdr = createHerdr({ binary: herdrBinary(config) }), now = Date.now }) {
  const warn = (...args) => ctx.logger?.warn?.(...args)
  const board = createBoard({ roster, now })
  const live = createLive({ identity, now })

  const tool = defineTool({
    name: 'board',
    description: 'The user\'s work board, shared by the whole team. Put every piece of work on it so the user sees it without asking: open when you take it (or hand it to another Bot with a brief), update as it moves (status, progress, a PR link), complete with a one-line result, cancel with a reason. When you need the user to decide, ask with a question and the options: the card shows them as buttons and the pick comes back as a note. note passes something on to a card\'s assignee. Works from any chat. show lists the board.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'What to do' },
      id: { type: 'string', description: 'Card id or ticket key; default your newest open card' },
      title: { type: 'string', description: 'open: the work in one line' },
      key: { type: 'string', description: 'Ticket key, e.g. LIFE-782' },
      url: { type: 'string', description: 'Ticket URL' },
      assignee: { type: 'string', description: 'open: exact Bot name, or "user"; default you' },
      brief: { type: 'string', description: 'open for another Bot: everything it needs (goal, context, limits, what done looks like); it cannot see your conversation' },
      text: { type: 'string', description: 'note: what to pass on to the card\'s assignee' },
      status: { type: 'string', enum: BOT_STATUSES, description: 'todo, active (in progress), review (waits for the user), blocked' },
      progress: { type: 'string', description: 'Latest progress, one line' },
      need: { type: 'string', description: 'update to review or blocked: what the user must do (approve, merge, answer) with the link to it; Markdown' },
      link: { type: 'string', description: 'A URL to attach, e.g. the PR' },
      pane: { type: 'string', description: 'update: the herdr pane the work runs in (e.g. w1:p1T), so the card shows it' },
      result: { type: 'string', description: 'complete: the result, one line' },
      reason: { type: 'string', description: 'cancel: why it stops' },
      question: { type: 'string', description: 'ask: what the user decides; Markdown' },
      options: { type: 'array', items: { type: 'string' }, description: 'ask: 2 to 6 short choices, each one line' },
    },
    output,
    async execute(args, exec) {
      await roster.ready()
      const owner = identity.ownerOfSession(exec?.agent?.id)
      if (owner === undefined || roster.bot(owner.botId) === undefined) return 'Only Bots on the team can use board.'
      // The tool schema has already refused an unknown action or status and a field
      // that is not text.
      if (args.action === 'show') return board.show(store.read().cards, owner.botId)
      let before
      const result = await store.change((data) => {
        const changed = board.bot(data.cards, args.action, owner.botId, owner.roomId, args)
        before = changed.before
        return changed
      })
      if (result.error !== undefined) return result.error
      const after = await follow(result)
      const push = pushFor(args.action, before, result.card, nameOf)
      if (push !== undefined) void sendPush(result.card, push)
      return [result.said, after, board.line(result.card, owner.botId)].filter(Boolean).join('\n')
    },
  })

  const nameOf = id => (id === 'user' ? 'the user' : roster.bot(id)?.name ?? id)
  const sendPush = (card, text) => Promise.resolve(notes.push?.({ cardId: card.id, botId: card.assignee, text }))
    .catch(error => warn('ds-bot-board: push for %s failed: %s', card.id, error))
  // What a change sets off outside the board: a card thread to start or close, a note to
  // deliver. Returns a line for the Bot when something did not reach its Bot.
  async function follow(result) {
    if (result.start !== undefined) {
      const started = await Promise.resolve(notes.startCard?.(result.start)).catch(error => ({ error: error?.message ?? String(error) }))
      const failed = started === undefined || started.error !== undefined
      // No card thread for a card the Bot keeps: it does the work where it is.
      if (failed && result.card.openedBy === result.start.botId) return 'The card could not get a conversation of its own, so do its work here after all.'
      // No card thread: the brief still reaches the Bot, in its own chat.
      if (failed) {
        const sent = await notes.deliver({ botId: result.start.botId, cardId: result.start.cardId, text: result.start.text }).catch(error => ({ error: error?.message ?? String(error) }))
        if (sent?.error !== undefined) return `The card is open, but ${nameOf(result.start.botId)} did not get it: ${sent.error}`
      }
    }
    if (result.close !== undefined) {
      await Promise.resolve(notes.closeCard?.(result.close)).catch(error => warn('ds-bot-board: closing the thread of %s failed: %s', result.close.cardId, error))
    }
    if (result.deliver !== undefined) {
      const sent = await deliverNote(result.card.id, result.deliver)
      if (sent?.error !== undefined) return `Saved on the card, but not sent: ${sent.error}`
    }
    return undefined
  }
  // A note reaches the Bot as the user's message; the card waits for the answer there.
  async function deliverNote(id, deliver, requestId) {
    const since = now()
    const sent = await notes.deliver({ ...deliver, ...(requestId === undefined ? {} : { requestId }) }).catch(error => ({ error: error?.message ?? String(error) }))
    if (sent?.error !== undefined) return sent
    const roomId = sent?.where === 'group' ? deliver.roomId : undefined
    const cardId = sent?.where === 'card' ? deliver.cardId : undefined
    return store.change(data => board.user.sent(data.cards, id, { botId: deliver.botId, roomId, cardId, since, requestId: sent?.requestId }))
  }

  // How much of a Bot's work the page shows and an answer keeps (live.js LEVELS).
  const level = () => levelOf(store.read().settings?.trace)
  // What the Board page reads: every card, who is on the team, what each Bot a card
  // waits for is doing about it (`live`, by card id), and the level (`trace`).
  const view = () => {
    const { cards } = store.read()
    const trace = level()
    const working = {}
    for (const card of Object.values(cards)) {
      if (card.awaiting === undefined || !isOpen(card)) continue
      const now = live.current(card.awaiting, trace)
      if (now !== undefined) working[card.id] = now
    }
    return { cards, bots: roster.bots(), readOnly: store.readOnly(), live: working, trace }
  }
  async function handle(endpoint, payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    await roster.ready()
    switch (endpoint) {
      case 'state':
        return { value: view() }
      case 'add':
        return followed(await store.change(data => board.user.add(data.cards, { title: body.title, key: body.key, url: body.url, assignee: body.assignee, status: body.status, brief: body.brief })))
      case 'move':
        return followed(await store.change(data => board.user.move(data.cards, String(body.id ?? ''), String(body.status ?? ''))))
      case 'trace': {
        const trace = String(body.trace ?? '')
        if (!LEVELS.includes(trace)) return { error: 'Unknown level.', code: 'board/refused' }
        return store.change((data) => { data.settings = { ...data.settings, trace }; return {} })
      }
      case 'seen':
        return store.change(data => board.user.seen(data.cards, String(body.id ?? '')))
      case 'cancel':
        return followed(await store.change(data => board.user.cancel(data.cards, String(body.id ?? ''), body.reason)))
      case 'note':
        return userNote(String(body.id ?? ''), body.text)
      case 'pane':
        return readPane(String(body.id ?? ''), String(body.pane ?? ''))
      default:
        return { error: 'Unknown board endpoint.', code: 'board/unknown' }
    }
  }
  // The user's change, then its card thread started or closed; the page shows the board.
  const followed = async (result) => {
    if (result?.error === undefined) await follow(result)
    return result
  }
  // A note from the page, or a Telegram reply to a push about the card (requestId: the
  // reply's own, so the Bot's answer goes back to Telegram as well). The note is saved
  // either way; a delivery that fails says so.
  async function userNote(id, text, requestId) {
    const result = await store.change(data => board.user.note(data.cards, id, text))
    if (result.error !== undefined || result.deliver === undefined) return result
    const sent = await deliverNote(id, result.deliver, requestId)
    return sent?.error !== undefined ? { error: `Saved on the card, but not sent: ${sent.error}` } : sent
  }

  // What a card's pane shows now. Only a pane on the card is read: the page never names
  // a pane of its own.
  async function readPane(id, pane) {
    const card = Object.hasOwn(store.read().cards, id) ? store.read().cards[id] : undefined
    if (card === undefined) return { error: 'No such card.', code: 'board/refused' }
    if (!(card.panes ?? []).some(entry => entry.id === pane)) return { error: 'That pane is not on the card.', code: 'board/refused' }
    return { value: { pane, at: now(), ...await herdr.read(pane) } }
  }
  // A Bot's shell command that drives herdr panes, from a card's thread: the card keeps
  // those panes.
  async function notePanes(sessionId, event) {
    if (event?.type !== 'tool/call') return
    const ids = panesIn(commandOf(event.data?.arguments))
    if (ids.length === 0) return
    const owner = identity.ownerOfSession(sessionId)
    if (owner === undefined || typeof notes.cardThread !== 'function') return
    for (const card of Object.values(store.read().cards)) {
      if (!isOpen(card) || card.assignee !== owner.botId) continue
      if (await notes.cardThread({ botId: card.assignee, cardId: card.id }) !== sessionId) continue
      await store.change(data => board.panes(data.cards, card.id, ids))
      return
    }
  }

  const respond = (result) => {
    if (result?.error !== undefined) return { ok: false, error: { code: result.code ?? 'board/refused', message: result.error } }
    return { ok: true, value: result?.value ?? view() }
  }

  const disposers = [
    // The Bot answers a note in its chat, where the user reads it; the card gets a copy.
    notes.onReply?.(reply => {
      const trace = live.kept(reply, level())
      void store.change(data => board.mirror(data.cards, { ...reply, ...(trace === undefined ? {} : { trace }) }))
        .catch(error => ctx.logger?.warn?.('ds-bot-board: copying an answer failed: %s', error))
    }),
    ctx.on?.('session/event', (session, event) => {
      live.onEvent(session?.id, event)
      void notePanes(session?.id, event).catch(error => warn('ds-bot-board: noting a herdr pane failed: %s', error))
    }),
    ctx.on?.('agent/assistant-stream', ({ agent, frame } = {}) => live.onFrame(agent?.id, frame)),
    notes.onCardNote?.(async ({ cardId, text, requestId }) => {
      if (typeof cardId !== 'string' || store.read().cards[cardId] === undefined) return false
      const result = await userNote(cardId, text, requestId)
      return result?.error === undefined
    }),
    roster.addRoutingPart?.(() => openCardsDigest()),
    systemPrompt?.section?.({ name: 'ds-bot-board-rules', order: RULES_ORDER, interpolate: false, text: context => rulesFor(context?.agent?.id) }),
    watchdog(),
    adoptLater(),
    tools.register(tool),
    bridge.share(tool.name),
    connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try { body = await request.json() } catch { body = {} }
        let result
        try { result = await handle(String(body?.endpoint ?? ''), body?.payload) } catch (error) { result = { error: error?.message ?? String(error), code: 'board/failed' } }
        return new Response(JSON.stringify(respond(result)), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }),
  ]
  // The open cards, for the Main Bot's routing digest: the id to follow and who has it.
  // No times: every change of this text adds a new snapshot to the Main Bot's context.
  function openCardsDigest() {
    const open = Object.values(store.read().cards).filter(isOpen).sort((a, b) => a.createdAt - b.createdAt)
    if (open.length === 0) return 'Open cards: none.'
    const shown = open.slice(-DIGEST_CARDS)
    const rows = shown.map(card => `- ${card.id}${card.key ? ` · ${card.key}` : ''} · ${nameOf(card.assignee)} · ${COLUMN_NAME[card.status] ?? card.status} · ${card.title}`)
    return [`Open cards${open.length > shown.length ? ` (newest ${shown.length} of ${open.length}; board show lists all)` : ''}:`, ...rows].join('\n')
  }
  function rulesFor(sessionId) {
    const owner = identity.ownerOfSession(sessionId)
    const bot = owner === undefined ? undefined : roster.bot(owner.botId)
    if (bot === undefined) return ''
    return (bot.main ? MAIN_BOARD_RULES : BOARD_RULES).join('\n')
  }
  // On a schedule, what needs the user: a card stuck in progress, a card left in Review,
  // a card whose Bot is gone. Each is told once until the card changes.
  function watchdog() {
    const every = config.watchMs ?? WATCH_MS
    if (!(every > 0)) return undefined
    const timer = setInterval(() => { void watchOnce().catch(error => warn('ds-bot-board: watchdog failed: %s', error)) }, every)
    timer.unref?.()
    return () => clearInterval(timer)
  }
  // A while after start, and then every ADOPT_MS until none is left: an open card a Bot
  // holds without a card thread (opened before cards had their own, or its thread failed
  // to start) moves into one. A Bot in a turn may be working on that card where it is,
  // so its cards wait until it is idle.
  function adoptLater() {
    const every = config.adoptMs ?? ADOPT_MS
    if (!(every >= 0)) return undefined
    const timer = setInterval(() => {
      void adoptOnce().then(({ waiting }) => { if (waiting === 0) clearInterval(timer) })
        .catch(error => warn('ds-bot-board: moving cards to their threads failed: %s', error))
    }, every)
    timer.unref?.()
    return () => clearInterval(timer)
  }
  async function adoptOnce() {
    const moved = []
    let waiting = 0
    if (store.readOnly() || typeof notes.cardThread !== 'function') return { moved, waiting }
    await roster.ready()
    for (const card of Object.values(store.read().cards)) {
      if (!isOpen(card) || roster.bot(card.assignee) === undefined) continue
      if (await notes.cardThread({ botId: card.assignee, cardId: card.id }) !== undefined) continue
      if (await notes.busy?.({ botId: card.assignee })) { waiting += 1; continue }
      const started = await Promise.resolve(notes.startCard?.(board.adoptOf(card))).catch(error => ({ error: error?.message ?? String(error) }))
      if (started === undefined || started.error !== undefined) warn('ds-bot-board: %s stays without a thread: %s', card.id, started?.error ?? 'no card threads')
      else moved.push(card.id)
    }
    return { moved, waiting }
  }
  async function watchOnce() {
    if (store.readOnly()) return []
    await roster.ready()
    const alerts = sweep(store.read().cards, { now: now(), hasBot: id => roster.bot(id) !== undefined, nameOf, stuckMs: config.stuckMs, reviewMs: config.reviewMs })
    if (alerts.length === 0) return []
    await store.change((data) => {
      for (const { card, kind } of alerts) {
        if (data.cards[card.id] !== undefined) data.cards[card.id].alerted = { kind, updatedAt: card.updatedAt }
      }
      return {}
    })
    for (const { card, text } of alerts) await sendPush(card, text)
    return alerts
  }

  return {
    watchOnce,
    adoptOnce,
    rulesFor,
    openCardsDigest,
    handle: async (endpoint, payload) => respond(await handle(endpoint, payload)),
    tool,
    store,
    dispose() {
      for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
      store.dispose()
    },
  }
}
