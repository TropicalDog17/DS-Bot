import { basename } from 'node:path'

export const RETRY_MS = 5_000
export const RETRY_MAX_MS = 30_000
export const SEND_ATTEMPTS = 4

export interface ImChat {
  key: string
  kind: string
  title?: string
}

export interface ImStatusEntry {
  state: string
  error?: string
  at: number
}

export interface ImFilePayload {
  path: string
  label: string
  caption?: string
}

export interface ImSendJob {
  chat: ImChat
  text?: string
  buttons?: unknown
  file?: ImFilePayload
  canSend?: () => boolean | Promise<boolean>
  after?: (sent: unknown) => void
  onDrop?: () => void | Promise<void>
}

export interface ImSendHandle {
  send(chat: ImChat, job: ImSendJob | { text: string }): Promise<unknown>
  sendFile?: (chat: ImChat, payload: { name: string; data: Buffer; caption?: string }) => Promise<unknown>
  fileLimit?: number
}

export interface ImOutboxDeps {
  isLive(connId: string): boolean
  isStopped(): boolean
  redact(text: string): string
  warn(template: string, ...args: unknown[]): void
  readFile(path: string, limit: number): Promise<Buffer | undefined>
  unavailableFileText(name: string): string
}

interface QueuedJob extends ImSendJob {
  attempts: number
}

interface PendingSend {
  firstRetained: QueuedJob | undefined
  promise: Promise<void>
  resolve: () => void
  waiter?: { lane: OutboxLane }
}

interface ChatQueue {
  jobs: QueuedJob[]
  draining: boolean
  sending: boolean
  retry?: ReturnType<typeof setTimeout>
  stoppedSend?: PendingSend
  firstRetained?: QueuedJob
}

interface OutboxLane {
  handle?: ImSendHandle
  queues: Map<string, ChatQueue>
  stopped: boolean
}

export type OutboxToken = OutboxLane

export interface ImOutbox {
  open(connId: string): OutboxToken
  ready(connId: string, token: OutboxToken, handle: ImSendHandle): void
  abortOpen(connId: string, token: OutboxToken): Promise<void>
  detach(connId: string, options: { dropOnly: boolean }): Promise<void>
  enqueue(connId: string, chatKey: string, job: ImSendJob): void
  retry(connId: string): void
  remove(connId: string): void
  statusOf(connId: string, adapterStatus: ImStatusEntry | undefined): ImStatusEntry | undefined
  statusIds(): string[]
}

interface SendErrorLike {
  permanent?: unknown
  status?: unknown
  unknown?: unknown
  stopped?: unknown
  retryAfter?: unknown
  message?: unknown
}

const failClass = (error: unknown): 'permanent' | 'drop' | 'retry' => {
  const err = (error !== null && typeof error === 'object' ? error : undefined) as SendErrorLike | undefined
  if (err?.permanent === true || (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429)) {
    return 'permanent'
  }
  if (err?.unknown === true || err?.stopped === true) return 'drop'
  return 'retry'
}

const failMessage = (error: unknown): string => {
  const message = error !== null && typeof error === 'object' && 'message' in error
    ? (error as SendErrorLike).message
    : undefined
  return String(message ?? error).slice(0, 300)
}

const createQueue = (): ChatQueue => ({ jobs: [], draining: false, sending: false })

export function createImOutbox(deps: ImOutboxDeps): ImOutbox {
  const lanes = new Map<string, OutboxLane>()
  const sendStatuses = new Map<string, Map<string, ImStatusEntry>>()
  const failedSends = new Map<string, Map<string, QueuedJob[]>>()
  const pendingSends = new Map<string, Map<string, PendingSend>>()

  const setPendingSend = (connId: string, chatKey: string, entry: PendingSend): void => {
    let chats = pendingSends.get(connId)
    if (chats === undefined) pendingSends.set(connId, chats = new Map())
    chats.set(chatKey, entry)
  }

  const clearPendingSend = (connId: string, chatKey: string, entry: PendingSend | undefined): void => {
    if (entry === undefined) return
    const chats = pendingSends.get(connId)
    if (chats?.get(chatKey) === entry) {
      chats.delete(chatKey)
      if (chats.size === 0) pendingSends.delete(connId)
    }
    entry.resolve()
  }

  const failedFor = (connId: string, chatKey: string): QueuedJob[] => {
    let chats = failedSends.get(connId)
    if (chats === undefined) failedSends.set(connId, chats = new Map())
    let jobs = chats.get(chatKey)
    if (jobs === undefined) chats.set(chatKey, jobs = [])
    return jobs
  }

  const setSendStatus = (connId: string, chatKey: string, next: { state: string; error?: string } | undefined): void => {
    if (next === undefined) {
      const byChat = sendStatuses.get(connId)
      if (byChat === undefined) return
      byChat.delete(chatKey)
      if (byChat.size === 0) sendStatuses.delete(connId)
      return
    }
    let byChat = sendStatuses.get(connId)
    if (byChat === undefined) sendStatuses.set(connId, byChat = new Map())
    const error = typeof next.error === 'string' && next.error !== '' ? deps.redact(next.error) : next.error
    byChat.set(chatKey, { ...next, ...(error === undefined ? {} : { error }), at: Date.now() })
  }

  const retainFailed = (connId: string, chatKey: string, job: QueuedJob, errorText: string, insertBefore?: QueuedJob): void => {
    const list = failedFor(connId, chatKey)
    const idx = insertBefore !== undefined ? list.indexOf(insertBefore) : -1
    if (idx !== -1) list.splice(idx, 0, job)
    else list.push(job)
    setSendStatus(connId, chatKey, { state: 'error', error: errorText })
  }

  const clearSettledSendStatus = (connId: string, chatKey: string, lane: OutboxLane, settled: PendingSend | undefined): void => {
    if (!deps.isLive(connId) || (failedSends.get(connId)?.get(chatKey)?.length ?? 0) > 0) return
    const current = lanes.get(connId)
    const activeDone = !lane.stopped && current === lane
    const waiterDone = settled?.waiter !== undefined
      && current === settled.waiter.lane
      && (current.queues.get(chatKey)?.jobs.length ?? 0) === 0
    if (activeDone || waiterDone) setSendStatus(connId, chatKey, undefined)
  }

  const sendFile = async (handle: ImSendHandle, job: QueuedJob): Promise<unknown> => {
    const file = job.file!
    const name = basename(file.path)
    const data = typeof handle.sendFile === 'function' ? await deps.readFile(file.path, handle.fileLimit ?? 0) : undefined
    if (data === undefined) return handle.send(job.chat, { text: file.label + deps.unavailableFileText(name) })
    return handle.sendFile!(job.chat, { name, data, caption: file.caption })
  }

  const drain = async (connId: string, chatKey: string): Promise<void> => {
    const lane = lanes.get(connId)
    const queue = lane?.queues.get(chatKey)
    if (lane?.handle === undefined || queue === undefined || queue.draining) return
    clearTimeout(queue.retry)
    queue.retry = undefined
    queue.draining = true
    try {
      while (!lane.stopped && queue.jobs.length > 0) {
        const prior = pendingSends.get(connId)?.get(chatKey)
        if (prior !== undefined) {
          await prior.promise
          continue
        }
        const job = queue.jobs[0]
        if (job.canSend !== undefined) {
          const allowed = await job.canSend()
          if (lane.stopped) break
          if (!allowed) {
            queue.jobs.shift()
            await Promise.resolve(job.onDrop?.()).catch(() => {})
            continue
          }
        }
        queue.sending = true
        let sent: unknown
        try {
          sent = job.file === undefined ? await lane.handle.send(job.chat, job) : await sendFile(lane.handle, job)
        } catch (error) {
          queue.sending = false
          const settled = queue.stoppedSend
          queue.stoppedSend = undefined
          const how = failClass(error)
          if (lane.stopped || !deps.isLive(connId)) {
            queue.jobs.shift()
            const waiter = settled?.waiter
            const replay = waiter !== undefined && !waiter.lane.stopped && lanes.get(connId) === waiter.lane ? waiter : undefined
            if (!deps.isLive(connId) || deps.isStopped() || how === 'drop') {
              await Promise.resolve(job.onDrop?.()).catch(() => {})
              clearSettledSendStatus(connId, chatKey, lane, settled)
              clearPendingSend(connId, chatKey, settled)
            } else if (replay !== undefined) {
              let nextQueue = replay.lane.queues.get(chatKey)
              if (nextQueue === undefined) replay.lane.queues.set(chatKey, nextQueue = createQueue())
              job.attempts = 0
              nextQueue.jobs.unshift(job)
              clearPendingSend(connId, chatKey, settled)
              if (!nextQueue.draining) void drain(connId, chatKey)
            } else {
              retainFailed(connId, chatKey, job, failMessage(error), settled?.firstRetained ?? queue.firstRetained)
              clearPendingSend(connId, chatKey, settled)
            }
            break
          }
          if (how === 'retry') {
            job.attempts += 1
            if (job.attempts < SEND_ATTEMPTS) {
              const backoff = Math.min(RETRY_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS)
              const retryAfter = Number((error as SendErrorLike | undefined)?.retryAfter)
              const asked = retryAfter > 0 ? Math.min(retryAfter * 1000, RETRY_MAX_MS) : backoff
              setSendStatus(connId, chatKey, { state: 'retrying', error: failMessage(error) })
              queue.retry = setTimeout(() => { void drain(connId, chatKey) }, asked)
              queue.retry.unref?.()
              return
            }
            queue.jobs.shift()
            retainFailed(connId, chatKey, job, `Send failed after ${job.attempts} attempts: ${failMessage(error)}`)
            deps.warn('ds-bot: im send to %s failed after %d attempts: %s', chatKey, job.attempts, failMessage(error))
            continue
          }
          queue.jobs.shift()
          if (how === 'permanent') {
            retainFailed(connId, chatKey, job, failMessage(error))
            deps.warn('ds-bot: im send to %s failed: %s', chatKey, failMessage(error))
          } else {
            await Promise.resolve(job.onDrop?.()).catch(() => {})
            clearSettledSendStatus(connId, chatKey, lane, undefined)
          }
          continue
        }
        queue.sending = false
        queue.jobs.shift()
        const settled = queue.stoppedSend
        queue.stoppedSend = undefined
        if (deps.isLive(connId)) job.after?.(sent)
        clearSettledSendStatus(connId, chatKey, lane, settled)
        clearPendingSend(connId, chatKey, settled)
        if (lane.stopped || lanes.get(connId) !== lane) break
      }
    } finally {
      queue.sending = false
      queue.draining = false
    }
  }

  function open(connId: string): OutboxToken {
    const lane: OutboxLane = { handle: undefined, queues: new Map(), stopped: false }
    lanes.set(connId, lane)
    return lane
  }

  function ready(connId: string, token: OutboxToken, handle: ImSendHandle): void {
    if (lanes.get(connId) !== token || token.stopped) return
    token.handle = handle
    for (const chatKey of token.queues.keys()) void drain(connId, chatKey)
  }

  async function abortOpen(connId: string, token: OutboxToken): Promise<void> {
    if (lanes.get(connId) !== token) return
    lanes.delete(connId)
    token.stopped = true
    const dropped: Promise<unknown>[] = []
    for (const queue of token.queues.values()) {
      clearTimeout(queue.retry)
      queue.retry = undefined
      for (const job of queue.jobs.splice(0)) dropped.push(Promise.resolve(job.onDrop?.()).catch(() => {}))
    }
    await Promise.all(dropped)
  }

  function enqueue(connId: string, chatKey: string, job: ImSendJob): void {
    const lane = lanes.get(connId)
    if (lane === undefined) {
      void Promise.resolve(job.onDrop?.()).catch(() => {})
      return
    }
    let queue = lane.queues.get(chatKey)
    if (queue === undefined) lane.queues.set(chatKey, queue = createQueue())
    const queued: QueuedJob = { ...job, attempts: 0 }
    queue.jobs.push(queued)
    if (!queue.draining && queue.jobs.length === 1) void drain(connId, chatKey)
  }

  async function detach(connId: string, { dropOnly }: { dropOnly: boolean }): Promise<void> {
    const lane = lanes.get(connId)
    lanes.delete(connId)
    if (lane === undefined) {
      sendStatuses.delete(connId)
      return
    }
    lane.stopped = true
    if (dropOnly) {
      sendStatuses.delete(connId)
    } else {
      const failed = failedSends.get(connId)
      const byChat = sendStatuses.get(connId)
      if (byChat !== undefined) {
        for (const chatKey of byChat.keys()) {
          if ((failed?.get(chatKey)?.length ?? 0) === 0) byChat.delete(chatKey)
        }
        if (byChat.size === 0) sendStatuses.delete(connId)
      }
    }
    const dropped: Promise<unknown>[] = []
    for (const [chatKey, queue] of lane.queues) {
      clearTimeout(queue.retry)
      queue.retry = undefined
      const rest = queue.jobs.splice(queue.sending ? 1 : 0)
      const pending = pendingSends.get(connId)?.get(chatKey)
      if (!dropOnly && queue.sending && queue.stoppedSend === undefined) {
        let resolve!: () => void
        const promise = new Promise<void>((done) => { resolve = done })
        queue.stoppedSend = { firstRetained: rest[0], promise, resolve }
        setPendingSend(connId, chatKey, queue.stoppedSend)
      }
      if (rest.length === 0) continue
      if (dropOnly) {
        for (const job of rest) dropped.push(Promise.resolve(job.onDrop?.()).catch(() => {}))
        continue
      }
      const prevError = sendStatuses.get(connId)?.get(chatKey)?.error
      queue.firstRetained = rest[0]
      if (pending !== undefined) pending.firstRetained ??= rest[0]
      failedFor(connId, chatKey).push(...rest)
      setSendStatus(connId, chatKey, { state: 'error', error: prevError || 'Stopped before delivery' })
    }
    await Promise.all(dropped)
  }

  function retry(connId: string): void {
    const lane = lanes.get(connId)
    if (lane === undefined) return
    const chats = failedSends.get(connId)
    failedSends.delete(connId)
    for (const [chatKey, pending] of pendingSends.get(connId) ?? []) {
      pending.firstRetained = undefined
      pending.waiter = { lane }
      setSendStatus(connId, chatKey, { state: 'retrying' })
    }
    for (const [chatKey, jobs] of chats ?? []) {
      setSendStatus(connId, chatKey, { state: 'retrying' })
      for (const job of jobs) enqueue(connId, chatKey, job)
    }
    for (const [chatKey, queue] of lane.queues) {
      if (queue.retry === undefined || queue.draining || queue.jobs.length === 0) continue
      clearTimeout(queue.retry)
      queue.retry = undefined
      queue.jobs[0].attempts = 0
      setSendStatus(connId, chatKey, { state: 'retrying' })
      void drain(connId, chatKey)
    }
  }

  function remove(connId: string): void {
    failedSends.delete(connId)
    sendStatuses.delete(connId)
    for (const entry of pendingSends.get(connId)?.values() ?? []) entry.resolve()
    pendingSends.delete(connId)
  }

  function statusOf(connId: string, adapterStatus: ImStatusEntry | undefined): ImStatusEntry | undefined {
    if (adapterStatus?.state === 'error' || adapterStatus?.state === 'off') return adapterStatus
    const byChat = sendStatuses.get(connId)
    if (byChat !== undefined && byChat.size > 0) {
      let picked: ImStatusEntry | undefined
      for (const entry of byChat.values()) {
        if (picked === undefined || (picked.state !== 'error' && entry.state === 'error') || (picked.state === entry.state && entry.at > picked.at)) {
          picked = entry
        }
      }
      if (picked !== undefined && (picked.state === 'error' || adapterStatus === undefined || adapterStatus.state === 'ready' || adapterStatus.state === 'connecting')) {
        return picked
      }
    }
    return adapterStatus
  }

  const statusIds = (): string[] => [...sendStatuses.keys()]

  return { open, ready, abortOpen, detach, enqueue, retry, remove, statusOf, statusIds }
}
