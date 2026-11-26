import { checkShownView, normalizeView, readViewReply, viewCardText, viewReply, viewReplyText } from 'deep-view/core'
import { parseReplies, relayRange, stackReplies } from '../shared/group-replies.ts'
import { viaOf } from '../shared/im-platforms.ts'
import { openTurnAt } from './btw.ts'
import { HISTORY_TIMEOUT_MS, REPLY_KIND, SOURCE_KIND } from './constants.ts'
import { questionTitle, questionsOf } from './question-card.ts'
import { ensureSessionIndex } from './session-index.ts'
import { reminderPrompts, textOf } from './text.ts'
import { pageThinkingMs } from './thinking.ts'

export { viewCardText, viewReply }

export function cardText(args: any): string {
  let card = args
  if (typeof card === 'string') {
    try { card = JSON.parse(card) } catch { return '' }
  }
  const several = Array.isArray(card?.questions) && card.questions.length > 0
  const lines = (several ? card.questions : [card]).map((asked: any) => {
    const question = typeof asked?.question === 'string' ? asked.question.trim() : ''
    const given = Array.isArray(asked?.options) ? asked.options : []
    if (given.some((option: any) => typeof option?.label !== 'string')) return ''
    const options = given.map((option: any) => option.label.trim()).filter(Boolean)
    if (question === '' || options.length === 0) return ''
    const detail = typeof asked.detail === 'string' ? asked.detail.trim() : ''
    return `[Question card] ${questionTitle({ header: several ? asked.header : undefined, question })}${detail ? ` (${detail})` : ''}\nOptions: ${options.join(' / ')}`
  })
  return lines.includes('') ? '' : lines.join('\n')
}

export function questionReply(card: any, answer: any) {
  const asked = questionsOf(card)
  if (asked.length === 0) return undefined
  const given = Array.isArray(answer?.answers) ? answer.answers : [{ ...answer, id: asked[0].id }]
  const answers = asked.map((question: any) => {
    const mine = given.find((item: any) => item?.id === question.id)
    const labels = new Set((question.options ?? []).map((option: any) => option.label))
    const picked = (Array.isArray(mine?.selected) ? mine.selected : []).filter((label: any) => typeof label === 'string' && labels.has(label))
    const selected = question.multiSelect === true ? [...new Set(picked)] : picked.slice(0, 1)
    const custom = typeof mine?.custom === 'string' ? mine.custom.trim() : ''
    if (selected.length === 0 && custom === '') return { id: question.id, selected: [], skipped: true }
    return { id: question.id, selected, ...(custom !== '' ? { custom } : {}) }
  })
  if (answers.every((item: any) => item.skipped === true)) return undefined
  const callId = card.callId ?? card.id
  const questions = asked.map((question: any) => ({
    id: question.id,
    ...(question.header ? { header: question.header } : {}),
    question: question.question,
    ...(question.detail ? { detail: question.detail } : {}),
    options: question.options,
    multiSelect: question.multiSelect === true,
  }))
  return {
    text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user', callId, questions, answers }),
    source: { kind: REPLY_KIND, callId, outcome: 'answered' },
  }
}

export function handoffReply(hold: any, outcome: string) {
  const settled = outcome === 'done' ? 'done' : outcome === 'skip' ? 'skipped' : 'returned'
  const callId = hold.callId
  const message = settled === 'skipped'
    ? 'The user skipped this step and gave the browser back. Do not retry it. Do what you can without it, or tell the user you cannot.'
    : settled === 'done'
      ? 'The user finished this step and gave the browser back. Carry on from where you stopped. Take a browser_snapshot first to see the page.'
      : 'The user gave the browser back. Do not assume this step is finished. Take a browser_snapshot to see the page, then carry on or ask the user what remains.'
  return {
    text: JSON.stringify({
      kind: 'answer_to_pending_handoff',
      tool: 'browser_handoff',
      callId,
      reason: hold.reason,
      ...(hold.note ? { note: hold.note } : {}),
      outcome: settled,
      message,
    }),
    source: { kind: REPLY_KIND, callId, outcome: 'answered' },
  }
}

export function readReply(text: string): Record<string, any> | undefined {
  let value: any
  try { value = JSON.parse(text) } catch { return undefined }
  if (value?.kind === 'answer_to_pending_handoff') {
    if (typeof value.callId !== 'string' || typeof value.reason !== 'string') return undefined
    return { handoff: { callId: value.callId, reason: value.reason, note: typeof value.note === 'string' ? value.note : '', outcome: value.outcome === 'skipped' || value.outcome === 'returned' ? value.outcome : 'done' } }
  }
  const viewReplyData = readViewReply(text)
  if (viewReplyData !== undefined) return viewReplyData
  const questions = Array.isArray(value?.questions) ? value.questions.filter((item: any) => typeof item?.id === 'string' && typeof item.question === 'string') : []
  if (questions.length === 0) return undefined
  const answers = (Array.isArray(value.answers) ? value.answers : []).filter((item: any) => typeof item?.id === 'string' && Array.isArray(item.selected))
  return { questions, answers }
}

export function replyText(text: string): string {
  const reply = readReply(text)
  if (reply === undefined) return text
  if (reply.handoff !== undefined) {
    const { reason, note, outcome } = reply.handoff
    return `[Browser handoff] ${note === '' ? reason : `${reason} — ${note}`}\nAnswer: ${outcome}`
  }
  if (reply.views !== undefined) return viewReplyText(text)
  return reply.questions.map((question: any) => {
    const answer = reply.answers.find((item: any) => item.id === question.id)
    const values = [...(answer?.selected ?? []), ...(answer?.custom ? [answer.custom] : [])]
    return `[Answer to question card] ${questionTitle(question)}\nAnswer: ${values.length > 0 ? values.join(', ') : '(skipped)'}`
  }).join('\n\n')
}

export function historyEntry(event: any, group?: boolean) {
  if (event.type === 'assistant/message') {
    const text = textOf(event.data?.message?.content)
    return text === '' ? undefined : { answer: true, text }
  }
  const named = (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') ? event.data?.name : undefined
  if ((named === 'ask_user' || named === 'show_view') && !group) {
    const text = named === 'ask_user' ? cardText(event.data.arguments) : viewCardText(event.data.arguments)
    return text === '' ? undefined : { answer: true, text }
  }
  const source = event.data?.source
  if (event.type === 'user/message' && source?.kind === REPLY_KIND) {
    return { answer: false, who: 'user', text: replyText(textOf(event.data.content)), keepAnswers: true }
  }
  if (event.type !== 'user/message' || (source?.kind !== 'user' && source?.kind !== SOURCE_KIND)) return undefined
  const text = textOf(event.data.content)
  const ours = source.kind === SOURCE_KIND
  const skipped = (ours && (source.handoff === true || source.role === 'kickoff' || source.role === 'goal')) || (!group && text.startsWith('[Group chat'))
  return { answer: false, who: ours ? 'bot' : 'user', text: skipped ? '' : text, keepAnswers: !skipped || (ours && source.resume === true) }
}

const EARLIER_PAGE = 60
const PREVIEWABLE = new Set(['bot', 'user', 'answer', 'post', 'view'])

const TOOL_PHRASES: Array<[RegExp, string]> = [
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/grep|glob|list_dir|^ls$|find|search/i, 'Looking through files'],
  [/write|edit|patch|apply|replace/i, 'Writing changes'],
  [/image|photo|draw/i, 'Working on an image'],
]

const STEP_LABELS: Record<string, string> = {
  list_secrets: 'Checking the keys',
  ask_user_question: 'Waiting for your answer',
  message_bot: 'Asking another Bot',
  stop_bot: 'Stopping another Bot',
  create_bot: 'Creating a Bot',
  update_bot: 'Updating a Bot',
  create_group: 'Creating a group',
  update_group: 'Updating the group',
  delete_group: 'Deleting the group',
  post_to_group: 'Posting in the group',
  list_bots: 'Checking the team',
  read_group_chat: 'Reading a group chat',
  read_own_chat: 'Looking back through the chat',
  remember: 'Saving to memory',
  forget: 'Updating memory',
  recall: 'Checking memory',
}

export const toolLabel = (name: string): string | undefined =>
  STEP_LABELS[name] ?? TOOL_PHRASES.find(([pattern]) => pattern.test(name))?.[1]

export interface PartViewDeps {
  rt: Record<string, any>
  partsOf: (botId?: string, roomId?: string, segments?: any[], currentSessionId?: string) => any[]
  partsOfThread: (botId: string | undefined, sessionId: string | undefined) => any[]
}

export function createPartView({ rt, partsOf, partsOfThread }: PartViewDeps) {
  const { ctx, state } = rt
  const index = ensureSessionIndex(rt)

  function displayItems(partId: string, events: any[], session?: any, seedTurn?: number) {
    const hidden = new Set(state.exchangeTurns[partId] ?? [])
    const presented: Array<{ turn: number | undefined; seq: number; files: any[] }> = []
    const relayCalls = new Set<unknown>()
    const items: Record<string, any>[] = []
    let turn: number | undefined = seedTurn ?? openTurnAt(ctx.get?.('sessionProjections'), session, events[0]?.seq)
    const stamp = (event: any, item: Record<string, any>) => {
      if (typeof event.seq === 'number' && Number.isInteger(event.seq)) item.seq = event.seq
      if (turn !== undefined) item.turn = turn
      items.push(item)
    }
    for (const event of events) {
      if (event.type === 'turn/start') {
        if (typeof event.data?.turn === 'number' && Number.isInteger(event.data.turn)) turn = event.data.turn
        continue
      }
      if (event.type === 'deliverables/presented') {
        const files = Array.isArray(event.data?.files) ? event.data.files.filter((file: any) => typeof file?.path === 'string') : []
        if (files.length > 0) presented.push({ turn: event.data?.turn ?? turn, seq: event.seq, files })
        continue
      }
      if (event.type === 'assistant/message') {
        if (hidden.has(event.data?.turn)) continue
        const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') stamp(event, { kind: 'bot', text: block.text, time: event.time })
        }
        continue
      }
      if (event.type === 'tool/call') {
        if (event.data?.name === 'group_relay') relayCalls.add(event.data?.callId)
        const named = event.data?.name
        if (named === 'show_view' || named === 'ask_user') {
          let args = event.data?.arguments
          if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
          const callId = event.data?.callId ?? null
          const closed = callId === null ? undefined : rt.own(rt.own(state.closedCards, partId), callId)
          if (named === 'ask_user') {
            if (closed !== undefined) {
              const asked = (Array.isArray(args?.questions) && args.questions.length > 0 ? args.questions : [args]).map((item: any) => ({
                ...(item?.header ? { header: String(item.header) } : {}),
                question: String(item?.question ?? ''),
                ...(item?.detail ? { detail: String(item.detail) } : {}),
                options: Array.isArray(item?.options) ? item.options : [],
                multiSelect: item?.multiSelect === true,
              }))
              items.push({ kind: 'closed', closed, question: asked[0], ...(asked.length > 1 ? { questions: asked } : {}), callId, time: event.time })
            }
            continue
          }
          const view = normalizeView(args?.view)
          const shown = checkShownView(args?.title, view)
          if (shown.error === undefined && !shown.interactive && args?.await_reply !== true) {
            if (!hidden.has(event.data?.turn ?? turn)) items.push({ kind: 'view', title: shown.title, view, callId, time: event.time })
          } else if (shown.error === undefined && closed !== undefined) {
            items.push({ kind: 'closed', closed, title: shown.title, view, callId, time: event.time })
          }
        }
        continue
      }
      if (event.type === 'tool/result') {
        const message = event.data?.message
        if (!relayCalls.has(message?.toolCallId)) continue
        const text = textOf(message?.content)
        const range = relayRange(text)
        const room = range === undefined ? undefined : rt.roomOf(partId) ?? rt.roomOf(index.pastOwners.get(partId)?.roomId)
        const replies = range === undefined ? parseReplies(text).replies : room === undefined ? [] : rt.groupRows(room.id, range.from, range.to, range.anchor)
        for (const { reply, texts, time, duration, claims, changes } of stackReplies(replies)) {
          const item: Record<string, any> = { time: time ?? reply.time ?? event.time }
          if (turn !== undefined) item.turn = turn
          if (reply.kind === 'user') items.push({ kind: 'user', text: reply.text, ...(reply.via ? { via: reply.via } : {}), ...item })
          else if (reply.kind === undefined) items.push({ kind: 'post', botId: reply.botId ?? null, name: reply.name ?? null, texts, ...(claims === undefined ? {} : { claims }), ...(changes === undefined ? {} : { changes }), ...item, ...(duration === undefined ? {} : { duration }) })
          else items.push({ kind: 'relay', reply, ...item })
        }
        continue
      }
      if (event.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind === 'user') {
        const content = Array.isArray(event.data.content) ? event.data.content : []
        const imageRefs = content.filter((block: any) => block?.type === 'image' && block.attachment !== undefined)
          .map((block: any) => ({ attachmentId: block.attachment.attachmentId, mime: block.attachment.mediaType ?? block.attachment.mime ?? block.attachment.mimeType, name: block.attachment.name }))
        const images = content.filter((block: any) => block?.type === 'image').length
        const via = viaOf(source)
        stamp(event, { kind: 'user', text: textOf(content), ...(images > 0 ? { images } : {}), ...(imageRefs.length > 0 ? { imageRefs } : {}), ...(via ? { via } : {}), time: event.time })
      } else if (source?.kind === REPLY_KIND) {
        const text = textOf(event.data.content)
        const reply = readReply(text)
        if (reply?.questions !== undefined) stamp(event, { kind: 'answer', questions: reply.questions, answers: reply.answers, time: event.time })
        else if (reply?.handoff !== undefined) stamp(event, { kind: 'answer', text: replyText(text), handoff: reply.handoff, time: event.time })
        else if (reply?.views !== undefined) stamp(event, { kind: 'answer', text: replyText(text), views: reply.views, answers: reply.answers, time: event.time })
      } else if (source?.kind === SOURCE_KIND && source.role === 'post') {
        const content = Array.isArray(event.data.content) ? event.data.content : []
        const file = source.length === undefined ? undefined : content.find((block: any) => block?.type === 'file')?.attachment
        stamp(event, {
          kind: 'post',
          botId: source.senderSessionId ?? null,
          name: source.senderName ?? null,
          ...(source.claims === undefined ? {} : { claims: source.claims }),
          ...(source.changes === undefined ? {} : { changes: source.changes }),
          text: textOf(content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
          ...(file ? { file, length: source.length } : {}),
          time: event.time,
        })
      } else if (source?.kind === SOURCE_KIND && source.handoff !== true && source.deferred !== true && ['request', 'reply', 'report', 'stopped'].includes(source.role)) {
        stamp(event, { kind: 'event', role: source.role, botId: source.senderSessionId ?? null, name: source.senderName ?? null, roomId: source.roomId ?? null, time: event.time })
      } else if (source?.kind === 'schedule') {
        const prompts = reminderPrompts(textOf(event.data.content))
        stamp(event, { kind: 'event', role: 'schedule', text: prompts.join(' · ').slice(0, 120), time: event.time })
      }
    }
    for (const entry of presented) {
      const owner = [...items].reverse().find(item => item.turn === entry.turn && (item.kind === 'bot' || item.kind === 'post'))
      if (owner === undefined) continue
      owner.files = [
        ...(owner.files ?? []),
        ...entry.files.map((file: any, idx: number) => ({ name: String(file.path).split(/[\\/]/).pop() || 'file', sessionId: partId, seq: entry.seq, index: idx })),
      ]
    }
    return items
  }

  function stepsItems(events: any[], partId: string) {
    const hidden = new Set(state.exchangeTurns[partId] ?? [])
    const byTurn = new Map<number, Array<Record<string, any>>>()
    let turn: number | undefined
    for (const event of events) {
      if (event.type === 'turn/start') {
        if (typeof event.data?.turn === 'number' && Number.isInteger(event.data.turn)) turn = event.data.turn
        continue
      }
      if (turn === undefined || hidden.has(turn)) continue
      if (event.type === 'tool/call') {
        const name = event.data?.name
        if (typeof name !== 'string' || name === 'ask_user' || name === 'request_secret' || name === 'group_relay') continue
        let list = byTurn.get(turn)
        if (list === undefined) byTurn.set(turn, list = [])
        list.push({ callId: event.data?.callId ?? null, name, label: toolLabel(name) ?? null })
        continue
      }
      if (event.type === 'tool/result') {
        const callId = event.data?.message?.toolCallId
        const entry = byTurn.get(turn)?.find(tool => tool.callId === callId)
        if (entry !== undefined && typeof event.data?.message?.ok === 'boolean') entry.ok = event.data.message.ok
      }
    }
    for (const tools of byTurn.values()) for (const tool of tools) delete tool.callId
    return byTurn
  }

  async function applySteps(items: Record<string, any>[], events: any[], sessionId: string, options?: any) {
    const byTurn = stepsItems(events, sessionId)
    const known = pageThinkingMs(events, options)
    for (const [turn, tools] of byTurn) {
      const item: Record<string, any> = { kind: 'steps', turn, tools, time: items.filter(it => it.turn === turn).at(-1)?.time ?? events.at(-1)?.time }
      const ms = known.has(turn) ? known.get(turn) : await rt.thinkingOf(sessionId, turn).catch(() => undefined)
      if (typeof ms === 'number' && ms > 0) item.ms = ms
      const at = items.reduce((last, it, idx) => (it.turn === turn ? idx : last), -1)
      items.splice(at < 0 ? items.length : at + 1, 0, item)
    }
    return items
  }

  async function partPage(parts: any[], idx: number, cursor?: any, steps = false) {
    const part = parts[idx]
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const agent = await rt.resolveAgent(part.sessionId).catch(() => undefined)
    const page = await ctx.sessionController.page({
      address: { kind: 'session', sessionId: part.sessionId },
      ...(agent ? { throughSeq: Number(agent.session.seq) - 1 } : {}),
      ...(Number.isInteger(cursor?.beforeSeq) ? { beforeSeq: cursor.beforeSeq } : {}),
      maxMessages: EARLIER_PAGE,
    }, signal)
    const events = page.records.map((record: any) => record.event)
    let seedTurn: number | undefined
    if (agent === undefined) {
      let before = events[0]?.seq
      while (Number.isInteger(before) && seedTurn === undefined) {
        const back = await ctx.sessionController.page({
          address: { kind: 'session', sessionId: part.sessionId },
          beforeSeq: before,
          maxMessages: EARLIER_PAGE,
        }, signal)
        const starts = back.records.map((record: any) => record.event).filter((event: any) => event.type === 'turn/start')
        if (starts.length > 0) {
          const last = starts.at(-1).data?.turn
          if (Number.isInteger(last)) seedTurn = last
          break
        }
        if (!back.hasMore) break
        before = back.records[0]?.event?.seq
      }
    }
    const items = displayItems(part.sessionId, events, agent?.session, seedTurn)
    if (idx < parts.length - 1) {
      for (const item of items) {
        if (item.sessionId === undefined && (item.kind === 'bot' || item.kind === 'post')) item.sessionId = part.sessionId
      }
    }
    const more = page.hasMore && events.length > 0
    if (!more && idx > 0) items.unshift({ kind: 'divider', time: part.startedAt })
    if (steps === true) await applySteps(items, events, part.sessionId)
    return { items, cursor: more ? { part: idx, beforeSeq: events[0].seq } : idx > 0 ? { part: idx - 1 } : null }
  }

  async function earlierPage(sessionId: string, cursor?: any) {
    const past = index.pastOwners.get(sessionId)
    const roomId = index.roomOwners.get(sessionId) ?? (past?.botId === undefined ? past?.roomId : undefined)
    const botId = roomId === undefined ? index.chatOwners.get(sessionId) ?? (past?.roomId === undefined ? past?.botId : undefined) : undefined
    const parts = roomId === undefined ? (botId === undefined ? [] : partsOfThread(botId, sessionId)) : partsOf(undefined, roomId)
    const at = parts.findIndex(part => part.sessionId === sessionId)
    const idx = Number.isInteger(cursor?.part) ? cursor.part : at - 1
    if (at <= 0 || idx < 0 || idx >= at) return { items: [], cursor: null, startedAt: parts[at]?.startedAt ?? null }
    const btw = botId === undefined ? [] : (await rt.btwPartCards?.(botId, parts[idx].sessionId)) ?? []
    return { ...(await partPage(parts, idx, cursor)), btw, startedAt: parts[at].startedAt }
  }

  async function chatPage(botId: string, cursor?: any, steps = false) {
    const parts = partsOf(botId)
    if (parts.length === 0) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    const idx = Number.isInteger(cursor?.part) ? cursor.part : parts.length - 1
    if (idx < 0 || idx >= parts.length) return { sessionId: parts.at(-1).sessionId, items: [], cursor: null }
    return { sessionId: parts.at(-1).sessionId, ...(await partPage(parts, idx, cursor, steps)) }
  }

  const tails = new Map<string, { lastAt: number; preview: string } | null>()
  const previewText = (item: Record<string, any>) =>
    String(item.text ?? item.title ?? item.texts?.join(' ') ?? '').replace(/\s+/g, ' ').trim()
  const applyTail = (sessionId: string, item: Record<string, any>) =>
    tails.set(sessionId, { lastAt: item.time ?? 0, preview: previewText(item) })

  const fillTail = async (sessionId: string) => {
    try {
      let beforeSeq: number | undefined
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await ctx.sessionController.page({
          address: { kind: 'session', sessionId },
          ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          maxMessages: EARLIER_PAGE,
        }, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        const events = page.records.map((record: any) => record.event)
        const last = [...displayItems(sessionId, events)].reverse().find(item => PREVIEWABLE.has(item.kind))
        if (last !== undefined) { applyTail(sessionId, last); return }
        if (!page.hasMore || events.length === 0) break
        beforeSeq = events[0]?.seq
      }
      tails.set(sessionId, { lastAt: 0, preview: '' })
    } catch {
      tails.set(sessionId, { lastAt: 0, preview: '' })
    }
  }

  const chatTail = (sessionId: string) => {
    if (!tails.has(sessionId)) {
      tails.set(sessionId, null)
      void fillTail(sessionId)
      return undefined
    }
    return tails.get(sessionId) ?? undefined
  }

  ctx.on('session/event', (session: any, event: any) => {
    if (!tails.has(session.id)) return
    try {
      for (const item of displayItems(session.id, [event], session)) {
        if (PREVIEWABLE.has(item.kind)) applyTail(session.id, item)
      }
    } catch { /* a tail miss must never take out the other listeners */ }
  })

  return { displayItems, stepsItems, applySteps, partPage, earlierPage, chatPage, chatTail }
}
