// The board plugin under a host: the `board` tool every Bot can call, and the
// POST api/ds-bot-board route the Board page uses. It knows the team only through
// DS Bot's public services: botSessionIdentity (which Bot and group a Session speaks
// for), dsBotRoster (names, marks, Main Bots, group admins) and dsBotNotes (a note
// to a Bot as the user's own message, and the Bot's answer to copy onto the card) and
// dsBotBridge (so a Bot on a local agent CLI gets the tool through DS Bot's MCP bridge).
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomeOf } from '../host/folders.js'
import { ACTIONS, BOT_STATUSES, createBoard } from './cards.js'
import { openBoardStore } from './store.js'

export const ROUTE = '/api/ds-bot-board'
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export const boardFileOf = (config = {}, env = process.env) => config.file ?? join(dshHomeOf(env.DSH_HOME), 'bot-board', 'board.json')

export function install(ctx, config, { identity, roster, notes, bridge, tools, connection, store = openBoardStore(boardFileOf(config), { warn: (...args) => ctx.logger?.warn?.(...args) }), now = Date.now }) {
  const board = createBoard({ roster, now })

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

  // What the Board page reads: every card, and who is on the team.
  const view = () => ({
    cards: store.read().cards,
    bots: roster.bots(),
    readOnly: store.readOnly(),
  })
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
          return store.change(data => board.user.sent(data.cards, id, { botId: result.deliver.botId, roomId, since }))
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
      void store.change(data => board.mirror(data.cards, reply))
        .catch(error => ctx.logger?.warn?.('ds-bot-board: copying an answer failed: %s', error))
    }),
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
