// Dispatch: the single deep module that delivers every message into a Bot or group
// Session — Bot-to-Bot Requests (with idempotency, unread-inbox coalescing, work/origin
// lifecycle, and long-text attachments), Bot Replies, group turns, system/companion
// notices, user prompts, and restart resends through an explicit outbox seam.
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  HISTORY_TIMEOUT_MS,
  LONG_HEAD,
  MESSAGE_INLINE_MAX,
  READ_LINE_MAX,
  SOURCE_KIND,
  TEXT_KEPT,
  TEXT_SHOW_MAX,
} from './constants.js'
import { headOf, textOf } from './text.js'
import { reach, threadCurrentOfPart } from './threads.js'

// A request name this long is a mistake, not an identity.
export const NAME_MAX = 200

const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])

export type DeliveryRole =
  | 'request'
  | 'reply'
  | 'stopped'
  | 'room'
  | 'report'
  | 'kickoff'
  | 'continue'
  | 'update'
  | 'secret'
  | 'card'
  | 'wake'
  | 'approval'
  | 'resume'
  | 'retry'
  | 'connector'
  | 'mail'

export interface BotRecord {
  id: string
  name: string
  sessionId?: string
  segments?: Array<{ sessionId: string }>
  openParts?: Array<{ sessionId: string; segments?: Array<{ sessionId: string }>; card?: string }>
  currentCard?: string
}

export interface RoomRecord {
  id: string
  name: string
  members?: string[]
  sessionId?: string
  sessions?: Record<string, string>
}

export interface WorkRecord {
  from?: string
  to?: string
  parent?: string
  fromPart?: string
  imOrigin?: string
}

export interface RequestReceiptRecord {
  fingerprint: string
  outcome: 'pending' | 'delivered' | 'uncertain'
  at: number
  run: string
  receipt?: string
}

export interface ExchangeRecord {
  id: string
  from?: string
  to?: string
  text?: string
  role?: string
  time?: number
  replyTo?: string
  audience?: 'user'
  roomId?: string
  length?: number
  files?: unknown[]
  sessionId?: string
  ledger?: boolean
  delivered?: boolean
  event?: string
}

export interface DispatchState {
  bots: Record<string, BotRecord>
  rooms: Record<string, RoomRecord>
  exchanges: ExchangeRecord[]
  works?: Record<string, WorkRecord>
  requests?: Record<string, RequestReceiptRecord>
}

export interface InboxMessage {
  id?: string
  content?: Array<{ type?: string; text?: string; attachment?: unknown }>
  source?: {
    kind?: string
    role?: string
    exchangeId?: string
    senderSessionId?: string
    senderPart?: string
    audience?: string
    deferred?: boolean
    resumed?: boolean
  }
}

export interface ResolvedAgent {
  session: unknown
  steer: (message: unknown) => void
  followup: (message: unknown) => void
  inbox?: {
    nextStep?: InboxMessage[]
    nextTurn?: InboxMessage[]
    remove?: (id: string | undefined) => boolean
  }
}

export interface SavedDelivery {
  fromId?: string
  fromName?: string
  toId: string
  sessionId?: string
  text: string
  role?: DeliveryRole | string
  replyTo?: string
  roomId?: string
  audience?: 'user'
  note?: string
  exchangeId: string
  steer?: boolean
  deferred?: boolean
  resumed?: boolean
  retried?: boolean
  resent?: boolean
  merged?: boolean
  abandoned?: boolean
  recordExchange?: boolean
  askedBy?: string
  fromRoomId?: string
  fromPart?: string
  images?: unknown[]
  files?: unknown[]
  length?: number
  work?: string
  imOrigin?: string
  requests?: string[]
}

export interface DispatchOutbox {
  queue: (sessionId: string, args: SavedDelivery) => void
  forget: (exchangeId: string) => void
}

export interface AttachedMessage {
  text: string
  files: unknown[]
  length?: number
}

export type AdmissionStatus = 'sent' | 'replay' | 'conflict' | 'uncertain' | 'expired' | 'readonly'

export interface AdmissionOutcome {
  status: AdmissionStatus
  receipt?: string
}

export interface BotRequestReceiptContext {
  exchangeId: string
  joined: boolean
  working: boolean
  steered: boolean
}

export interface BotRequestInput {
  fromId: string
  fromPart?: string
  fromSessionId?: string
  toId: string
  rawMessage: string
  text: string
  toUser?: boolean
  when?: 'now' | 'queue'
  requestName?: string
  work?: string
  formatReceipt: (info: BotRequestReceiptContext) => string
}

export type BotRequestOutcome =
  | { status: 'sent'; exchangeId: string; joined: boolean; working: boolean; steered: boolean; receipt: string }
  | { status: 'replay'; receipt: string }
  | { status: 'conflict' | 'uncertain' | 'expired' | 'readonly' | 'too_long' }

export interface GroupRequestInput {
  caller: string
  roomId: string
  name?: string
  payload: Record<string, unknown>
}

export interface ReplyInput {
  fromId?: string
  fromName?: string
  toId: string
  sessionId?: string
  text: string
  role?: 'reply' | 'report' | 'stopped' | 'request' | 'room' | 'retry' | string
  replyTo?: string
  roomId?: string
  audience?: 'user'
  note?: string
  exchangeId?: string
  deferred?: boolean
  resumed?: boolean
  retried?: boolean
  abandoned?: boolean
  recordExchange?: boolean
  askedBy?: string
  fromRoomId?: string
  fromPart?: string
  files?: unknown[]
  length?: number
  work?: string
  imOrigin?: string
}

export interface GroupTurnInput {
  toId: string
  sessionId: string
  roomId: string
  text: string
  note?: string
  exchangeId?: string
  images?: unknown[]
  files?: unknown[]
  requests?: string[]
  steer?: boolean
  askedBy?: string
  resumed?: boolean
}

export interface NoticeInput {
  fromId?: string
  fromName?: string
  toId: string
  sessionId?: string
  role?: DeliveryRole | string
  roomId?: string
  note?: string
  text: string
  steer?: boolean
  resumed?: boolean
  work?: string
  exchangeId?: string
}

export interface UserPromptInput {
  sessionId: string
  content: unknown[]
  requestId?: string
  steer?: boolean
}

export interface DispatchDeps {
  state: DispatchState
  ctx: {
    sessionController: {
      resolveAgent: (sessionId: string) => Promise<{ agent: ResolvedAgent } | { error?: { message?: string; code?: string } }>
      prompt: (input: { requestId: string; sessionId: string; mode: 'steer' | 'queue'; content: unknown[] }, signal?: AbortSignal) => Promise<unknown>
    }
    sessions: { flush: (session: unknown) => Promise<unknown> }
    get?: (name: string) => {
      saveFile: (input: { data: Uint8Array; name: string }) => Promise<unknown>
      readFileStream: (file: unknown, signal?: AbortSignal) => AsyncIterable<Uint8Array>
    } | undefined
  }
  ledger: {
    importer: (prefix: string, fn: (book: string) => ExchangeRecord[]) => void
    records: (book: string) => ExchangeRecord[]
    append: (book: string, record: ExchangeRecord) => void
    written: (book: string) => Promise<unknown>
  }
  botOf: (id: string | undefined) => BotRecord | undefined
  roomOf: (id: string | undefined) => RoomRecord | undefined
  chatOf: (botId: string) => string
  sessionOfRoom: (room: RoomRecord | undefined) => string | undefined
  pastOwnerOf: (sessionId: string) => { botId?: string; roomId?: string } | undefined
  own: <T>(obj: Record<string, T> | undefined, key: string) => T | undefined
  isRunning: (sessionId: string) => boolean
  hideBotUnusedTools: (agent: ResolvedAgent) => void
  ensureCapabilities: (sessionId: string) => Promise<unknown>
  eventsBackwards: (sessionId: string, signal?: AbortSignal) => AsyncIterable<{ type?: string; data?: { source?: { exchangeId?: string }; content?: unknown } }>
  openWork: (exchangeId: string, info: WorkRecord) => void
  dropWork: (exchangeId: string) => void
  sameWork: (exchangeId: string | undefined, work: string | undefined) => boolean
  carryOrigin: (sessionId: string | undefined, exchangeId: string) => string | undefined
  matchesCarry: (sessionId: string | undefined, token: string | undefined) => boolean
  readOnly: () => unknown
  save: (options?: { required?: boolean }) => Promise<unknown>
  warn: (message: string, ...args: unknown[]) => void
  now?: () => number
}

export interface Dispatch {
  attachOutbox: (outbox: DispatchOutbox | undefined) => void
  forgetDelivery: (exchangeId: string) => void
  resolveAgent: (sessionId: string) => Promise<ResolvedAgent>
  resolveOwnThread: (ref: string, past?: { botId?: string; roomId?: string }) => string | undefined
  sendBotRequest: (input: BotRequestInput) => Promise<BotRequestOutcome>
  admitGroupRequest: (input: GroupRequestInput, run: () => Promise<string>) => Promise<AdmissionOutcome>
  sendReply: (input: ReplyInput) => Promise<string>
  sendGroupTurn: (input: GroupTurnInput) => Promise<string>
  sendNotice: (input: NoticeInput) => Promise<string>
  sendUser: (input: UserPromptInput) => Promise<void>
  resend: (saved: SavedDelivery) => Promise<string>
  attachLong: (text: string, name: string) => Promise<AttachedMessage | undefined>
  fileText: (file: { name?: string }) => Promise<{ text: string; whole: boolean } | undefined>
  exchangeText: (entry: ExchangeRecord) => Promise<{ text: string; whole: boolean }>
  exchangesOf: (a: string, b: string) => ExchangeRecord[]
  exchangeOf: (id: string, a: string, b: string) => ExchangeRecord | undefined
}

interface RequestIdentity {
  key: string
  print: string
  unsent?: boolean
}

function headerFor(
  role: string | undefined,
  fromName: string,
  roomName: string | undefined,
  audience: string | undefined,
  note = 'new message',
  deferred = false,
  { resumed = false, retried = false, resent = false, abandoned = false, asker }: {
    resumed?: boolean
    retried?: boolean
    resent?: boolean
    abandoned?: boolean
    asker?: string
  } = {},
): string {
  // What came back for work another Bot gave this one says where its answer goes.
  const goesOn = asker === undefined
    ? ''
    : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
  // A wait the user gave up reads as its own thing: the other Bot never answered.
  if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
  if (deferred && role === 'reply') return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`
  if (deferred && role === 'report') return `[Group chat "${roomName}" · replies to your post · you read them during your last task; go on with the work they are for now${goesOn}]`
  if (deferred && role !== 'room') return `[Message from ${fromName} · you read it during your last task; answer it now]`
  if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
  if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
  if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
  if (resent && role === 'reply') return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`
  if (resent && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`
  if (role === 'reply') return `[Reply from ${fromName}${goesOn}]`
  if (role === 'stopped') return `[Stopped by ${fromName}]`
  if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
  if (role === 'report') return `[Group chat "${roomName}" · replies to your post${goesOn}]`
  if (role === 'kickoff') return '[Bot team setup]'
  if (role === 'continue') return '[Retry after a failed turn]'
  // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
  // the header stays neutral about who changed the profile.
  if (role === 'update') return '[Your profile was updated — follow the latest version]'
  if (role === 'secret') return '[Secret card]'
  if (role === 'card') return `[${note} · tell the user here]`
  if (role === 'wake') return `[${note}]`
  if (role === 'approval') return `[${fromName} waits for the user's approval · tell the user here]`
  if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
  return `[Message from ${fromName}]`
}

// An unread direct request from `senderId` already sitting in `agent.inbox` can absorb a
// second message sent for the same work and destination so unread requests do not pile up.
function unreadRequest(agent: ResolvedAgent, senderId: string, toUser: boolean): { message: InboxMessage; steered: boolean } | undefined {
  const queued: Array<[InboxMessage, boolean]> = [
    ...(agent.inbox?.nextStep ?? []).map((message): [InboxMessage, boolean] => [message, true]),
    ...(agent.inbox?.nextTurn ?? []).map((message): [InboxMessage, boolean] => [message, false]),
  ]
  for (const [message, steered] of queued) {
    const source = message.source
    if (
      source?.kind === SOURCE_KIND
      && source.role === 'request'
      && source.senderSessionId === senderId
      && (source.audience === 'user') === toUser
      && !source.deferred
      && !source.resumed
    ) {
      return { message, steered }
    }
  }
  return undefined
}

function bodyOf(message: InboxMessage): { text: string; files: unknown[] } {
  const content = Array.isArray(message.content) ? message.content : []
  const first = content.find(block => block?.type === 'text')?.text ?? ''
  return {
    text: first.slice(first.indexOf('\n') + 1),
    files: content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment),
  }
}

export function createDispatch(deps: DispatchDeps): Dispatch {
  const {
    state,
    ctx,
    ledger,
    botOf,
    roomOf,
    chatOf,
    sessionOfRoom,
    pastOwnerOf,
    own,
    isRunning,
    hideBotUnusedTools,
    ensureCapabilities,
    eventsBackwards,
    openWork,
    dropWork,
    sameWork,
    carryOrigin,
    matchesCarry,
    readOnly,
    save,
    warn,
    now = Date.now,
  } = deps

  let outbox: DispatchOutbox | undefined
  // This run's name: a request receipt left pending by another run has an unknown outcome.
  const run = randomUUID()
  const inflight = new Map<string, Promise<string>>()

  const receipts = (): Record<string, RequestReceiptRecord> => (state.requests ??= {})
  const print = (payload: unknown): string => createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const makeIdentity = ({ caller, context, name, payload }: { caller: string; context: string; name: string; payload: unknown }): RequestIdentity => ({
    key: `${caller}\u0000${context}\u0000${name}`,
    print: print(payload),
  })

  const verdict = (request: RequestIdentity, record: RequestReceiptRecord): AdmissionOutcome | undefined => {
    if (record.fingerprint !== request.print) return { status: 'conflict' }
    if (record.outcome === 'delivered') {
      return record.receipt === undefined ? { status: 'expired' } : { status: 'replay', receipt: record.receipt }
    }
    if (record.outcome === 'uncertain') return { status: 'uncertain' }
    return undefined
  }

  const known = async (request: RequestIdentity): Promise<AdmissionOutcome | undefined> => {
    const record = own(receipts(), request.key)
    if (record === undefined) return undefined
    const seen = verdict(request, record)
    if (seen !== undefined) return seen
    if (record.run !== run) return { status: 'uncertain' }
    const promise = inflight.get(request.key)
    if (promise === undefined) return { status: 'uncertain' }
    await promise.catch(() => {})
    const settled = own(receipts(), request.key)
    if (settled === undefined) return undefined
    return verdict(request, settled) ?? { status: 'uncertain' }
  }

  const admit = async (request: RequestIdentity, work: () => Promise<string>): Promise<AdmissionOutcome> => {
    // Check and record synchronously before the first await so concurrent calls admit once.
    const record = own(receipts(), request.key)
    if (record !== undefined) {
      const seen = verdict(request, record)
      if (seen !== undefined) return seen
      if (record.run !== run) return { status: 'uncertain' }
      const promise = inflight.get(request.key)
      if (promise === undefined) return { status: 'uncertain' }
      await promise.catch(() => {})
      if (own(receipts(), request.key) === undefined) return admit(request, work)
      return (await known(request)) ?? { status: 'uncertain' }
    }
    if (readOnly() !== undefined) return { status: 'readonly' }
    const fresh: RequestReceiptRecord = { fingerprint: request.print, outcome: 'pending', at: now(), run }
    receipts()[request.key] = fresh
    const promise = (async () => {
      try {
        await save({ required: true })
      } catch (error) {
        delete receipts()[request.key]
        warn('ds-bot: the receipt of the request was not saved: %s', error)
        throw error
      }
      try {
        const receipt = await work()
        if (request.unsent === true) {
          delete receipts()[request.key]
          try {
            await save({ required: true })
          } catch (error) {
            fresh.outcome = 'uncertain'
            fresh.at = now()
            receipts()[request.key] = fresh
            warn('ds-bot: the removal of the request receipt was not saved: %s', error)
          }
          return receipt
        }
        fresh.outcome = 'delivered'
        fresh.receipt = receipt
        fresh.at = now()
        await save().catch(() => {})
        return receipt
      } catch (error) {
        fresh.outcome = 'uncertain'
        fresh.at = now()
        await save().catch(() => {})
        throw error
      }
    })()
    inflight.set(request.key, promise)
    try {
      return { status: 'sent', receipt: await promise }
    } finally {
      inflight.delete(request.key)
    }
  }

  const resolveAgent = async (sessionId: string): Promise<ResolvedAgent> => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (!('agent' in resolved)) {
      throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    }
    hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  const pairBook = (a: string, b: string): string => `pair-${[String(a), String(b)].sort().join('-')}`
  ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))

  function pairMessages(a: string, b: string): ExchangeRecord[] {
    const written = new Map<string, ExchangeRecord>()
    const shown = new Map<string, ExchangeRecord>()
    for (const record of ledger.records(pairBook(a, b))) {
      if (record.event === 'delivered') {
        if (written.has(record.id)) shown.set(record.id, written.get(record.id)!)
      } else if (record.event === undefined) {
        written.set(record.id, record)
        if (record.delivered === true) shown.set(record.id, record)
      }
    }
    return [...shown.values()]
  }

  async function deliverRaw(input: SavedDelivery, { queueInOutbox }: { queueInOutbox: boolean }): Promise<string> {
    const {
      fromId,
      fromName: senderName,
      toId,
      sessionId,
      text,
      role,
      replyTo,
      roomId,
      audience,
      note,
      exchangeId,
      steer = false,
      deferred = false,
      resumed = false,
      retried = false,
      resent = false,
      merged = false,
      abandoned = false,
      recordExchange = true,
      askedBy,
      fromRoomId,
      fromPart,
      images = [],
      files = [],
      length,
      work,
      imOrigin,
      requests = [],
    } = input

    const queuedSessionId = sessionId ?? reach(botOf(toId)).sessionId
    if (queueInOutbox && outbox !== undefined && queuedSessionId !== undefined) {
      outbox.queue(queuedSessionId, input)
    }

    try {
      const from = botOf(fromId)
      const to = botOf(toId)
      if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
      const fromName = senderName ?? from?.name ?? 'You'
      const room = roomOf(roomId)
      const asker = work === undefined ? undefined : botOf(state.works?.[work]?.from)?.name
      // Session events reject `undefined` members, so optional fields are omitted instead.
      const source: Record<string, unknown> = {
        kind: SOURCE_KIND,
        form: 'relay',
        role,
        exchangeId,
        senderName: fromName,
        ...(work ? { work } : {}),
        ...(typeof imOrigin === 'string' ? { imOrigin } : {}),
        ...(fromId ? { senderSessionId: fromId } : {}),
        ...(fromPart ? { senderPart: fromPart } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(roomId ? { roomId } : {}),
        ...(audience === 'user' ? { audience } : {}),
        ...(deferred ? { deferred: true } : {}),
        ...(resumed ? { resumed: true } : {}),
        ...(retried ? { retried: true } : {}),
        ...(askedBy ? { askedBy } : {}),
        ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
        ...(abandoned ? { abandoned: true } : {}),
        ...(requests.length > 0 ? { requests } : {}),
      }
      const targetSessionId = sessionId ?? chatOf(toId)
      const book = fromId !== undefined && from !== undefined && recordExchange && role !== undefined && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried
        ? pairBook(fromId, toId)
        : undefined
      if (book !== undefined && (merged || !ledger.records(book).some(record => record.event === undefined && record.id === exchangeId))) {
        ledger.append(book, {
          id: exchangeId,
          from: fromId,
          to: toId,
          role,
          text,
          time: now(),
          ...(length !== undefined ? { length, files } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(audience === 'user' ? { audience } : {}),
          ...(roomId ? { roomId } : {}),
        })
        await ledger.written(book)
      }
      await ensureCapabilities(targetSessionId)
      const agent = await resolveAgent(targetSessionId)
      const message = createUserMessage({
        content: [
          { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, asker })}\n${text}` },
          ...images.map(attachment => ({ type: 'image', attachment })),
          ...files.map(attachment => ({ type: 'file', attachment })),
        ] as never,
        source: source as never,
      })
      if (steer) agent.steer(message)
      else agent.followup(message)
      await ctx.sessions.flush(agent.session)
      if (book !== undefined) {
        ledger.append(book, { event: 'delivered', id: exchangeId, sessionId: targetSessionId, time: now() })
        await ledger.written(book).catch(() => {})
      } else if (recordExchange && role !== undefined && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried) {
        const kept = headOf(text, TEXT_KEPT)
        const whole = length !== undefined ? { length, files } : kept.length < text.length ? { length: text.length, sessionId: targetSessionId } : {}
        const entry: ExchangeRecord = {
          id: exchangeId,
          from: fromId,
          to: toId,
          text: kept,
          ...whole,
          role,
          time: now(),
          ...(replyTo ? { replyTo } : {}),
          ...(audience === 'user' ? { audience } : {}),
        }
        const earlier = state.exchanges.findIndex(other => other.id === exchangeId)
        if (earlier === -1) state.exchanges.push(entry)
        else if (merged) state.exchanges[earlier] = entry
        void save().catch(() => {})
      }
      return exchangeId
    } catch (error) {
      if (queueInOutbox && botOf(toId) === undefined) outbox?.forget(exchangeId)
      throw error
    }
  }

  async function attachLong(text: string, name: string): Promise<AttachedMessage | undefined> {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

  async function fileText(file: { name?: string }): Promise<{ text: string; whole: boolean } | undefined> {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > TEXT_SHOW_MAX) return { text: headOf(text, TEXT_SHOW_MAX), whole: false }
      }
    } catch (error) {
      warn('ds-bot: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }

  async function exchangeText(entry: ExchangeRecord): Promise<{ text: string; whole: boolean }> {
    if (entry.ledger === true && (entry.files?.length ?? 0) > 0) {
      return await fileText(entry.files![0] as { name?: string }) ?? { text: headOf(entry.text ?? '', TEXT_SHOW_MAX), whole: false }
    }
    if (entry.ledger === true) return { text: headOf(entry.text ?? '', TEXT_SHOW_MAX), whole: (entry.text?.length ?? 0) <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text ?? '', whole: true }
    if ((entry.files?.length ?? 0) > 0) {
      return await fileText(entry.files![0] as { name?: string }) ?? { text: entry.text ?? '', whole: false }
    }
    try {
      for await (const event of eventsBackwards(entry.sessionId ?? chatOf(entry.to ?? ''), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      warn('ds-bot: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text ?? '', whole: false }
  }

  function resolveOwnThread(ref: string, past = pastOwnerOf(ref)): string | undefined {
    if (botOf(ref)) return chatOf(ref)
    if (past !== undefined && past.roomId === undefined && past.botId !== undefined) {
      return threadCurrentOfPart(botOf(past.botId), ref) ?? chatOf(past.botId)
    }
    return undefined
  }

  async function sendUser({ sessionId: ref, content, requestId = randomUUID(), steer = false }: UserPromptInput): Promise<void> {
    const past = pastOwnerOf(ref)
    const room = roomOf(ref)
    const sessionId = resolveOwnThread(ref, past)
      ?? (room !== undefined ? sessionOfRoom(room)
        : past !== undefined ? sessionOfRoom(roomOf(past.roomId)) : ref)
      ?? ref
    await ensureCapabilities(sessionId)
    await ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: steer ? 'steer' : 'queue',
      content,
    }, AbortSignal.timeout(30_000))
  }

  async function sendBotRequest(input: BotRequestInput): Promise<BotRequestOutcome> {
    const {
      fromId,
      fromPart,
      fromSessionId,
      toId,
      rawMessage,
      text,
      toUser = false,
      when = 'now',
      requestName = '',
      work,
      formatReceipt,
    } = input
    const sender = botOf(fromId)
    const target = botOf(toId)
    if (sender === undefined) throw new Error(`Unknown Bot ${fromId}`)
    if (target === undefined) throw new Error(`Unknown Bot ${toId}`)

    const request = requestName === '' ? undefined : makeIdentity({
      caller: fromId,
      context: 'chat',
      name: requestName,
      payload: {
        to: toId,
        message: rawMessage.replace(/\r\n?/g, '\n').trim(),
        reply_to: toUser ? 'user' : 'me',
        when: when === 'queue' ? 'queue' : 'now',
      },
    })
    if (request !== undefined) {
      const seen = await known(request)
      if (seen !== undefined) {
        if (seen.status === 'replay') return { status: 'replay', receipt: seen.receipt ?? '' }
        return { status: seen.status as 'conflict' | 'uncertain' | 'expired' | 'readonly' }
      }
    }

    let details: BotRequestReceiptContext | undefined
    let tooLongResult = false

    const execute = async (): Promise<string> => {
      const chat = chatOf(toId)
      const agent = await resolveAgent(chat)
      const earlier = unreadRequest(agent, fromId, toUser)
      const sameOrigin = (exchangeId: string | undefined): boolean => matchesCarry(fromSessionId, exchangeId === undefined ? undefined : state.works?.[exchangeId]?.imOrigin)
      const joinable = earlier !== undefined
        && (toUser || ((earlier.message.source?.senderPart ?? undefined) === fromPart && sameWork(earlier.message.source?.exchangeId, work) && sameOrigin(earlier.message.source?.exchangeId)))
      const before = joinable ? bodyOf(earlier.message) : undefined
      let long = await attachLong(before ? `${before.text}\n\n${text}` : text, `Message from ${sender.name}.txt`)
      if (long === undefined) {
        if (request !== undefined) request.unsent = true
        tooLongResult = true
        return ''
      }
      const joins = before !== undefined && (toUser || sameOrigin(earlier?.message.source?.exchangeId)) && agent.inbox?.remove?.(earlier?.message.id) === true
      if (before !== undefined && !joins) long = await attachLong(text, `Message from ${sender.name}.txt`) ?? long
      const working = isRunning(chat)
      const steer = (when !== 'queue' && !toUser) || (joins && earlier!.steered)
      const exchangeId = joins ? earlier!.message.source!.exchangeId! : randomUUID()
      const imOrigin = !joins && !toUser ? carryOrigin(fromSessionId, exchangeId) : undefined
      if (joins) outbox?.forget(exchangeId)
      else if (!toUser) {
        openWork(exchangeId, { from: fromId, to: toId, parent: work, fromPart, imOrigin })
      }
      if (imOrigin !== undefined) {
        try {
          await save({ required: true })
        } catch (error) {
          dropWork(exchangeId)
          throw error
        }
      }
      try {
        await deliverRaw({
          fromId,
          toId,
          ...(fromPart ? { fromPart } : {}),
          text: long.text,
          files: [...long.files, ...(joins ? before!.files : [])],
          length: long.length,
          role: 'request',
          steer,
          exchangeId,
          ...(joins ? { merged: true } : {}),
          ...(toUser ? { audience: 'user' as const } : {}),
        }, { queueInOutbox: true })
      } catch (error) {
        if (!joins && botOf(toId) === undefined) dropWork(exchangeId)
        throw error
      }
      details = { exchangeId, joined: joins, working, steered: steer }
      return formatReceipt(details)
    }

    if (request === undefined) {
      const receipt = await execute()
      if (tooLongResult || details === undefined) return { status: 'too_long' }
      return { status: 'sent', ...details, receipt }
    }

    const admitted = await admit(request, execute)
    if (admitted.status === 'replay') return { status: 'replay', receipt: admitted.receipt ?? '' }
    if (admitted.status !== 'sent') return { status: admitted.status }
    if (tooLongResult || details === undefined) return { status: 'too_long' }
    return { status: 'sent', ...details, receipt: admitted.receipt ?? '' }
  }

  async function admitGroupRequest(input: GroupRequestInput, work: () => Promise<string>): Promise<AdmissionOutcome> {
    const name = input.name?.trim() ?? ''
    if (name === '') return { status: 'sent', receipt: await work() }
    const request = makeIdentity({ caller: input.caller, context: `room:${input.roomId}`, name, payload: input.payload })
    const seen = await known(request)
    if (seen !== undefined) return seen
    return admit(request, work)
  }

  const sendReply = (input: ReplyInput): Promise<string> => deliverRaw({
    ...input,
    role: input.role ?? 'reply',
    exchangeId: input.exchangeId ?? randomUUID(),
  }, { queueInOutbox: true })

  const sendGroupTurn = (input: GroupTurnInput): Promise<string> => deliverRaw({
    fromId: undefined,
    toId: input.toId,
    sessionId: input.sessionId,
    role: 'room',
    roomId: input.roomId,
    exchangeId: input.exchangeId ?? randomUUID(),
    note: input.note,
    text: input.text,
    images: input.images,
    files: input.files,
    requests: input.requests,
    steer: input.steer,
    askedBy: input.askedBy,
    resumed: input.resumed,
  }, { queueInOutbox: true })

  const sendNotice = (input: NoticeInput): Promise<string> => deliverRaw({
    ...input,
    exchangeId: input.exchangeId ?? randomUUID(),
    recordExchange: false,
  }, { queueInOutbox: true })

  const resend = (saved: SavedDelivery): Promise<string> => deliverRaw({
    ...saved,
    exchangeId: saved.exchangeId ?? randomUUID(),
    steer: false,
    resent: true,
  }, { queueInOutbox: false })

  const exchangesOf = (a: string, b: string): ExchangeRecord[] => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return {
      ...rest,
      text: kept,
      ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text!.length } : {}),
    }
  })

  const exchangeOf = (id: string, a: string, b: string): ExchangeRecord | undefined => {
    const record = pairMessages(a, b).find(item => item.id === id)
    if (record === undefined) return undefined
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files && record.files.length > 0))) return record
    return { ...record, ledger: true }
  }

  return Object.freeze({
    attachOutbox(next: DispatchOutbox | undefined) { outbox = next },
    forgetDelivery(exchangeId: string) { outbox?.forget(exchangeId) },
    resolveAgent,
    resolveOwnThread,
    sendBotRequest,
    admitGroupRequest,
    sendReply,
    sendGroupTurn,
    sendNotice,
    sendUser,
    resend,
    attachLong,
    fileText,
    exchangeText,
    exchangesOf,
    exchangeOf,
  })
}

export function install(rt: Record<string, any>): void {
  const dispatch = createDispatch({
    state: rt.state,
    ctx: rt.ctx,
    ledger: rt.ledger,
    botOf: id => rt.botOf(id),
    roomOf: id => rt.roomOf(id),
    chatOf: botId => rt.chatOf(botId),
    sessionOfRoom: room => rt.sessionOfRoom(room),
    pastOwnerOf: sessionId => rt.pastOwners?.get(sessionId),
    own: (obj, key) => rt.own(obj, key),
    isRunning: sessionId => rt.live?.get(sessionId)?.turn !== undefined,
    hideBotUnusedTools: agent => rt.hideBotUnusedTools(agent),
    ensureCapabilities: sessionId => rt.ensureCapabilities(sessionId),
    eventsBackwards: (sessionId, signal) => rt.eventsBackwards(sessionId, signal),
    openWork: (exchangeId, info) => rt.openWork(exchangeId, info),
    dropWork: exchangeId => rt.dropWork(exchangeId),
    sameWork: (exchangeId, work) => rt.sameWork(exchangeId, work),
    carryOrigin: (sessionId, exchangeId) => rt.replyOrigin?.carry(sessionId, exchangeId),
    matchesCarry: (sessionId, token) => rt.replyOrigin?.matchesCarry(sessionId, token) ?? true,
    readOnly: () => rt.readOnly?.(),
    save: options => rt.save(options),
    warn: (...args) => rt.warn?.(...args),
  })
  Object.assign(rt, {
    dispatch,
    resolveAgent: dispatch.resolveAgent,
    exchangeText: dispatch.exchangeText,
    attachLong: dispatch.attachLong,
    fileText: dispatch.fileText,
    exchangesOf: dispatch.exchangesOf,
    exchangeOf: dispatch.exchangeOf,
  })
}
