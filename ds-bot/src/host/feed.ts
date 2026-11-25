import { ROUTE } from './constants.ts'

export const FEED_ROUTE = `${ROUTE}/feed`
const KEEPALIVE_MS = 20_000
const LIVE_DELAY_MS = 150
const MAX_QUEUED = 512

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  const clients = new Set()
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try { controller.enqueue(chunk) } catch { clients.delete(controller) }
  }
  const publish = (event, data) => {
    for (const tap of taps) {
      try { tap(event, data) } catch {}
    }
    if (clients.size === 0) return
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients) send(controller, chunk)
  }

  const feedHello = () => ({ revision: state.revision, ...(rt.noticeCursor ? { api: rt.apiVersion, ...rt.noticeCursor() } : {}) })

  const taps = new Set<(event: any, data: any) => void>()
  rt.feedTap = (listener) => { taps.add(listener); return () => taps.delete(listener) }
  rt.subscribeFeed = (listener) => {
    const untap = rt.feedTap(listener)
    try { listener('hello', feedHello()) } catch {}
    return untap
  }
  const listening = () => clients.size > 0 || taps.size > 0
  const offSaved = rt.onSaved(() => {
    if (listening()) publish('revision', { revision: state.revision })
  })
  rt.publishFeed = (event, data) => {
    if (listening()) publish(event, data)
  }

  let liveTimer
  const live = () => {
    if (!listening() || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if (!listening()) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    for (const item of rt.displayItems(session.id, [event])) publish('message', { botId, sessionId: session.id, item })
    if (event.type === 'tool/call') live()
  })

  const writing = new Map()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (!listening() || botId === undefined || (state.exchangeTurns[agent.id] ?? []).includes(frame.turn)) return
      writing.set(frame.attemptId, { botId, sessionId: agent.id })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const target = writing.get(frame.attemptId)
    if (target === undefined) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') publish('stream', { ...target, attemptId: frame.attemptId, text: frame.chunk.text })
    else if (frame.type === 'end') {
      writing.delete(frame.attemptId)
      publish('stream', { ...target, attemptId: frame.attemptId, phase: 'end' })
    }
  })

  // A Request built on a caller's signal only follows it while the Request is reachable;
  // once collected, its abort never fires and the feed stays open. Each open feed keeps
  // its Request until it leaves.
  const requests = new Map()
  const leave = (controller) => {
    clients.delete(controller)
    requests.delete(controller)
    if (!listening()) writing.clear()
    try { controller.close() } catch {}
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let controller
      const body = new ReadableStream({
        start(own) {
          controller = own
          clients.add(own)
          send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify(feedHello())}\n\n`))
        },
        cancel() { leave(controller) },
      })
      requests.set(controller, request)
      request.signal.addEventListener('abort', () => leave(controller), { once: true })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    const keepalive = setInterval(() => {
      if (clients.size > 0) for (const controller of clients) send(controller, encoder.encode(': keepalive\n\n'))
    }, KEEPALIVE_MS)
    keepalive.unref?.()
    return () => {
      clearInterval(keepalive)
      clearTimeout(liveTimer)
      offSaved()
      for (const controller of clients) leave(controller)
    }
  }, 'ds-bot: live feed')
}
