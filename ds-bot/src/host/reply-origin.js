import { randomUUID } from 'node:crypto'
import { REPLY_KIND, SOURCE_KIND } from './constants.js'

// DSH context informs a turn without asking anything.
const CONTEXT_FORMS = new Set(['snapshot', 'catalog', 'instructions', 'notice'])
const MAX_TOKENS = 256

// An IM request lives until its message is admitted. A Bot's claim lasts until
// its turn ends or another source joins it. A group's relay turn can end before
// its members finish, so the group keeps its claim for their posts. Routes live
// only in this process, even when a token is saved with pending work.
export function createReplyOrigin({
  now = Date.now, connections, runners, paired, bindingOf, chatOfBot,
  roomOf = () => undefined, roomWorking = () => false,
  isBotChat = () => true, sessionExists = () => true,
}) {
  const origins = new Map()
  const mixed = new Set()
  const pendingReset = new Set()
  const requests = new Map()
  const resumedOrigins = new Map()
  const imVia = new Map()

  const connection = id => Object.values(connections()).find(conn => conn.id === id)
  const sameChat = (a, b) => a.connId === b.connId && a.chatKey === b.chatKey && a.senderId === b.senderId

  function resolve(entry) {
    if (entry === undefined) return undefined
    const conn = connection(entry.connId)
    if (conn === undefined || !runners.has(conn.id)) return undefined
    if (entry.senderId !== undefined && !paired(conn, entry.senderId)) return undefined
    const chat = conn.chats?.[entry.chatKey]
    if (chat === undefined || entry.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) return undefined
    return { conn, chatKey: entry.chatKey, chat }
  }

  const of = sessionId => resolve(origins.get(sessionId))
  const release = token => resumedOrigins.delete(token)

  function prune() {
    for (const [token, entry] of resumedOrigins) {
      if (entry.issuedBy !== undefined && !sessionExists(entry.issuedBy)) release(token)
    }
  }

  function holdToken(sessionId, dispatch) {
    const entry = origins.get(sessionId)
    if (entry === undefined || (dispatch && resolve(entry) === undefined)) return undefined
    prune()
    if (resumedOrigins.size >= MAX_TOKENS) release(resumedOrigins.keys().next().value)
    const token = randomUUID()
    resumedOrigins.set(token, { ...entry, activeOn: sessionId, ...(dispatch ? { issuedBy: sessionId } : {}) })
    return token
  }

  const hold = sessionId => holdToken(sessionId, false)
  const carry = sessionId => holdToken(sessionId, true)

  function matchesCarry(sessionId, token) {
    if (token === undefined) return of(sessionId) === undefined
    const entry = origins.get(sessionId)
    const earlier = resumedOrigins.get(token)
    return earlier !== undefined && sessionExists(earlier.issuedBy) && resolve(entry) !== undefined
      && sameChat(earlier, entry) && earlier.binding === entry.binding
  }

  function drop(sessionId) {
    origins.delete(sessionId)
    mixed.add(sessionId)
    for (const [token, held] of resumedOrigins) if (held.activeOn === sessionId) release(token)
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
    for (const [token, held] of resumedOrigins) {
      if (held.activeOn === sessionId && !sameChat(held, entry)) release(token)
    }
    const binding = Object.hasOwn(entry, 'binding') ? entry.binding : bindingOf(connection(connId), chatKey)
    origins.set(sessionId, { connId, chatKey, senderId, binding })
  }

  function claimChat(conn, chat, senderId) {
    const binding = bindingOf(conn, chat.key)
    const id = binding?.slice(binding.indexOf(':') + 1)
    const sessionId = binding?.startsWith('room:') ? (roomOf(id)?.sessionId ?? id) : chatOfBot(id)
    claim(sessionId, { connId: conn.id, chatKey: chat.key, senderId, binding })
  }

  function peek(sessionId, token) {
    const entry = resumedOrigins.get(token)
    if (entry === undefined) return
    claim(sessionId, entry)
    if (!mixed.has(sessionId)) entry.activeOn = sessionId
  }

  function detach(sessionId) {
    for (const held of resumedOrigins.values()) if (held.activeOn === sessionId) held.activeOn = undefined
  }

  function rememberRequest(requestId, conn, chatKey, senderId) {
    // Capture the binding on arrival, before a queued message is admitted.
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
      const entry = resumedOrigins.get(imOrigin)
      release(imOrigin)
      if (entry === undefined) drop(sessionId)
      else claim(sessionId, entry)
    } else if (typeof rpcId === 'string' && rpcId.startsWith('im:')) {
      markVia(sessionId, event.seq, rpcId.split(':')[1])
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
    imVia.clear()
  }

  return Object.freeze({ of, claim, claimChat, drop, reset, hold, peek, release, detach, carry, matchesCarry, prune, onEvent, viaView, rememberRequest, forgetRequest, clear })
}
