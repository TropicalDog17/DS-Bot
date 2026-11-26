// The board's page in the DS Bot app. DSH loads one browser bundle per package, so this
// file ships inside DS Bot's client.js, but it stays dormant: it asks the plugin's own
// route for the board, and registers the page through DS Bot's `dsBotPages` seat only
// when that route answers. With ds-bot/board off, nothing shows and nothing changes.
import { createElement as h, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createSource } from '../../client/sources.ts'
import { BoardScreen } from './board.ts'
import { BoardIcon } from './icons.ts'
import { CARD_LINK_ORIGIN, cardTagNode, cardTagRule, linkCards } from './card-tag.ts'
import { hostText, t } from '../../client/i18n.ts'

export const BOARD_ROUTE = 'api/ds-bot-board'
const POLL_MS = 4000
const WATCH_MS = 8000
const LIVE_MS = 1000

// One call to the plugin's route. A route that is not there (the plugin is off) answers
// with the app's HTML or a 404, which is `undefined` here; a refusal throws its message.
export async function boardCall(endpoint, payload?, { fetchImpl = globalThis.fetch } = {}) {
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
    return { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), board: { cards: view?.cards ?? {}, live: view?.live ?? {}, trace: view?.trace } }
  }, [view])
  const act = useCallback((endpoint, payload) => call(endpoint, payload).then(
    (value) => { if (value) live.take(value) },
    (error) => { live.refresh(); throw error },
  ), [call, live])
  const actions = useMemo(() => ({
    boardAdd: card => act('add', card),
    boardMove: (id, status) => act('move', { id, status }),
    boardReassign: (id, assignee) => act('reassign', { id, assignee }),
    boardNote: (id, text) => act('note', { id, text }),
    boardCancel: (id, reason) => act('cancel', { id, reason }),
    boardSeen: id => act('seen', { id }),
    boardTrace: trace => act('trace', { trace }),
    boardPane: (id, pane) => call('pane', { id, pane }),
    boardFile: (id, link) => call('file', { id, link }),
    closeBoard: close,
    reportError: () => live.refresh(),
  }), [act, close, live])
  return h(BoardScreen, { roster, actions, paneLeft, leaving, focus })
}

const unreadOf = view => Object.values<any>(view?.cards ?? {})
  .filter(card => card?.unread === true)
  .map(card => ({ card, key: `${card.id}:${(card.notes ?? []).at(-1)?.at ?? card.updatedAt ?? 0}` }))

export function replyNotice(card, bots) {
  const note = (card.notes ?? []).findLast(entry => entry.by !== 'user')
  const name = bots.find(bot => bot.id === note?.by)?.name ?? bots.find(bot => bot.id === card.assignee)?.name ?? t('A Bot')
  return t('{name} replied on {card}', { name, card: card.key ?? card.title })
}

export function boardWatch(pages, { first, call, openMs = POLL_MS, liveMs = LIVE_MS, closedMs = WATCH_MS, setTimer = setInterval, clearTimer = clearInterval }) {
  const source = createSource(first)
  let open = 0
  let focus = null
  const waits = view => Object.values<any>(view?.cards ?? {}).some(card => card?.awaiting !== undefined) || Object.keys(view?.live ?? {}).length > 0
  let waiting = waits(first)
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
    if (waits(view) !== waiting) { waiting = !waiting; pace() }
  }
  const refresh = () => {
    const current = source.getSnapshot()
    const payload = current?.revision !== undefined ? { since: current.revision, liveKey: current.liveKey } : undefined
    return Promise.resolve().then(() => call('state', payload)).then((value) => {
      if (!value) return
      if (value.unchanged === true) {
        if (value.live !== undefined) {
          const latest = source.getSnapshot()
          const next = { ...latest, live: value.live, liveKey: value.liveKey }
          source.set(next)
          if (waits(next) !== waiting) { waiting = !waiting; pace() }
        }
        return
      }
      take(value)
    }, () => {})
  }
  let timer
  const pace = () => {
    clearTimer(timer)
    const ms = open === 0 ? closedMs : waiting ? liveMs : openMs
    timer = setTimer(() => { if (globalThis.document?.visibilityState !== 'hidden') refresh() }, ms)
  }
  pages.mark('board', unreadOf(first).length > 0)
  pace()
  return {
    source,
    take,
    refresh,
    opened() {
      open += 1
      pace()
      refresh()
      return () => { open -= 1; pace() }
    },
    show(id) { focus = id },
    focus() { const id = focus; focus = null; return id },
    stop() { clearTimer(timer) },
  }
}

function tagCards(live, cardTags) {
  const show = id => live.show(id)
  const named = view => Object.fromEntries(Object.values<any>(view?.cards ?? {}).map(card => [card.id, { id: card.id, key: card.key, title: card.title }]))
  const names = createSource(named(live.source.getSnapshot()))
  let seen = JSON.stringify(names.getSnapshot())
  const offWatch = live.source.subscribe(() => {
    const next = named(live.source.getSnapshot())
    const key = JSON.stringify(next)
    if (key === seen) return
    seen = key
    names.set(next)
  })
  const off = cardTags({
    rule: cardTagRule(),
    Node: cardTagNode(show),
    botText: { origin: CARD_LINK_ORIGIN, page: 'board', link: text => linkCards(text, names.getSnapshot()), open: show, subscribe: names.subscribe },
  })
  return () => { offWatch(); off?.() }
}

export function installBoardPage(pages, { call = boardCall, retryMs = 3000, watchMs = WATCH_MS, cardTags }: any = {}) {
  let disposed = false
  let unregister
  let untag
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
      untag = cardTags === undefined ? undefined : tagCards(live, cardTags)
    }, () => { if (!disposed && tries > 0) timer = setTimeout(() => probe(tries - 1), retryMs) })
  }
  probe(1)
  return () => { disposed = true; clearTimeout(timer); live?.stop(); untag?.(); unregister?.() }
}
