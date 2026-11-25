import { randomUUID } from 'node:crypto'
import { REPLY_KIND, SOURCE_KIND } from './constants.ts'

// DSH context informs a turn without asking anything.
const CONTEXT_FORMS = new Set(['snapshot', 'catalog', 'instructions', 'notice'])
const MAX_PENDING = 256
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000

export function createReplyOrigin({
  now = Date.now, connections, runners, paired, bindingOf, chatOfBot,
  roomOf = (() => undefined) as (id: any) => any, roomWorking = (() => false) as (id: any) => boolean,
  isBotChat = (() => true) as (id: any) => boolean, sessionExists = (() => true) as (id: any) => boolean,
  savedCarries, save, warn, botOfSession,
}) {
  const origins = new Map()
  const mixed = new Set()
  const pendingReset = new Set()
  const requests = new Map()
  const resumedOrigins = new Map()
  const activeOn = new Map()
  const imVia = new Map()

  const connection = id => (Object.values(connections()) as any[]).find(conn => conn.id === id)
  const sameChat = (a, b) => a.connId === b.connId && a.chatKey === b.chatKey && a.senderId === b.senderId

  function destination(entry) {
    if (entry === undefined) return undefined
    const conn = connection(entry.connId)
    if (conn === undefined) return undefined
    if (entry.senderId !== undefined && !paired(conn, entry.senderId)) return undefined
    const chat = conn.chats?.[entry.chatKey]
    if (chat === undefined || entry.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) return undefined
    return { conn, chatKey: entry.chatKey, chat }
  }

  function resolve(entry) {
    const route = destination(entry)
    return route !== undefined && runners.has(route.conn.id) ? route : undefined
  }

  const of = sessionId => resolve(origins.get(sessionId))
  const deliveryOf = (sessionId) => {
    const entry = origins.get(sessionId)
    const route = resolve(entry)
    if (route === undefined || entry.ready === undefined) return route
    return { ...route, canSend: async () => await entry.ready && resolve(entry) !== undefined }
  }
  const durableOf = token => {
    const entries = savedCarries?.()
    return entries != null && Object.hasOwn(entries, token) ? entries[token] : undefined
  }
  const heldOf = token => resumedOrigins.get(token) ?? durableOf(token)
  const heldEntries = () => [...resumedOrigins, ...Object.entries(savedCarries?.() ?? {})]

  function persist(confirmed = () => true) {
    return Promise.resolve().then(save).then(confirmed, error => {
      warn?.('ds-bot: IM Dispatch origin could not be saved: %s', error)
      return false
    })
  }

  function release(token) {
    resumedOrigins.delete(token)
    activeOn.delete(token)
    if (durableOf(token) === undefined) return undefined
    delete savedCarries()[token]
    return persist(() => durableOf(token) === undefined)
  }

  function pruneRequests() {
    const cutoff = now() - REQUEST_TTL_MS
    for (const [id, entry] of requests) if (entry.at <= cutoff) forgetRequest(id)
  }

  function prune() {
    pruneRequests()
    for (const [token, entry] of heldEntries()) {
      if (entry.issuedBy === undefined) continue
      if (!sessionExists(entry.issuedBy) || destination(entry) === undefined
        || (entry.botId !== undefined && botOfSession?.(entry.issuedBy) !== entry.botId)) release(token)
    }
  }

  function holdToken(sessionId, dispatch, exchangeId?) {
    const origin = origins.get(sessionId)
    if (origin === undefined || (dispatch && resolve(origin) === undefined)) return undefined
    prune()
    const held = heldEntries()
    if (held.length >= MAX_PENDING) {
      const [oldest] = held.reduce((first, next) => next[1].at < first[1].at ? next : first)
      release(oldest)
      warn?.('ds-bot: evicted the oldest IM reply origin at the limit of %d', MAX_PENDING)
    }
    const { connId, chatKey, senderId, binding, ready } = origin
    const token = randomUUID()
    const entry = { connId, chatKey, senderId, binding, at: now() }
    activeOn.set(token, sessionId)
    if (dispatch) Object.assign(entry, { issuedBy: sessionId, exchangeId, botId: botOfSession?.(sessionId) })
    if (dispatch && savedCarries !== undefined) savedCarries(true)[token] = entry
    else resumedOrigins.set(token, { ...entry, ready })
    return token
  }

  const hold = sessionId => holdToken(sessionId, false)
  const carry = (sessionId, exchangeId) => holdToken(sessionId, true, exchangeId)

  function matchesCarry(sessionId, token) {
    if (token === undefined) return of(sessionId) === undefined
    const entry = origins.get(sessionId)
    const earlier = heldOf(token)
    return earlier !== undefined && sessionExists(earlier.issuedBy) && resolve(entry) !== undefined
      && sameChat(earlier, entry) && earlier.binding === entry.binding
  }

  function drop(sessionId) {
    origins.delete(sessionId)
    mixed.add(sessionId)
    for (const [token, active] of activeOn) if (active === sessionId) release(token)
  }

  function reset(sessionId) {
    origins.delete(sessionId)
    mixed.delete(sessionId)
  }

  function claim(sessionId, entry) {
    const { connId, chatKey, senderId } = entry
    if (sessionId === undefined || connId === undefined || mixed.has(sessionId)) return
    const previous = origins.get(sessionId)
    if (previous !== undefined && !sameChat(previous, entry)) {
      drop(sessionId)
      return
    }
    for (const [token, held] of heldEntries()) {
      if (activeOn.get(token) === sessionId && !sameChat(held, entry)) release(token)
    }
    const binding = Object.hasOwn(entry, 'binding') ? entry.binding : bindingOf(connection(connId), chatKey)
    const ready = entry.ready ?? previous?.ready
    origins.set(sessionId, { connId, chatKey, senderId, binding, ready })
  }

  function claimChat(conn, chat, senderId) {
    const binding = bindingOf(conn, chat.key)
    const id = binding?.slice(binding.indexOf(':') + 1)
    const sessionId = binding?.startsWith('room:') ? (roomOf(id)?.sessionId ?? id) : chatOfBot(id)
    claim(sessionId, { connId: conn.id, chatKey: chat.key, senderId, binding })
  }

  function peek(sessionId, token) {
    const entry = heldOf(token)
    if (entry === undefined) return
    claim(sessionId, entry)
    if (!mixed.has(sessionId)) activeOn.set(token, sessionId)
  }

  function detach(sessionId) {
    for (const [token, active] of activeOn) if (active === sessionId) activeOn.delete(token)
  }

  function rememberRequest(requestId, conn, chatKey, senderId) {
    pruneRequests()
    requests.delete(requestId)
    if (requests.size >= MAX_PENDING) requests.delete(requests.keys().next().value)
    requests.set(requestId, { connId: conn.id, chatKey, senderId, binding: bindingOf(conn, chatKey), at: now() })
  }

  const forgetRequest = requestId => requests.delete(requestId)

  function markVia(sessionId, seq, platform) {
    if (isBotChat(sessionId) && Number.isInteger(seq)) imVia.set(sessionId, { ...imVia.get(sessionId), [seq]: platform })
  }

  function viaView() {
    for (const sessionId of imVia.keys()) if (!isBotChat(sessionId)) imVia.delete(sessionId)
    return Object.fromEntries([...imVia].map(([sessionId, seqs]) => [sessionId, { ...seqs }]))
  }

  function onMessage(sessionId, event) {
    const source = event.data?.source
    if (CONTEXT_FORMS.has(source?.form)) return
    const { imOrigin, rpcId } = source ?? {}
    const groupPost = source?.kind === SOURCE_KIND && source.role === 'post'
    const carried = typeof imOrigin === 'string'
    if (pendingReset.delete(sessionId) && !carried && !groupPost) reset(sessionId)
    if (carried) {
      prune()
      const entry = heldOf(imOrigin)
      const sameExchange = entry?.exchangeId === undefined
        || (source.kind === SOURCE_KIND && source.role === 'reply' && source.replyTo === entry.exchangeId)
      const sameBot = entry?.botId === undefined || botOfSession?.(sessionId) === entry.botId
      if (entry === undefined || !sameExchange || !sameBot) {
        drop(sessionId)
        return
      }
      const ready = release(imOrigin)
      claim(sessionId, { ...entry, ready: ready ?? entry.ready })
    } else if (typeof rpcId === 'string' && rpcId.startsWith('im:')) {
      markVia(sessionId, event.seq, rpcId.split(':')[1])
      pruneRequests()
      const entry = requests.get(rpcId)
      forgetRequest(rpcId)
      if (entry === undefined) drop(sessionId)
      else claim(sessionId, entry)
    } else if (source?.kind === REPLY_KIND || !groupPost) {
      drop(sessionId)
    }
  }

  function onEvent(sessionId, event) {
    switch (event.type) {
      case 'turn/start': {
        const room = roomOf(sessionId)
        if (room === undefined) reset(sessionId)
        // The first message tells whether an idle group's relay is a late member result.
        else if (!roomWorking(room.id)) pendingReset.add(sessionId)
        break
      }
      case 'user/message':
        onMessage(sessionId, event)
        break
      case 'turn/end':
        if (roomOf(sessionId) === undefined) {
          reset(sessionId)
          detach(sessionId)
        } else if (pendingReset.delete(sessionId)) {
          reset(sessionId)
        }
        break
    }
  }

  function clear() {
    origins.clear()
    mixed.clear()
    pendingReset.clear()
    requests.clear()
    resumedOrigins.clear()
    activeOn.clear()
    imVia.clear()
  }

  return Object.freeze({ of, deliveryOf, claim, claimChat, drop, reset, hold, peek, release, detach, carry, matchesCarry, prune, onEvent, viaView, rememberRequest, forgetRequest, clear })
}
