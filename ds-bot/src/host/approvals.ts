import { randomUUID } from 'node:crypto'
import { APPROVAL_REMIND_MS } from './constants.ts'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }

export function install(rt) {
  const { ctx } = rt
  const pending = new Map()
  const approvalListeners = new Set<(...args: any[]) => void>()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }

  const askerOf = (entry) => {
    if (entry.roomId !== undefined) return undefined
    const info = rt.live?.get(entry.sessionId)?.info
    if (info === undefined) return undefined
    const asker = info.role === 'request' || info.role === 'stopped' ? info.senderSessionId : rt.state?.works?.[rt.workOf?.(info)]?.from
    return asker !== entry.botId && rt.botOf(asker) !== undefined ? asker : undefined
  }
  const noticeText = (entry, waited) => {
    const name = rt.botOf(entry.botId)?.name ?? 'A Bot'
    const room = entry.roomId === undefined ? undefined : rt.roomOf(entry.roomId)
    const where = room !== undefined ? `the group chat "${room.name}"` : `${name}'s own chat`
    const reason = entry.reason === '' ? '' : ` (${entry.reason.slice(0, 160)})`
    const since = waited ? `has waited ${Math.max(1, Math.round((Date.now() - entry.at) / 60_000))} min` : 'is waiting'
    return `${name} ${since} for the user's approval to run ${entry.tool || 'a tool'}${reason}. The user answers it in ${where}. Tell the user in this chat in a line or two. Do not message ${name} about it: only the user can answer it.`
  }
  const notices = new Map()
  const tell = (entry, toId, waited) => {
    const notice = notices.get(entry.id)
    if (notice === undefined || notice.told.has(toId) || !pending.has(entry.id)) return
    notice.told.add(toId)
    void rt.dispatch.sendNotice({ fromId: entry.botId, toId, role: 'approval', text: noticeText(entry, waited) })
      .catch(error => rt.warn('ds-bot: approval notice to %s failed: %s', toId, error))
  }
  const remind = (id) => {
    const entry = pending.get(id)
    if (entry === undefined) return
    for (const mainId of rt.state?.mainBotIds ?? []) {
      if (mainId !== entry.botId && rt.botOf(mainId) !== undefined) tell(entry, mainId, true)
    }
  }
  function noticeOpened(entry) {
    const timer = setTimeout(() => remind(entry.id), APPROVAL_REMIND_MS)
    timer.unref?.()
    notices.set(entry.id, { told: new Set(), timer })
    queueMicrotask(() => {
      const asker = askerOf(entry)
      if (asker !== undefined) tell(entry, asker, false)
    })
  }
  const noticeSettled = (id) => {
    clearTimeout(notices.get(id)?.timer)
    notices.delete(id)
  }
  ctx.effect?.(() => () => {
    for (const notice of notices.values()) clearTimeout(notice.timer)
    notices.clear()
  }, 'ds-bot: approval notices')

  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    const id = randomUUID()
    const entry: Record<string, any> = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
    }
    pending.set(id, entry)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    rt.approvalWaiting?.(entry)
    emit('open', { ...entry, answerable: true })
    noticeOpened(entry)
    const settle = (outcome) => {
      if (!pending.has(id)) return false
      pending.delete(id)
      noticeSettled(id)
      rt.noteApproval?.(sessionId, undefined)
      emit('settled', { id, outcome })
      return true
    }
    if (owner === undefined) {
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome) => {
          if (!settle(outcome)) return
          resolve(outcome)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
        }
        entry.answer = complete
        if (original?.aborted) entry.answer('cancelled')
        else original?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome)
          },
          (error) => {
            if (!settle('cancelled')) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!settle(outcome)) return
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(outcome)
  }

  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, onApproval })
}
