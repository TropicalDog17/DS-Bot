import { join } from 'node:path'
import { defineTool } from '../host/tool-schema.ts'
import { dshHomeOf } from '../host/folders.ts'
import { textOf } from '../host/text.ts'
import { ACTIONS, BOT_STATUSES, createBoard, isOpen } from './cards.ts'
import { NOTE_MAX, USER } from './card-fields.ts'
import { LEVELS, createLive, levelOf } from './live.ts'
import { openBoardStore } from './store.ts'
import { createHerdr, createdPane, herdrBinary, paneCreation, panesIn } from './herdr.ts'
import { WATCH_MS, idleNudge, idleStep, idleText, sweep } from './watch.ts'
import { createPaneWaits } from './waits.ts'
import { createPaneTeardown } from './teardown.ts'
import { every } from './poller.ts'
import { createPrs, ghBinary, prsOf } from './prs.ts'

export const ROUTE = '/api/ds-bot-board'
const RULES_ORDER = 650
const DIGEST_CARDS = 15
const ADOPT_MS = 60_000
const MERGE_POLL_MS = 5 * 60 * 1000
const COLUMN_NAME = { todo: 'Todo', active: 'In progress', review: 'Review', blocked: 'Blocked' }
const MAIN_BOARD_RULES = [
  '## The board',
  '- A task becomes a card: board open with a one-line title, the assignee (exact Bot name) and a brief with everything that Bot needs: the goal, the context, the limits and what done looks like. It cannot see this conversation.',
  '- The card reaches that Bot by itself, in a conversation of its own for the card: do not also message_bot it. Tell the user in one line who has it and the card id.',
  '- Something the user says about work already on a card goes to that card: board note with the card id and the text. It reaches the card\'s own conversation; never pass card work on with @name in a group or message_bot, even for a card that came from a group.',
  '- When the user asks how a card is going, answer from its status and progress (team snapshot, board show) first. Only when that does not answer it, board note the question to the card and tell the user the answer will come there; do not wait for it.',
  '- A question is never a card. The open cards are in the team snapshot; board show lists the rest.',
  '- One open card per ticket. A next step on a ticket that has an open card is a board note to that card, not a new card. A card for a ticket starts its title with the key (LIFE-782: …), and when it follows a finished card of the ticket, its brief names that card and its result.',
]
const BOARD_RULES = [
  '## The board',
  '- Every task you take is a card. When the user asks you for one directly, open the card yourself (board open) with a brief: its work runs in a conversation of its own for the card, so tell the user in one line that you took it and stop there. Do not open a card for a step of the card you are working on.',
  '- A card handed to you arrives in a conversation of its own that starts with "[Card …]". Do that card\'s work there: board update as it moves (when it waits on the user, review or blocked with need: what the user must do and the link to it), board ask when the user must choose, then board complete with a one-line result or board cancel with the reason. A completed card waits in Review for the user to accept it, and only the user moves it to Done. A card whose PR (a link on it) is not merged yet stays in Review until every PR on it is merged. Notes on the card arrive in the same conversation.',
  '- Work you run in a herdr pane shows on the card by itself when you drive the pane from the card\'s conversation. From anywhere else, board update with pane (its id, like w1:p1T) so the user can watch it.',
  '- To wait for work in a herdr pane, call wait_pane with the pane and end your turn: you are woken in this conversation when it gets there, also after a restart. Never wait with herdr agent wait, herdr agent prompt --wait or a background job: a restart or a new part of your chat stops those, and nothing wakes you.',
  '- On a card that runs long, board update progress in one line at each step (when you hand work to a pane, when you are woken, when a test or deploy ends): the user reads it on the card and on the phone instead of asking how it is going.',
  '- A question the Main Bot passes on is not a card: just answer it.',
]
const GROUP_RULES = [
  '- In this group, answer in a few lines. Work that takes more than a quick look (code, tests, deploys, measuring, long digging) is a task: board open a card for it and do it in the card\'s conversation, then tell the group the card id in one line. Its result comes back here when it ends.',
]
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function commandOf(argumentsText) {
  let args = argumentsText
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return args }
  }
  const command = args?.command ?? args?.cmd
  return typeof command === 'string' ? command : ''
}

export const boardFileOf = (config: any = {}, env = process.env) => config.file ?? join(dshHomeOf(env.DSH_HOME), 'bot-board', 'board.json')

export function install(ctx, config: any, { identity, roster, notes, bridge, tools, connection, systemPrompt, store = openBoardStore(boardFileOf(config), { warn: (...args) => ctx.logger?.warn?.(...args) }), herdr = createHerdr({ binary: herdrBinary(config) }), prs = createPrs({ binary: ghBinary(config) }), now = Date.now }: any) {
  const warn = (...args) => ctx.logger?.warn?.(...args)
  const board = createBoard({ roster, now })
  const live = createLive({ identity, now })
  let disposed = false
  const cardOfSession = sessionId => identity.ownerOfSession(sessionId)?.cardId
  const delivering = new Map()
  const paneCalls = new Map<string, Map<string, string>>()

  const unmergedOf = async (urls) => {
    const states = await Promise.all(urls.map(url => prs.state(url).catch(() => undefined)))
    return urls.filter((_url, index) => states[index] !== 'MERGED')
  }

  const tool = defineTool({
    name: 'board',
    description: 'The user\'s work board, shared by the whole team. Put every piece of work on it so the user sees it without asking: open when you take it (or hand it to another Bot with a brief), update as it moves (status, progress, a PR link), complete with a one-line result (the card waits in Review for the user to accept it), cancel with a reason. When you need the user to decide, ask with a question and the options: the card shows them as buttons and the pick comes back as a note. note passes something on to a card\'s assignee. Works from any chat. show lists the board.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'What to do' },
      id: { type: 'string', description: 'Card id or ticket key; default your newest open card' },
      title: { type: 'string', description: 'open: the work in one line' },
      key: { type: 'string', description: 'Ticket key, e.g. LIFE-782' },
      url: { type: 'string', description: 'Ticket URL' },
      assignee: { type: 'string', description: 'open or update: exact Bot name, or "user"; default you on open. On update it moves the card to that Bot (Main Bot or the current assignee only)' },
      brief: { type: 'string', description: 'open for another Bot: everything it needs (goal, context, limits, what done looks like); it cannot see your conversation' },
      text: { type: 'string', description: `note: what to pass on to the card's assignee. Up to ${NOTE_MAX.toLocaleString('en-US')} characters, with line breaks preserved.` },
      status: { type: 'string', enum: BOT_STATUSES, description: 'todo, active (in progress), review (waits for the user), blocked' },
      progress: { type: 'string', description: 'Latest progress, one line' },
      need: { type: 'string', description: 'update to review or blocked: what the user must do (approve, merge, answer) with the link to it; Markdown' },
      link: { type: 'string', description: 'A URL to attach, e.g. the PR' },
      pane: { type: 'string', description: 'update: the herdr pane the work runs in (e.g. w1:p1T), so the card shows it' },
      result: { type: 'string', description: 'complete: the result, one line. The card waits in Review for the user to accept it; a PR not merged yet keeps it in Review until it is' },
      reason: { type: 'string', description: 'cancel: why it stops' },
      question: { type: 'string', description: 'ask: what the user decides; Markdown' },
      options: { type: 'array', items: { type: 'string' }, description: 'ask: 2 to 6 short choices, each one line' },
    },
    output,
    async execute(args, exec) {
      await roster.ready()
      const owner = identity.ownerOfSession(exec?.agent?.id)
      if (owner === undefined || roster.bot(owner.botId) === undefined) return 'Only Bots on the team can use board.'
      if (args.action === 'show') return board.show(store.read().cards, owner.botId)
      const sessionId = exec?.agent?.id
      const named = typeof args.id === 'string' && args.id.trim() !== ''
      const call = owner.cardId !== undefined && !named && args.action !== 'open' ? { ...args, id: owner.cardId } : args
      const unmerged = call.action === 'complete' ? await unmergedOf(board.prsFor(store.read().cards, call, owner.botId)) : []
      const result = await store.change(data => board.bot(data.cards, call.action, owner.botId, owner.roomId, call, { sessionId, unmerged }))
      if (result.error !== undefined) return result.error
      const after = await run(result.card, result.effects)
      return [result.said, after?.said, board.line(result.card, owner.botId)].filter(Boolean).join('\n')
    },
  })

  const nameOf = id => (id === 'user' ? 'the user' : roster.bot(id)?.name ?? id)
  const failure = error => ({ error: error?.message ?? String(error) })
  async function run(card, effects, { requestId, waitForPush = false }: any = {}) {
    const onlyFrom = effects.find(effect => effect.kind === 'report')?.onlyFrom
    const fromCard = onlyFrom !== undefined && cardOfSession(onlyFrom.sessionId) === card.id
    for (const effect of effects) {
      const { payload } = effect
      switch (effect.kind) {
        case 'start': {
          const started = await Promise.resolve().then(() => notes.startCard?.(payload)).catch(failure)
          if (started !== undefined && started.error === undefined) break
          if (effect.adopt) return { error: started?.error ?? 'no card threads' }
          if (effect.reassign) {
            warn('ds-bot-board: %s could not reach %s: %s', card.id, payload.botId, started?.error ?? 'no card threads')
            retryStart(card.id)
            return { said: 'The new assignee gets the card as soon as it can.' }
          }
          if (!effect.fallback) return { said: 'The card could not get a conversation of its own, so do its work here after all.' }
          const { botId, text } = payload
          const sent = await Promise.resolve().then(() => notes.deliver({ botId, text })).catch(failure)
          if (sent?.error !== undefined) return { said: `The card is open, but ${nameOf(botId)} did not get it: ${sent.error}` }
          break
        }
        case 'close':
          await Promise.resolve().then(() => notes.closeCard?.(payload)).catch(error => warn('ds-bot-board: closing the thread of %s failed: %s', card.id, error))
          break
        case 'report':
          if (onlyFrom === undefined || fromCard) {
            await Promise.resolve().then(() => notes.cardEnded?.(payload)).catch(error => warn('ds-bot-board: reporting %s back failed: %s', card.id, error))
          }
          break
        case 'deliver': {
          const pending = delivering.get(payload.botId) ?? new Set()
          delivering.set(payload.botId, pending)
          const delivery = deliverNote(card, payload, requestId)
          pending.add(delivery)
          try {
            const result = await delivery
            if (result?.error !== undefined) return result
          } finally {
            pending.delete(delivery)
            if (pending.size === 0) delivering.delete(payload.botId)
          }
          break
        }
        case 'push': {
          const sent = Promise.resolve().then(() => notes.push?.({ cardId: card.id, botId: card.assignee, text: effect.text }))
            .catch(error => warn('ds-bot-board: push for %s failed: %s', card.id, error))
          if (waitForPush) await sent
          break
        }
      }
    }
  }

  async function deliverNote(card, payload, requestId) {
    const since = now()
    const sent = await Promise.resolve().then(() => notes.deliver({
      ...payload, title: card.title, brief: board.briefOf(card),
      ...(requestId === undefined ? {} : { requestId }),
    })).catch(failure)
    const roomId = sent?.where === 'group' ? payload.roomId : undefined
    const cardId = sent?.where === 'card' ? payload.cardId : undefined
    const saved = sent?.error === undefined
      ? await store.change(data => board.user.sent(data.cards, card.id, { botId: payload.botId, roomId, cardId, since, requestId: sent?.requestId }))
      : sent
    if (saved.error !== undefined) {
      const message = `Saved on the card, but not sent: ${saved.error}`
      return { ...saved, error: message, said: message }
    }
  }

  const level = () => levelOf(store.read().settings?.trace)
  const running = (card, trace) => {
    if (card.assignee === USER) return undefined
    const turn = live.current({ botId: card.assignee, cardId: card.id, since: 0 }, trace)
    return turn === undefined || turn.endedAt !== undefined ? undefined : turn
  }
  let viewCache: { json: string; key: string } | undefined
  let liveCache: { json: string; key: string } | undefined
  let viewSeq = 0
  let liveSeq = 0
  const viewSnapshot = () => {
    const { cards } = store.read()
    const trace = level()
    const working = {}
    for (const card of Object.values<any>(cards)) {
      if (!isOpen(card)) continue
      const now = (card.awaiting === undefined ? undefined : live.current(card.awaiting, trace)) ?? running(card, trace)
      if (now !== undefined) working[card.id] = now
    }
    const base = { cards, bots: roster.bots(), readOnly: store.readOnly(), trace }
    const baseJson = JSON.stringify(base)
    if (viewCache?.json !== baseJson) viewCache = { json: baseJson, key: `b:${++viewSeq}` }
    const liveJson = JSON.stringify(working)
    if (liveCache?.json !== liveJson) liveCache = { json: liveJson, key: `l:${++liveSeq}` }
    return { ...base, live: working, revision: viewCache.key, liveKey: liveCache.key }
  }
  const view = () => viewSnapshot()
  async function handle(endpoint, payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    await roster.ready()
    switch (endpoint) {
      case 'state': {
        const snapshot = viewSnapshot()
        if (typeof body.since === 'string' && body.since === snapshot.revision) {
          if (body.liveKey === snapshot.liveKey) return { value: { unchanged: true, revision: snapshot.revision, liveKey: snapshot.liveKey } }
          return { value: { unchanged: true, revision: snapshot.revision, liveKey: snapshot.liveKey, live: snapshot.live } }
        }
        return { value: snapshot }
      }
      case 'add':
        return runUser(await store.change(data => board.user.add(data.cards, { title: body.title, key: body.key, url: body.url, assignee: body.assignee, status: body.status, brief: body.brief })))
      case 'move':
        return runUser(await store.change(data => board.user.move(data.cards, String(body.id ?? ''), String(body.status ?? ''))))
      case 'reassign':
        return runUser(await store.change(data => board.user.reassign(data.cards, String(body.id ?? ''), body.assignee)))
      case 'trace': {
        const trace = String(body.trace ?? '')
        if (!LEVELS.includes(trace)) return { error: 'Unknown level.', code: 'board/refused' }
        return store.change((data) => { data.settings = { ...data.settings, trace }; return {} })
      }
      case 'seen':
        return store.change(data => board.user.seen(data.cards, String(body.id ?? '')))
      case 'cancel':
        return runUser(await store.change(data => board.user.cancel(data.cards, String(body.id ?? ''), body.reason)))
      case 'note':
        return userNote(String(body.id ?? ''), body.text)
      case 'pane':
        return readPane(String(body.id ?? ''), String(body.pane ?? ''))
      default:
        return { error: 'Unknown board endpoint.', code: 'board/unknown' }
    }
  }
  const runUser = async (result, { requestId, showError = false }: any = {}) => {
    if (result.error !== undefined) return result
    const after = await run(result.card, result.effects, { requestId })
    return showError && after?.error !== undefined ? after : result
  }
  async function userNote(id, text, requestId?) {
    const result = await store.change(data => board.user.note(data.cards, id, text))
    return runUser(result, { requestId, showError: true })
  }

  async function readPane(id, pane) {
    const { cards, owned } = store.read()
    const card = Object.hasOwn(cards, id) ? cards[id] : undefined
    if (card === undefined) return { error: 'No such card.', code: 'board/refused' }
    const entry = owned?.[pane]
    if (entry?.cardId !== id && !(card.panes ?? []).some(entry => entry.id === pane)) return { error: 'That pane is not on the card.', code: 'board/refused' }
    if (entry?.closed !== undefined) return { value: { pane, ...entry.closed, closed: true } }
    return { value: { pane, at: now(), ...await herdr.read(pane) } }
  }
  async function notePanes(sessionId, event) {
    const data = event?.data
    if (event?.type === 'turn/end') {
      paneCalls.delete(sessionId)
      return
    }
    if (event?.type === 'tool/result') {
      const message = data?.message
      const calls = paneCalls.get(sessionId)
      const command = calls?.get(message?.toolCallId)
      if (command === undefined) return
      calls.delete(message.toolCallId)
      if (calls.size === 0) paneCalls.delete(sessionId)
      if (message.isError === true) return
      const created = createdPane(command, textOf(message.content))
      const owner = identity.ownerOfSession(sessionId)
      if (created === undefined || owner === undefined) return
      const { pane, terminal } = created
      const { botId, cardId } = owner
      await store.change(draft => {
        const previous = draft.owned?.[pane]
        if (disposed || (previous !== undefined && (terminal === undefined || previous.terminal === terminal))) {
          return { error: 'The pane was not registered.' }
        }
        const owned = draft.owned ??= {}
        owned[pane] = { ...created, botId, ...(cardId === undefined ? {} : { cardId }), sessionId, at: now() }
        if (cardId !== undefined) board.panes(draft.cards, cardId, [pane])
      })
      return
    }
    if (event?.type !== 'tool/call') return
    const command = commandOf(data?.arguments)
    if (data?.name === 'bash' && typeof data.callId === 'string' && paneCreation(command) !== undefined
      && identity.ownerOfSession(sessionId) !== undefined) {
      const calls = paneCalls.get(sessionId) ?? new Map()
      calls.set(data.callId, command)
      paneCalls.set(sessionId, calls)
    }
    const ids = panesIn(command)
    if (ids.length === 0) return
    const cardId = cardOfSession(sessionId)
    if (cardId !== undefined) await store.change(data => board.panes(data.cards, cardId, ids))
  }

  const respond = (result) => {
    if (result?.error !== undefined) return { ok: false, error: { code: result.code ?? 'board/refused', message: result.error } }
    return { ok: true, value: result?.value ?? view() }
  }

  const waits = createPaneWaits({
    store, herdr, notes, now, identity, roster, warn,
    every: (ms, job, options) => {
      const interval = config.waitPollMs ?? ms
      return interval > 0 ? every(interval, job, options) : () => {}
    },
  })
  const teardown = createPaneTeardown({
    store, herdr, now, warn, roster,
    every: (ms, job, options) => {
      const interval = config.teardownPollMs ?? ms
      return interval > 0 ? every(interval, job, options) : () => {}
    },
  })
  const disposers = [
    notes.onCardStatus?.(cardId => {
      const cards = store.read().cards
      return Object.hasOwn(cards, cardId) ? isOpen(cards[cardId]) : undefined
    }),
    notes.onReply?.(reply => {
      const cardId = cardOfSession(reply.sessionId)
      if (reply.cardId !== undefined && cardId !== reply.cardId) return
      const trace = live.kept({ ...reply, cardId }, level())
      const copy = () => store.change(data => board.mirror(data.cards, {
        ...reply, cardId,
        hasThread: id => notes.hasCardThread?.({ botId: reply.botId, cardId: id }),
        ...(trace === undefined ? {} : { trace }),
      }))
      const pending = delivering.get(reply.botId)
      void (pending === undefined ? copy() : Promise.allSettled(pending).then(copy))
        .catch(error => ctx.logger?.warn?.('ds-bot-board: copying an answer failed: %s', error))
    }),
    ctx.on?.('session/event', (session, event) => {
      live.onEvent(session?.id, event)
      void notePanes(session?.id, event).catch(error => warn('ds-bot-board: noting a herdr pane failed: %s', error))
    }),
    ctx.on?.('agent/assistant-stream', ({ agent, frame }: any = {}) => live.onFrame(agent?.id, frame)),
    notes.onCardNote?.(async ({ cardId, text, requestId }) => {
      if (typeof cardId !== 'string' || !Object.hasOwn(store.read().cards, cardId)) return false
      const result = await userNote(cardId, text, requestId)
      return result?.error === undefined ? true : { error: result.error }
    }),
    roster.addRoutingPart?.(() => openCardsDigest()),
    systemPrompt?.section?.({ name: 'ds-bot-board-rules', order: RULES_ORDER, interpolate: false, text: context => rulesFor(context?.agent?.id) }),
    watchdog(),
    adoptLater(),
    stopRetries,
    tools.register(tool),
    bridge.share(tool.name),
    tools.register(waits.tool),
    bridge.share(waits.tool.name),
    waits.dispose,
    teardown.dispose,
    mergePoller(),
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
  // No times: every change of this text adds a new snapshot to the Main Bot's context.
  function openCardsDigest() {
    const open = Object.values<any>(store.read().cards).filter(isOpen).sort((a, b) => a.createdAt - b.createdAt)
    if (open.length === 0) return 'Open cards: none.'
    const shown = open.slice(-DIGEST_CARDS)
    const rows = shown.map(card => `- ${card.id}${card.key ? ` · ${card.key}` : ''} · ${nameOf(card.assignee)} · ${COLUMN_NAME[card.status] ?? card.status} · ${card.title}`)
    return [`Open cards${open.length > shown.length ? ` (newest ${shown.length} of ${open.length}; board show lists all)` : ''}:`, ...rows].join('\n')
  }
  function rulesFor(sessionId) {
    const owner = identity.ownerOfSession(sessionId)
    const bot = owner === undefined ? undefined : roster.bot(owner.botId)
    if (bot === undefined) return ''
    if (bot.main) return MAIN_BOARD_RULES.join('\n')
    return (owner.roomId === undefined || owner.cardId !== undefined ? BOARD_RULES : [...BOARD_RULES, ...GROUP_RULES]).join('\n')
  }
  function watchdog() {
    const interval = config.watchMs ?? WATCH_MS
    if (!(interval > 0)) return undefined
    const job = async () => { await watchOnce(); await idleOnce() }
    return every(interval, job, { readOnly: () => store.readOnly(), onError: error => warn('ds-bot-board: watchdog failed: %s', error) })
  }
  function adoptLater() {
    const interval = config.adoptMs ?? ADOPT_MS
    if (!(interval >= 0)) return undefined
    const dispose = every(interval, async () => {
      const { waiting } = await adoptOnce()
      if (waiting === 0) dispose()
    }, { readOnly: () => store.readOnly(), onError: error => warn('ds-bot-board: moving cards to their threads failed: %s', error) })
    return dispose
  }
  const retryingStarts = new Set<string>()
  let stopRetryStarts
  function stopRetries() {
    stopRetryStarts?.()
    stopRetryStarts = undefined
  }
  function retryStart(cardId: string) {
    if (disposed) return
    retryingStarts.add(cardId)
    if (stopRetryStarts !== undefined) return
    const interval = config.adoptMs ?? ADOPT_MS
    if (!(interval >= 0)) return
    stopRetryStarts = every(interval, async () => {
      if (disposed) { stopRetries(); return }
      await roster.ready()
      for (const id of [...retryingStarts]) {
        const card = store.read().cards[id]
        if (!isOpen(card) || roster.bot(card.assignee) === undefined) { retryingStarts.delete(id); continue }
        if (typeof notes.cardThread === 'function' && await notes.cardThread({ botId: card.assignee, cardId: id }).catch(() => undefined) !== undefined) { retryingStarts.delete(id); continue }
        if (await notes.busy?.({ botId: card.assignee })) continue
        const { error } = await run(card, [{ kind: 'start', payload: board.adoptOf(card), adopt: true }]) ?? {}
        if (error === undefined) retryingStarts.delete(id)
        else warn('ds-bot-board: %s stays without a thread: %s', id, error)
      }
      if (retryingStarts.size === 0) stopRetries()
    }, { readOnly: () => store.readOnly(), onError: error => warn('ds-bot-board: moving cards to their threads failed: %s', error) })
  }
  async function adoptOnce() {
    const moved = []
    let waiting = 0
    if (store.readOnly() || typeof notes.cardThread !== 'function') return { moved, waiting }
    await roster.ready()
    for (const card of Object.values<any>(store.read().cards)) {
      if (!isOpen(card) || roster.bot(card.assignee) === undefined) continue
      if (card.status === 'review' && card.completedBy !== undefined) continue
      if (await notes.cardThread({ botId: card.assignee, cardId: card.id }) !== undefined) continue
      if (await notes.busy?.({ botId: card.assignee })) { waiting += 1; continue }
      const { error } = await run(card, [{ kind: 'start', payload: board.adoptOf(card), adopt: true }]) ?? {}
      if (error !== undefined) warn('ds-bot-board: %s stays without a thread: %s', card.id, error)
      else moved.push(card.id)
    }
    return { moved, waiting }
  }
  let merging = false
  async function mergeOnce() {
    if (disposed || merging || store.readOnly()) return []
    merging = true
    const done = []
    try {
      await roster.ready()
      for (const card of Object.values<any>(store.read().cards)) {
        if (card.status !== 'review' || card.waitsMerge !== true) continue
        const urls = prsOf(card.links)
        if (urls.length === 0) continue
        const states = await Promise.all(urls.map(url => prs.state(url).catch(() => undefined)))
        if (disposed) break
        if (states.some(state => state !== 'MERGED')) {
          const of = wanted => urls.filter((_url, index) => states[index] === wanted)
          const waiting = await store.change(data => (disposed ? { error: 'The board is disposed.' } : board.mergeWait(data.cards, card.id, { open: of('OPEN'), closed: of('CLOSED'), unread: of(undefined) })))
          if (waiting.error === undefined) await run(waiting.card, waiting.effects, { waitForPush: true })
          continue
        }
        const result = await store.change(data => {
          if (disposed) return { error: 'The board is disposed.' }
          const currentUrls = prsOf(data.cards[card.id]?.links)
          if (currentUrls.some(url => !urls.includes(url))) return { error: 'The card has unchecked PRs.' }
          return board.merged(data.cards, card.id)
        })
        if (result.error !== undefined) continue
        await run(result.card, result.effects)
        done.push(card.id)
      }
    } finally {
      merging = false
    }
    return done
  }
  function mergePoller() {
    const interval = config.mergePollMs ?? MERGE_POLL_MS
    if (!(interval > 0)) return undefined
    return every(interval, mergeOnce, { readOnly: () => store.readOnly(), onError: error => warn('ds-bot-board: checking merged PRs failed: %s', error) })
  }
  async function watchOnce() {
    if (disposed || store.readOnly()) return []
    await roster.ready()
    if (disposed) return []
    const alerts = sweep(store.read().cards, { now: now(), hasBot: id => roster.bot(id) !== undefined, nameOf, stuckMs: config.stuckMs, reviewMs: config.reviewMs })
    if (alerts.length === 0) return []
    const saved = await store.change((data) => {
      if (disposed) return { error: 'The board is disposed.' }
      for (const { card, kind } of alerts) {
        if (data.cards[card.id] !== undefined) data.cards[card.id].alerted = { kind, updatedAt: card.updatedAt }
      }
      return {}
    })
    if (disposed || saved.error !== undefined) return []
    for (const { card, text } of alerts) await run(card, [{ kind: 'push', text }], { waitForPush: true })
    return alerts
  }

  async function idleOnce() {
    if (disposed || store.readOnly() || typeof notes.cardBusy !== 'function') return []
    await roster.ready()
    if (disposed) return []
    const data = store.read()
    const waited = new Set(Object.values<any>(data.waits ?? {}).map(wait => wait.cardId))
    const at = now()
    const steps = []
    for (const card of Object.values<any>(data.cards)) {
      if (!isOpen(card) || roster.bot(card.assignee) === undefined) continue
      const quiet = card.awaiting === undefined && notes.cardBusy({ botId: card.assignee, cardId: card.id }) === false
      const step = idleStep(card, { now: at, quiet, waited: waited.has(card.id), idleMs: config.idleMs })
      if (step !== undefined) steps.push({ card, step })
    }
    const done = []
    for (const { card, step } of steps) {
      const saved = await store.change((draft) => {
        const current = draft.cards[card.id]
        if (disposed || current === undefined || current.updatedAt !== card.updatedAt) return { error: 'The card moved.' }
        if (step === 'clear') delete current.idle
        else current.idle = { count: (current.idle?.count ?? 0) + 1, at }
        return {}
      })
      if (disposed) break
      if (saved.error !== undefined || step === 'clear') continue
      if (step === 'nudge') {
        const sent = await Promise.resolve().then(() => notes.tellCard?.({ botId: card.assignee, cardId: card.id, note: `card ${card.id} · nothing runs for it`, text: idleNudge(card) })).catch(failure)
        if (sent?.error !== undefined) warn('ds-bot-board: nudging %s failed: %s', card.id, sent.error)
      } else {
        await run(card, [{ kind: 'push', text: idleText(card, nameOf(card.assignee), at - (card.updatedAt ?? at)) }], { waitForPush: true })
      }
      done.push({ id: card.id, step })
    }
    return done
  }

  return {
    watchOnce,
    idleOnce,
    adoptOnce,
    waits,
    teardown,
    mergeOnce,
    rulesFor,
    openCardsDigest,
    handle: async (endpoint, payload) => respond(await handle(endpoint, payload)),
    tool,
    store,
    dispose() {
      disposed = true
      paneCalls.clear()
      for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
      store.dispose()
    },
  }
}
