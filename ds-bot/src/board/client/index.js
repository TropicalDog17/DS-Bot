// The board's page in the DS Bot app. DSH loads one browser bundle per package, so this
// file ships inside DS Bot's client.js, but it stays dormant: it asks the plugin's own
// route for the board, and registers the page through DS Bot's `dsBotPages` seat only
// when that route answers. With ds-bot/board off, nothing shows and nothing changes.
import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createSource } from '../../client/sources.js'
import { BoardScreen } from './board.js'
import { BoardIcon } from './icons.js'
import { hostText, t } from '../../client/i18n.js'

export const BOARD_ROUTE = 'api/ds-bot-board'
const POLL_MS = 4000
// While the page is closed: often enough that an answer is noticed within seconds.
const WATCH_MS = 8000

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

function BoardPage({ live, focus, call, close, paneLeft, leaving }) {
  const view = useSyncExternalStore(live.source.subscribe, live.source.getSnapshot)
  useEffect(() => live.opened(), [live])
  const roster = useMemo(() => {
    const bots = view?.bots ?? []
    return { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), board: { cards: view?.cards ?? {} } }
  }, [view])
  const act = useCallback((endpoint, payload) => call(endpoint, payload).then(
    (value) => { if (value) live.take(value) },
    (error) => { live.refresh(); throw error },
  ), [call, live])
  const actions = useMemo(() => ({
    boardAdd: card => act('add', card),
    boardMove: (id, status) => act('move', { id, status }),
    boardNote: (id, text) => act('note', { id, text }),
    boardCancel: (id, reason) => act('cancel', { id, reason }),
    boardSeen: id => act('seen', { id }),
    closeBoard: close,
    reportError: () => live.refresh(),
  }), [act, close, live])
  return h(BoardScreen, { roster, actions, paneLeft, leaving, focus })
}

// Unread answers by card: a card counts again when a newer answer lands on it.
const unreadOf = view => Object.values(view?.cards ?? {})
  .filter(card => card?.unread === true)
  .map(card => ({ card, key: `${card.id}:${(card.notes ?? []).at(-1)?.at ?? card.updatedAt ?? 0}` }))

// What a notice says: who answered, on which card.
export function replyNotice(card, bots) {
  const note = (card.notes ?? []).findLast(entry => entry.by !== 'user')
  const name = bots.find(bot => bot.id === note?.by)?.name ?? bots.find(bot => bot.id === card.assignee)?.name ?? t('A Bot')
  return t('{name} replied on {card}', { name, card: card.key ?? card.title })
}

// The board's state, shared by the page and the watch that runs while it is closed. A
// Bot's answer that lands while the page is closed puts a dot on the Board button and
// shows a notice whose Open leads straight to that card. Answers already there when the
// app loads only get the dot.
export function boardWatch(pages, { first, call, openMs = POLL_MS, closedMs = WATCH_MS, setTimer = setInterval, clearTimer = clearInterval }) {
  const source = createSource(first)
  let open = 0
  let focus = null
  const told = new Set(unreadOf(first).map(entry => entry.key))
  const take = (view) => {
    const fresh = unreadOf(view)
    pages.mark('board', fresh.length > 0)
    if (open === 0) {
      for (const { card, key } of fresh) {
        if (told.has(key)) continue
        pages.alert('board', replyNotice(card, view.bots ?? []), () => { focus = card.id })
      }
    }
    for (const { key } of fresh) told.add(key)
    source.set(view)
  }
  const refresh = () => Promise.resolve().then(() => call('state')).then(value => { if (value) take(value) }, () => {})
  let timer
  const pace = () => {
    clearTimer(timer)
    timer = setTimer(() => { if (globalThis.document?.visibilityState !== 'hidden') refresh() }, open > 0 ? openMs : closedMs)
  }
  pages.mark('board', unreadOf(first).length > 0)
  pace()
  return {
    source,
    take,
    refresh,
    // The page is on screen: poll faster, and say nothing it already shows.
    opened() {
      open += 1
      pace()
      refresh()
      return () => { open -= 1; pace() }
    },
    // The card a notice led to, once.
    focus() { const id = focus; focus = null; return id },
    stop() { clearTimer(timer) },
  }
}

// Asks the route once (and once more after a network failure); registers the page when
// the plugin answers. Returns a disposer that takes the page back.
export function installBoardPage(pages, { call = boardCall, retryMs = 3000, watchMs = WATCH_MS } = {}) {
  let disposed = false
  let unregister
  let timer
  let live
  const probe = (tries) => {
    Promise.resolve().then(() => call('state')).then((value) => {
      if (disposed || value === undefined) return
      unregister = pages.register({
        id: 'board',
        title: t('Board'),
        icon: BoardIcon,
        order: 10,
        Page: ({ close, paneLeft, leaving }) => {
          const [focus] = useState(() => live.focus())
          return h(BoardPage, { live, focus, call, close, paneLeft, leaving })
        },
      })
      live = boardWatch(pages, { first: value, call, closedMs: watchMs })
    }, () => { if (!disposed && tries > 0) timer = setTimeout(() => probe(tries - 1), retryMs) })
  }
  probe(1)
  return () => { disposed = true; clearTimeout(timer); live?.stop(); unregister?.() }
}
