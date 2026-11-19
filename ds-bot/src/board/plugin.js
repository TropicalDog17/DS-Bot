// The board plugin under a host: the `board` tool every Bot can call, and the
// POST api/ds-bot-board route the Board page uses. It knows the team only through
// DS Bot's public services: botSessionIdentity (which Bot and group a Session speaks
// for), dsBotRoster (names, marks, Main Bots, group admins) and dsBotNotes (a note
// to a Bot as the user's own message, and the Bot's answer to copy onto the card) and
// dsBotBridge (so a Bot on a local agent CLI gets the tool through DS Bot's MCP bridge).
// While a card waits for its answer, the page also shows the Bot's reasoning and tool
// calls, read from DSH's own Session events (live.js).
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomeOf } from '../host/folders.js'
import { ACTIONS, BOT_STATUSES, createBoard, isOpen } from './cards.js'
import { LEVELS, createLive, levelOf } from './live.js'
import { openBoardStore } from './store.js'

export const ROUTE = '/api/ds-bot-board'
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export const boardFileOf = (config = {}, env = process.env) => config.file ?? join(dshHomeOf(env.DSH_HOME), 'bot-board', 'board.json')

export function install(ctx, config, { identity, roster, notes, bridge, tools, connection, store = openBoardStore(boardFileOf(config), { warn: (...args) => ctx.logger?.warn?.(...args) }), now = Date.now }) {
  const board = createBoard({ roster, now })
  const live = createLive({ identity, now })

  const tool = defineTool({
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
      await roster.ready()
      const owner = identity.ownerOfSession(exec?.agent?.id)
      if (owner === undefined || roster.bot(owner.botId) === undefined) return 'Only Bots on the team can use board.'
      // The tool schema has already refused an unknown action or status and a field
      // that is not text.
      if (args.action === 'show') return board.show(store.read().cards, owner.botId)
      const result = await store.change(data => board.bot(data.cards, args.action, owner.botId, owner.roomId, args))
      if (result.error !== undefined) return result.error
      return `${result.said}\n${board.line(result.card, owner.botId)}`
    },
  })

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
        return store.change(data => board.user.add(data.cards, { title: body.title, key: body.key, url: body.url, assignee: body.assignee, status: body.status }))
      case 'move':
        return store.change(data => board.user.move(data.cards, String(body.id ?? ''), String(body.status ?? '')))
      case 'trace': {
        const trace = String(body.trace ?? '')
        if (!LEVELS.includes(trace)) return { error: 'Unknown level.', code: 'board/refused' }
        return store.change((data) => { data.settings = { ...data.settings, trace }; return {} })
      }
      case 'seen':
        return store.change(data => board.user.seen(data.cards, String(body.id ?? '')))
      case 'cancel':
        return store.change(data => board.user.cancel(data.cards, String(body.id ?? ''), body.reason))
      case 'note': {
        const id = String(body.id ?? '')
        const result = await store.change(data => board.user.note(data.cards, id, body.text))
        if (result.error === undefined && result.deliver !== undefined) {
          // The note is saved either way; a delivery that fails says so on the page.
          const since = now()
          const sent = await notes.deliver(result.deliver).catch(error => ({ error: error?.message ?? String(error) }))
          if (sent?.error !== undefined) return { error: `Saved on the card, but not sent: ${sent.error}` }
          // The Bot answers where the note went; that answer is copied onto the card.
          const roomId = sent?.where === 'group' ? result.deliver.roomId : undefined
          // A group passes the note on to the Bot as its own message, so only the Bot's
          // chat names the note in its answer.
          const requestId = sent?.where === 'chat' ? sent.requestId : undefined
          return store.change(data => board.user.sent(data.cards, id, { botId: result.deliver.botId, roomId, since, requestId }))
        }
        return result
      }
      default:
        return { error: 'Unknown board endpoint.', code: 'board/unknown' }
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
    ctx.on?.('session/event', (session, event) => live.onEvent(session?.id, event)),
    ctx.on?.('agent/assistant-stream', ({ agent, frame } = {}) => live.onFrame(agent?.id, frame)),
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
  return {
    handle: async (endpoint, payload) => respond(await handle(endpoint, payload)),
    tool,
    store,
    dispose() {
      for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
      store.dispose()
    },
  }
}
