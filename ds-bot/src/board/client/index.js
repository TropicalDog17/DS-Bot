// The board's page in the DS Bot app. DSH loads one browser bundle per package, so this
// file ships inside DS Bot's client.js, but it stays dormant: it asks the plugin's own
// route for the board, and registers the page through DS Bot's `dsBotPages` seat only
// when that route answers. With ds-bot/board off, nothing shows and nothing changes.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardDialog } from './board.js'
import { BoardIcon } from './icons.js'
import { hostText, t } from '../../client/i18n.js'

export const BOARD_ROUTE = 'api/ds-bot-board'
const POLL_MS = 4000

// One call to the plugin's route. A route that is not there (the plugin is off) answers
// with the app's HTML or a 404, which is `undefined` here; a refusal throws its message.
export async function boardCall(endpoint, payload, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(BOARD_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload ?? null }),
  })
  if (!response.ok) return undefined
  let result
  try { result = await response.json() } catch { return undefined }
  if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') return undefined
  if (!result.ok) throw Object.assign(new Error(hostText(result.error?.message ?? 'Request failed')), { code: result.error?.code })
  return result.value
}

function BoardPage({ first, call, close, paneLeft, leaving }) {
  const [view, setView] = useState(first)
  const alive = useRef(true)
  const refresh = useCallback(() => call('state').then(value => { if (alive.current && value) setView(value) }, () => {}), [call])
  useEffect(() => {
    alive.current = true
    refresh()
    // Bots move cards while the page is open; a quiet poll keeps it current.
    const timer = setInterval(() => { if (globalThis.document?.visibilityState !== 'hidden') refresh() }, POLL_MS)
    return () => { alive.current = false; clearInterval(timer) }
  }, [refresh])
  const roster = useMemo(() => {
    const bots = view?.bots ?? []
    return { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), board: { cards: view?.cards ?? {} } }
  }, [view])
  const act = useCallback((endpoint, payload) => call(endpoint, payload).then(
    (value) => { if (alive.current && value) setView(value) },
    (error) => { refresh(); throw error },
  ), [call, refresh])
  const actions = useMemo(() => ({
    boardAdd: card => act('add', card),
    boardMove: (id, status) => act('move', { id, status }),
    boardNote: (id, text) => act('note', { id, text }),
    boardCancel: (id, reason) => act('cancel', { id, reason }),
    closeBoard: close,
    reportError: () => refresh(),
  }), [act, close, refresh])
  return h(BoardDialog, { roster, actions, paneLeft, leaving })
}

// Asks the route once (and once more after a network failure); registers the page when
// the plugin answers. Returns a disposer that takes the page back.
export function installBoardPage(pages, { call = boardCall, retryMs = 3000 } = {}) {
  let disposed = false
  let unregister
  let timer
  const probe = (tries) => {
    Promise.resolve().then(() => call('state')).then((value) => {
      if (disposed || value === undefined) return
      unregister = pages.register({
        id: 'board',
        title: t('Board'),
        icon: BoardIcon,
        order: 10,
        Page: ({ close, paneLeft, leaving }) => h(BoardPage, { first: value, call, close, paneLeft, leaving }),
      })
    }, () => { if (!disposed && tries > 0) timer = setTimeout(() => probe(tries - 1), retryMs) })
  }
  probe(1)
  return () => { disposed = true; clearTimeout(timer); unregister?.() }
}
