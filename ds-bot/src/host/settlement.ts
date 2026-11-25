import { randomUUID } from 'node:crypto'
import { LATE_ANSWER, MESSAGE_INLINE_MAX } from './constants.ts'
import { cleanText } from './diagnostics.ts'
import { threadCurrentOfPart } from './threads.ts'

export const BLOCKING_CODES = new Set([
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_SIGNED_OUT',
  'ACCOUNT_TOKEN_INVALID',
  'LOCAL_AGENT_MISSING',
  'LOCAL_AGENT_SIGNIN',
  'LOCAL_AGENT_QUOTA',
  'LOCAL_AGENT_EXIT',
])

// DSH maps every HTTP 403 to AUTH, but an upstream also uses 403 for a content audit.
// An AUTH failure loses its message because providers may echo part of the key; a content
// audit cannot be fixed by rekeying, so it keeps its own code and body.
const CONTENT_POLICY = /content[\s_-]?polic|content[\s_-]?violation|content[\s_-]?filter|内容审计|内容安全|风险规则/i
const REQUEST_ID = /(?:request[-_ ]?id|x-request-id)["'\s:=]+([A-Za-z0-9._:-]{6,})/i
// Gateways wrap an exhausted plan or budget under 502/400/429; DSH reads those as
// SERVER/INVALID_REQUEST/RATE_LIMIT, while only the user can recover from quota exhaustion.
const USAGE_LIMIT = /session limit|usage limit|budget has been exceeded|quota exceeded|exceeded your current quota|insufficient[\s_-]?quota/i
const WRAPS_USAGE_LIMIT = new Set(['SERVER', 'INVALID_REQUEST', 'RATE_LIMIT', 'UNKNOWN'])

export const CUT_OFF_NOTE = '[cut off at the model\'s output limit; the answer is not complete]'
export const CUT_OFF_EMPTY_NOTE = '[cut off at the model\'s output limit before it wrote anything]'

export interface TurnFailure {
  code: string
  message: string
  status?: number
  requestId?: string
}

export interface UsageLike {
  outputTokens?: unknown
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

export interface RouteLike {
  maxTokens?: unknown
}

export interface ReplySource {
  kind?: string
  role?: string
  audience?: string
  exchangeId?: string
  senderSessionId?: string
  senderRoomId?: string
  senderPart?: string
  work?: string
}

export interface LongAttachment {
  text: string
  files?: unknown
  length?: number
}

export interface TurnOutcome {
  reply: string
  failure?: TurnFailure
  aborted?: boolean
}

export interface CutOffDiagnostic {
  wroteNothing: boolean
  ref?: string
  tokensIn?: number
  outputTokens?: number
}

export interface SettlementRuntime {
  state: {
    works?: Record<string, { imOrigin?: string } | undefined>
  }
  groupOwners: Map<string, { roomId: string; botId: string }>
  selfOf(sessionId: string): string | undefined
  botOf(botId: string | undefined): { name?: string } | undefined
  roomOf(roomId: string | undefined): { name?: string; sessions?: Record<string, string> } | undefined
  warn(template: string, ...args: unknown[]): void
  dispatch: {
    sendReply(input: Record<string, unknown>): Promise<unknown>
    forgetDelivery(exchangeId: string): void
  }
  replyOrigin?: {
    release(origin: string | undefined): void
  }
  noteFailure?(entry: Record<string, unknown>): void
  workOf?(source: ReplySource | undefined): string | undefined
  ownsWork?(botId: string | undefined, workId: string | undefined): boolean
  workAsker?(workId: string): ReplySource | undefined
  waitsWork?(workId: string): boolean
  holdWork?(workId: string, text: string): void
  answerText?(workId: string, reply: string, botName: string): string
  attachLong?(text: string, filename: string): Promise<LongAttachment>
  closeWork?(exchangeId: string | undefined, name: string, text: string): string | undefined
  abandonedWork?(exchangeId: string | undefined): unknown
  answerMissed?(exchangeId: string | undefined): void
}

export interface Settlement {
  answerSender(sessionId: string, source: ReplySource, text: string, long?: LongAttachment): void
  recordCutOff(sessionId: string, input: CutOffDiagnostic): void
  settleDirect(sessionId: string, source: ReplySource, outcome: TurnOutcome): void
  settleWork(sessionId: string, workId: string, asker: ReplySource, outcome: TurnOutcome): Promise<void>
  settle(sessionId: string, source: ReplySource, outcome: TurnOutcome): Promise<void>
}

interface ErrorLike {
  code?: unknown
  message?: unknown
  status?: unknown
  requestId?: unknown
}

const requestIdOf = (message: string): string | undefined => {
  const found = REQUEST_ID.exec(message)
  return found === null ? undefined : found[1].replace(/[.,;:)+]+$/, '')
}

export function turnFailure(error: unknown): TurnFailure {
  const err = (error !== null && typeof error === 'object' ? error : undefined) as ErrorLike | undefined
  const rawCode = typeof err?.code === 'string' && err.code !== '' ? err.code : 'UNKNOWN'
  const raw = typeof err?.message === 'string' ? err.message.trim() : ''
  const contentPolicy = rawCode === 'AUTH' && err?.status === 403 && CONTENT_POLICY.test(raw)
  const usageLimit = WRAPS_USAGE_LIMIT.has(rawCode) && USAGE_LIMIT.test(raw)
  const code = contentPolicy ? 'CONTENT_POLICY' : usageLimit ? 'QUOTA' : rawCode
  const message = code === 'AUTH' || raw === '' ? '' : cleanText(raw).slice(0, 500)
  const requestId = typeof err?.requestId === 'string' && err.requestId !== '' ? err.requestId : requestIdOf(raw)
  return {
    code,
    message,
    ...(typeof err?.status === 'number' ? { status: err.status } : {}),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

export const failureLine = (failure: TurnFailure): string =>
  `${failure.code}${failure.status ? ` ${failure.status}` : ''}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}`

export const cutOffText = (said: string): string => (said === '' ? CUT_OFF_EMPTY_NOTE : `${said}\n\n${CUT_OFF_NOTE}`)

export function prematureCutOff(usage: UsageLike | undefined, route: RouteLike | undefined): boolean {
  const limit = Number(route?.maxTokens)
  const output = Number(usage?.outputTokens)
  const input = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0)
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(output) && output >= 0
    && output < limit / 8 && input >= limit
}

export const answersUser = (info: ReplySource | undefined): boolean =>
  info?.role === 'request' && info?.audience === 'user'

export const expectsReply = (info: ReplySource | undefined): boolean =>
  info?.role === 'request' || info?.role === 'stopped'

export const formatFailureReply = (name: string, failure: TurnFailure): string =>
  `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`

export const formatAbortedReply = (name: string): string =>
  `${name} was stopped before it could answer your message.`

export function createSettlement(rt: SettlementRuntime): Settlement {
  const botNameOf = (sessionId: string): string => rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'

  const placeOf = (sessionId: string): string => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId) ?? rt.roomOf(sessionId)
    return room ? `group "${room.name}"` : 'own chat'
  }

  function answerSender(sessionId: string, source: ReplySource, text: string, long?: LongAttachment): void {
    const back = source.senderSessionId === undefined ? undefined : rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
    const asker = source.senderPart === undefined ? undefined : rt.botOf(source.senderSessionId)
    const part = back === undefined && asker !== undefined ? threadCurrentOfPart(asker, source.senderPart) : undefined
    const target = back ?? part
    const name = botNameOf(sessionId)
    const imOrigin = source.exchangeId === undefined ? undefined : rt.state.works?.[source.exchangeId]?.imOrigin
    const work = rt.closeWork?.(source.exchangeId, name, text)
    const late = work === undefined ? rt.abandonedWork?.(source.exchangeId) : undefined
    const marker = late === undefined ? '' : LATE_ANSWER
    const body = marker === '' ? (long?.text ?? text) : `${marker}${long?.text ?? text}`
    const length = long === undefined ? undefined : late === undefined ? long.length : (long.length ?? text.length) + marker.length
    const exchangeId = randomUUID()
    void rt.dispatch.sendReply({
      fromId: rt.selfOf(sessionId),
      toId: source.senderSessionId,
      ...(target ? { sessionId: target } : {}),
      text: body,
      ...(length === undefined ? {} : { files: long?.files, length }),
      role: 'reply',
      replyTo: source.exchangeId,
      imOrigin,
      exchangeId,
      ...(work ? { work } : {}),
    }).catch((error: unknown) => {
      rt.warn('ds-bot: reply delivery failed: %s', error)
      rt.dispatch.forgetDelivery(exchangeId)
      rt.answerMissed?.(source.exchangeId)
      const said = `${name} could not send its reply to you (${failureLine(turnFailure(error))}); what it had answered:\n`
      void rt.dispatch.sendReply({
        fromId: rt.selfOf(sessionId),
        toId: source.senderSessionId,
        ...(target ? { sessionId: target } : {}),
        text: `${said}${long?.text ?? text}`,
        ...(long?.length === undefined ? {} : { files: long.files, length: said.length + long.length }),
        role: 'reply',
        replyTo: source.exchangeId,
        imOrigin,
        ...(work ? { work } : {}),
      }).catch((again: unknown) => {
        rt.replyOrigin?.release(imOrigin)
        rt.warn('ds-bot: reply failure notice not delivered: %s', again)
      })
    })
  }

  function recordCutOff(sessionId: string, { wroteNothing, ref, tokensIn, outputTokens }: CutOffDiagnostic): void {
    const facts = [
      ref,
      tokensIn !== undefined && Number.isFinite(tokensIn) && tokensIn > 0 ? `${tokensIn} tokens in` : undefined,
      outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens >= 0 ? `${outputTokens} tokens out` : undefined,
    ].filter((value): value is string => value !== undefined)
    rt.noteFailure?.({
      level: 'warn',
      source: 'turn',
      code: 'MAX_TOKENS',
      text: `${wroteNothing
        ? 'the turn was cut off at the output limit before it wrote anything'
        : 'the turn was cut off at the output limit, so its answer is not complete'}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`,
      bot: rt.botOf(rt.selfOf(sessionId))?.name ?? (rt.roomOf(sessionId) ? undefined : 'unknown Bot'),
      where: placeOf(sessionId),
      sessionId,
    })
  }

  function settleDirect(sessionId: string, source: ReplySource, outcome: TurnOutcome): void {
    if (!expectsReply(source) || answersUser(source)) return
    const name = botNameOf(sessionId)
    if (outcome.failure !== undefined) {
      answerSender(sessionId, source, formatFailureReply(name, outcome.failure))
    } else if (outcome.reply !== '' || outcome.aborted === true) {
      answerSender(sessionId, source, outcome.reply !== '' ? outcome.reply : formatAbortedReply(name))
    }
  }

  async function settleWork(sessionId: string, workId: string, asker: ReplySource, outcome: TurnOutcome): Promise<void> {
    if (outcome.failure !== undefined || outcome.aborted === true) {
      settleDirect(sessionId, asker, outcome)
      return
    }
    if (rt.waitsWork?.(workId)) {
      rt.holdWork?.(workId, outcome.reply)
      return
    }
    const name = botNameOf(sessionId)
    const text = rt.answerText?.(workId, outcome.reply, name) ?? outcome.reply
    if (text.length <= MESSAGE_INLINE_MAX || rt.attachLong === undefined) {
      answerSender(sessionId, asker, text)
      return
    }
    try {
      const long = await rt.attachLong(text, `Answer from ${name}.txt`)
      answerSender(sessionId, asker, text, long)
    } catch (error) {
      rt.warn('ds-bot: answer from %s not sent: %s', name, error)
    }
  }

  async function settle(sessionId: string, source: ReplySource, outcome: TurnOutcome): Promise<void> {
    const workId = rt.workOf?.(source)
    if (workId !== undefined && rt.ownsWork?.(rt.selfOf(sessionId), workId)) {
      const asker = rt.workAsker?.(workId)
      if (asker !== undefined) {
        await settleWork(sessionId, workId, asker, outcome)
        return
      }
    }
    settleDirect(sessionId, source, outcome)
  }

  return { answerSender, recordCutOff, settleDirect, settleWork, settle }
}

export function install(rt: SettlementRuntime & { settlement?: Settlement }): void {
  rt.settlement = createSettlement(rt)
}
