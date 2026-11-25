import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { HANDOFF_ACK, REFERENCE_KIND, REPLY_KIND, SOURCE_KIND, STEER_CUT } from './constants.ts'
import { cleanText } from './diagnostics.ts'
import { absoluteLinks } from './links.ts'
import {
  BLOCKING_CODES,
  CUT_OFF_NOTE,
  answersUser,
  createSettlement,
  cutOffText,
  expectsReply,
  failureLine,
  prematureCutOff,
  turnFailure,
} from './settlement.ts'
import { splitRef, textOf } from './text.ts'
import { threadCurrentOfPart } from './threads.ts'
import { viaOf } from '../shared/im-platforms.ts'
import { reminderText } from './schedules.ts'
import { usageChunk } from './usage.ts'

export { BLOCKING_CODES, cutOffText, failureLine, prematureCutOff, turnFailure }

const KEY_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'])
const SIGN_IN_CODES = new Set(['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID'])

export function attachReference(queued, source, text) {
  const post = queued?.findLast(item => item.botId === undefined && item.kickoff !== true)
  if (post === undefined || text === '') return
  const labels = (Array.isArray(source?.references) ? source.references : [])
    .map(reference => reference?.label).filter(label => typeof label === 'string' && label !== '')
  post.references = [...(post.references ?? []), { labels, text }]
}

// A tool call some models write into their text instead of making it (the XML-like
// form of their own chat template). A reply cut off in the middle of such a call can
// keep only its closing tags, so those count as one too, or only the first tags of a
// parameter. Some models write the CJK brackets, so both forms match.
const TAG_OPEN = '[<＜]'
const TAG_CLOSE = '[>＞]'
const TOOL_CALL_TAG = `${TAG_OPEN}tool_call${TAG_CLOSE}`
const FUNCTION_TAG = `${TAG_OPEN}function=[\\w.-]+${TAG_CLOSE}`
const PARAMETER_TAG = `${TAG_OPEN}parameter=[\\w.-]+${TAG_CLOSE}`
const CLOSING_TAG = `${TAG_OPEN}/(?:parameter|function|tool_call)${TAG_CLOSE}`
const WRITTEN_CALL = new RegExp(`${TOOL_CALL_TAG}\\s*${TAG_OPEN}function=|${FUNCTION_TAG}\\s*${TAG_OPEN}parameter=|${CLOSING_TAG}`)
export const writesToolCall = text => typeof text === 'string' && WRITTEN_CALL.test(text)
export const stripWrittenCalls = text => text
  .replace(new RegExp(`${TOOL_CALL_TAG}[\\s\\S]*?(?:${TAG_OPEN}/tool_call${TAG_CLOSE}|$)`, 'g'), '')
  .replace(new RegExp(`${FUNCTION_TAG}[\\s\\S]*?(?:${TAG_OPEN}/function${TAG_CLOSE}|$)`, 'g'), '')
  .replace(new RegExp(`(?:${CLOSING_TAG}|${PARAMETER_TAG})\\s*`, 'g'), '')
  .trim()

// Under DSH's PTC presentation the model calls only this tool; the program's sub-calls
// are the tools it really runs.
const PROGRAM_TOOL = 'run_code'
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork'])
const subEndText = (data) => {
  const text = textOf(data?.lastAssistantMessage)
  const reason = typeof data?.stopReason === 'string' ? data.stopReason : ''
  if (text === '') return `subagent ended${reason === '' ? '' : ` (${reason})`} without a closing message.`
  return reason === '' || reason === 'completed' ? text : `subagent ended (${reason}) before it finished. What it had written:\n${text}`
}

// A settlement notice is all a plugin loaded again has of an ending (#973): its
// runtime-owned summary names how the child stopped without carrying raw output into
// the group ledger.
const noticeStopReason = (source, content) => {
  const said = typeof source?.summary === 'string' && source.summary !== ''
    ? source.summary
    : (textOf(content).split('\n')[0] ?? '')
  const rest = said.replace(/^Background subagent \S+\s+/, '')
  if (rest === '' || rest.startsWith('finished')) return undefined
  if (rest.startsWith('was stopped')) return 'aborted'
  if (rest.startsWith('ran out of room')) return 'max-tokens'
  if (rest.startsWith('declined')) return 'refusal'
  if (rest.startsWith('failed')) return 'error'
  return /^ended abnormally \(([^)]*)\)/.exec(rest)?.[1] ?? 'error'
}

const RETRY_TEXT = 'Your last reply wrote a tool call as plain text (<tool_call>…), so it did not run and nothing happened. Call the tool through the tool interface now, then reply as you meant to.'
const RETRY_PROMISE_TEXT = 'Your last reply said you would start working, but you ended the turn without calling any tool, so nothing ran. Call the tools you need and do the work now. If your last reply already was your whole answer, reply [PASS]; it stays posted.'
// The turn number a running turn gets when it started before this plugin was loaded and
// dsh does not say which number it has. dsh numbers turns from 1, so this one is unused.
const RECOVERED_TURN = -1

const PROMISED_WORK = /(?:^(?:收到|好的|明白|好|行|没问题|了解)[，,、。.!！：\s]*(?:我(?:现在|这就|先|马上|立刻|去|来)?(?:开始|着手|去|来|准备)?(?:排查|检查|调查|查看|看看|搜索|搜一下|分析|处理|执行|运行|跑一下|修改|修复|实现|编写|整理|验证|测试|读一下|翻一下)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|(?:现在|马上|立刻)?(?:开始|着手)(?:执行|处理|排查|检查|调查|干活|开工)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|开工(?:[。！!，,\s]|$))|^(?:开工(?:[。！!，,\s]|$)|我(?:现在|这就|先|马上|立刻)(?:开始|着手|去)(?:排查|检查|调查|查看|搜索|分析|处理|执行|运行|修改|修复|实现|编写|整理|验证|测试)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了))|\b(?:(?:i\s+will|i'll|let\s+me|going\s+to)\s+(?:start|begin|check|look\s+into|investigate|search|run|inspect|read|fix|implement|work\s+on)\b|(?:starting|beginning)\s+(?:the\s+)?(?:investigation|check|search|work|execution|analysis)\b|^on\s+it[,.\s!]+(?:i'll|i\s+will|let\s+me|starting|checking)\b))/i
export const promisesWork = text => typeof text === 'string' && text.trim().length <= 240 && PROMISED_WORK.test(text.trim())

export function install(rt) {
  const { ctx, state } = rt
  const settlement = rt.settlement ??= createSettlement(rt)

  const retryTurn = (id, info, note, text) => {
    const keeps = info !== undefined && (info.role === 'room' || expectsReply(info))
    return rt.dispatch.sendReply({
      ...(keeps && info.senderSessionId ? { fromId: info.senderSessionId } : {}),
      toId: rt.selfOf(id),
      sessionId: id,
      role: keeps ? info.role : 'retry',
      ...(keeps && info.roomId ? { roomId: info.roomId } : {}),
      ...(keeps && info.exchangeId ? { exchangeId: info.exchangeId } : {}),
      ...(info?.work ? { work: info.work } : {}),
      ...(keeps && info.audience ? { audience: info.audience } : {}),
      ...(keeps && info.askedBy ? { askedBy: info.askedBy } : {}),
      ...(keeps && info.senderRoomId ? { fromRoomId: info.senderRoomId } : {}),
      ...(keeps && info.senderPart ? { fromPart: info.senderPart } : {}),
      note,
      retried: true,
      text,
    })
  }
  const retryWrittenCall = (id, info) => retryTurn(id, info, 'your tool call did not run', RETRY_TEXT)
  const retryPromisedWork = (id, info) => retryTurn(id, info, 'you stopped before calling any tool', RETRY_PROMISE_TEXT)

  const live = new Map()
  const roomWaiters = new Map()
  const roomProgress = new Map()
  const roomInbox = new Map()
  const queueRoomMessage = (roomId, item) => roomInbox.set(roomId, [...(roomInbox.get(roomId) ?? []), item])
  const stoppedRoomTurns = new Set()
  const subagentsByParent = new Map()
  const subagentParent = new Map()
  const stoppedSubagents = new Set()
  const stoppedSubagentParents = new Set()
  const promisedOpenings = new Set()
  const unanswered = new Map()
  const HEARD_KEPT = 50
  const replyPlace = id => `${rt.selfOf(id)}\u0000${rt.groupOwners.get(id)?.roomId ?? ''}`
  const noteHeard = (id, requestId) => {
    if (rt.selfOf(id) === undefined) return
    const key = replyPlace(id)
    unanswered.set(key, [...(unanswered.get(key) ?? []), requestId].slice(-HEARD_KEPT))
  }
  const takeHeard = (id) => {
    const key = replyPlace(id)
    const heard = unanswered.get(key) ?? []
    unanswered.delete(key)
    return heard
  }

  const STOPPED_KEPT = 200
  const rememberStopped = (set, value) => {
    set.add(value)
    if (set.size > STOPPED_KEPT) set.delete(set.values().next().value)
  }

  const subagentLabelFromCall = (entry) => {
    const call = [...(entry?.calls?.values() ?? [])].findLast(item => item.name === 'subagent')
    if (call === undefined) return undefined
    try {
      const args = JSON.parse(call.args || '{}')
      const raw = [args.description, args.label, args.prompt, args.task].find(value => typeof value === 'string' && value.trim() !== '')
      return raw?.replace(/\s+/g, ' ').trim().slice(0, 120)
    } catch {
      return undefined
    }
  }

  const noteSubagentStart = (parentId, childId, label, since = Date.now()) => {
    if (typeof parentId !== 'string' || parentId === '' || typeof childId !== 'string' || childId === '') return
    if (stoppedSubagents.has(childId) || (!rt.isBotSession(parentId) && !rt.roomOf(parentId))) return
    subagentParent.set(childId, parentId)
    let map = subagentsByParent.get(parentId)
    if (map === undefined) subagentsByParent.set(parentId, map = new Map())
    const existing = map.get(childId)
    map.set(childId, {
      childId,
      label: label || existing?.label || subagentLabelFromCall(live.get(parentId)),
      since: existing?.since ?? since,
    })
    if (rt.groupOwners.has(parentId)) rt.workRoomTurn?.(parentId, 'subagent')
  }

  // The settlement notice can arrive before subagent/end, so the label must outlive the
  // active entry; it is spent when the ending is read (#973).
  const endedSubagentLabels = new Map()
  const noteSubagentEnd = (childId) => {
    if (typeof childId !== 'string' || childId === '') return
    const parentId = subagentParent.get(childId)
    if (parentId === undefined) return
    const map = subagentsByParent.get(parentId)
    const label = map?.get(childId)?.label
    if (typeof label === 'string' && label !== '') {
      endedSubagentLabels.set(childId, label)
      while (endedSubagentLabels.size > 100) endedSubagentLabels.delete(endedSubagentLabels.keys().next().value)
    }
    map?.delete(childId)
    if (map !== undefined && map.size === 0) subagentsByParent.delete(parentId)
  }

  const notedSubagentFailures = new Set()
  const noteSubagentFailure = (parentId, childId, { stopReason, helper, closing }: { stopReason?: any, helper?: any, closing?: any }) => {
    if (typeof childId !== 'string' || childId === '' || notedSubagentFailures.has(childId)) return
    rememberStopped(notedSubagentFailures, childId)
    void rt.subagentFailureNotice(parentId, { stopReason, helper, closing })
      .catch(error => rt.warn('ds-bot: background helper failure not posted: %s', error))
  }

  const hasSubagents = id => (subagentsByParent.get(id)?.size ?? 0) > 0

  const subagentDoingOf = (id) => {
    const active = [...(subagentsByParent.get(id)?.values() ?? [])].at(-1)
    if (active === undefined) return undefined
    return { since: active.since, tool: 'subagent', ...(active.label ? { note: active.label.slice(0, 120) } : {}) }
  }

  async function stopSubagents(sessionId) {
    const map = subagentsByParent.get(sessionId)
    const childIds = [...(map?.keys() ?? [])]
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
      const header = agent?.session?.header
      if (header?.parentSession === sessionId && header.origin === 'subagent' && typeof agent.id === 'string' && !childIds.includes(agent.id)) {
        childIds.push(agent.id)
      }
    }
    if (childIds.length === 0) return false
    subagentsByParent.delete(sessionId)
    stoppedSubagentParents.add(sessionId)
    for (const childId of childIds) {
      rememberStopped(stoppedSubagents, childId)
      // Not in the plugin's inject list, where ctx.subagents throws; interrupt can throw too.
      try { await ctx.get?.('subagents')?.interrupt?.(childId, { kind: 'user', parentSessionId: sessionId }) } catch {}
      const childAgent = ctx.get?.('agents')?.get?.(childId)
      if (childAgent !== undefined) {
        try { childAgent.cancel?.({ kind: 'user' }) } catch {}
      }
    }
    const parent = await rt.resolveAgent(sessionId).catch(() => undefined)
    for (const message of [...(parent?.inbox?.nextStep ?? []), ...(parent?.inbox?.nextTurn ?? [])]) {
      if (message?.source?.kind === 'subagent-settled' || stoppedSubagents.has(message?.source?.senderSessionId)) {
        parent.inbox.remove(message.id)
      }
    }
    return true
  }

  // A plugin update replaces the files under a running dsh and loads the plugin again
  // in place: the process keeps its turns and child agents, while the maps above start
  // empty. Adopt what dsh still runs from its live Agents, so Stop, the group view and
  // a late child settle still see it: a subagent child belongs to the Session in its
  // header, and a Bot Session whose Agent runs is mid-turn. A running call is not in
  // dsh's registry, so an adopted turn shows as working without its call line.
  async function adoptLiveWork() {
    const agents = ctx.get?.('agents')
    if (agents?.list === undefined) return
    await rt.load()
    const known = id => rt.isBotSession(id) || rt.roomOf(id) !== undefined
    for (const agent of agents.list()) {
      if (agent?.status !== 'running') continue
      const sessionId = agent?.session?.id ?? agent?.id
      const header = agent?.session?.header
      const parentId = header?.parentSession
      if (typeof parentId === 'string' && header?.origin === 'subagent' && known(parentId)) {
        noteSubagentStart(parentId, sessionId, undefined, Date.now())
        continue
      }
      if (typeof sessionId !== 'string' || !known(sessionId)) continue
      const entry = liveOf(sessionId)
      if (entry.turn !== undefined) continue
      entry.turn = RECOVERED_TURN
      entry.opened = true
      entry.since ??= Date.now()
      setActivity(sessionId, 'thinking')
    }
  }

  async function stopRoomTurn(sessionId, exchangeId) {
    rememberStopped(stoppedRoomTurns, exchangeId)
    await stopSubagents(sessionId)
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    if (agent === undefined) return
    const entry = live.get(sessionId)
    if (entry?.turn !== undefined && entry.info?.exchangeId === exchangeId) {
      agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      return
    }
    for (const message of [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]) {
      if (message.source?.exchangeId === exchangeId && agent.inbox.remove(message.id)) stoppedRoomTurns.delete(exchangeId)
    }
  }

  async function stopChat(botId) {
    await rt.load()
    const sessionId = rt.chatOf(botId)
    if (sessionId === undefined) return false
    const turnRunning = live.get(sessionId)?.turn !== undefined
    const subRunning = hasSubagents?.(sessionId) === true
    if (!turnRunning && !subRunning) return false
    await stopSubagents(sessionId)
    if (turnRunning) {
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      agent?.cancel?.({ kind: 'user' })
    }
    return true
  }

  const liveOf = id => {
    let entry = live.get(id)
    if (entry === undefined) live.set(id, entry = { texts: [], shown: 0 })
    return entry
  }

  let activity = {}
  const activityOf = (tool) => {
    if (/^(message_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(tool)) return 'sending'
    if (tool === 'group_relay') return 'orbit'
    if (/search|fetch|browse|browser|read|grep|glob|list/i.test(tool)) return 'searching'
    return 'working'
  }
  const setActivity = (id, value) => {
    if (activity[id] === value) return
    const next = { ...activity }
    if (value === undefined) delete next[id]
    else next[id] = value
    activity = next
  }
  const showCall = (id, entry) => {
    const name = [...(entry.calls?.values() ?? [])].at(-1)?.name
    entry.tool = name
    if (name !== undefined) setActivity(id, name === 'ask_user' || name === 'show_view' ? undefined : activityOf(name))
    else if (entry.turn !== undefined) setActivity(id, 'thinking')
  }
  const startCall = (id, entry, callId, name, args) => {
    if (typeof callId === 'string') (entry.calls ??= new Map()).set(callId, { name, args })
    showCall(id, entry)
  }
  const endCall = (id, entry, callId) => {
    entry.calls?.delete(callId)
    showCall(id, entry)
  }

  const markExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ??= []
    if (!turns.includes(turn)) {
      turns.push(turn)
      if (turns.length > 400) turns.splice(0, turns.length - 400)
      void rt.save().catch(() => {})
    }
  }
  const unmarkExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ?? []
    if (!turns.includes(turn)) return
    state.exchangeTurns[sessionId] = turns.filter(other => other !== turn)
    void rt.save().catch(() => {})
  }

  const speaksInGroup = (id, info) => rt.groupOwners.has(id) && !(info !== undefined && expectsReply(info))

  const showSteps = (id, entry, upTo) => {
    const info = entry.info
    if (entry.suppressedSubagent || !speaksInGroup(id, info) || (info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))) return
    for (; entry.shown < upTo; entry.shown += 1) {
      const text = stripWrittenCalls(entry.texts[entry.shown])
      if (text !== '') void rt.roomStepText?.(id, info, text, entry.shown === 0)?.catch(error => rt.warn('ds-bot: step text from %s not posted: %s', id, error))
    }
  }

  async function releaseBot(botId, sessionIds) {
    const text = `${rt.botOf(botId)?.name ?? 'The other Bot'} was deleted before it could answer your message.`
    const waiting = new Map()
    for (const id of sessionIds) {
      await stopSubagents(id)
      const entry = live.get(id)
      const held = [entry?.info, entry?.pending, ...(entry?.joined ?? []).map(joined => joined.info)]
      if (entry?.turn !== undefined) {
        const agent = await rt.resolveAgent(id).catch(() => undefined)
        held.push(...[...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].map(message => message.source))
      }
      for (const source of held) {
        if (source?.kind === SOURCE_KIND && expectsReply(source) && !answersUser(source)) waiting.set(source.exchangeId, [id, source])
      }
      live.delete(id)
      setActivity(id, undefined)
    }
    for (const source of rt.forgetBotWork?.(botId) ?? []) {
      if (!waiting.has(source.exchangeId)) waiting.set(source.exchangeId, [rt.chatOf(botId), source])
    }
    for (const [id, source] of waiting.values()) settlement.answerSender(id, source, text)
  }

  const claimTrigger = (sessionId, entry, info) => {
    entry.info = info
    if (Array.isArray(info.joined) && info.joined.length > 0) {
      entry.joined = info.joined.filter(item => item?.info !== undefined && item.info !== null)
    }
    if (rt.groupOwners.has(sessionId)) return
    if ((expectsReply(info) && !answersUser(info)) || info.role === 'room' || (info.role === 'handoff' && info.resume !== true)) {
      markExchangeTurn(sessionId, entry.turn)
    }
  }

  const activityView = () => {
    const merged = {}
    for (const [id, value] of Object.entries(activity)) {
      if (!rt.groupOwners.has(id)) merged[rt.chatOwners.get(id) ?? id] = value
    }
    for (const [id, value] of Object.entries(activity)) {
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined) merged[owner.botId] ??= value
    }
    for (const [id, map] of subagentsByParent) {
      if (map.size === 0) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId !== undefined) merged[botId] ??= 'working'
    }
    for (const job of rt.switchJobs()) {
      if (job.roomId === undefined) merged[job.botId] = 'thinking'
      else merged[job.botId ?? job.roomId] ??= 'thinking'
    }
    for (const approval of rt.approvalsView?.() ?? []) merged[approval.botId] = 'alert'
    for (const botId of Object.keys(rt.waitingView?.() ?? {})) merged[botId] ??= 'waiting'
    return merged
  }

  const doingOf = (entry) => {
    const call = [...(entry.calls?.values() ?? [])].at(-1)
    if (call === undefined) return {}
    const said = entry.step?.replace(/\s+/g, ' ').trim().slice(0, 160)
    let args
    try { args = JSON.parse(call.args || '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')?.replace(/\s+/g, ' ').trim()
    const note = first(['description', 'justification'])
    const path = first(['file_path', 'path'])
    const url = first(['url'])
    let site
    try { site = url && new URL(url).host } catch { site = undefined }
    const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site
    return { tool: call.name, ...(said ? { said } : {}), ...(note ? { note: note.slice(0, 120) } : {}), ...(target ? { target: target.slice(0, 80) } : {}) }
  }

  const workView = () => {
    const bots = {}
    for (const [id, entry] of live) {
      if (entry.turn === undefined) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined || (owner !== undefined && bots[botId] !== undefined)) continue
      bots[botId] = { since: entry.since, ...doingOf(entry), ...(owner ? { roomId: owner.roomId } : {}) }
    }
    for (const [id] of subagentsByParent) {
      const sub = subagentDoingOf(id)
      if (sub === undefined) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined || bots[botId] !== undefined) continue
      bots[botId] = { ...sub, ...(owner ? { roomId: owner.roomId } : {}) }
    }
    for (const job of rt.switchJobs()) {
      if (job.botId === undefined) continue
      const work = { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.roomId ? { roomId: job.roomId } : {}) }
      if (job.roomId === undefined) bots[job.botId] = work
      else bots[job.botId] ??= work
    }
    return bots
  }

  const turnsView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.since !== undefined)
    .map(([id, entry]) => [id, entry.since]))

  const steeredView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.steeredAt !== undefined)
    .map(([id, entry]) => [id, entry.steeredAt]))

  const roomWorkView = () => {
    const speaking = new Set([...roomProgress.values()].flatMap(round => round.slots
      .filter(slot => slot.status === 'speaking').map(slot => `${round.roomId}:${slot.id}`)))
    const rooms = {}
    const add = (roomId, botId, work) => {
      if (rooms[roomId]?.some(item => item.botId === botId)) return
      rooms[roomId] = [...(rooms[roomId] ?? []), { botId, ...work, ...(speaking.has(`${roomId}:${botId}`) ? { speaking: true } : {}) }]
    }
    for (const [id, entry] of live) {
      const owner = rt.groupOwners.get(id)
      if (entry.turn !== undefined && owner !== undefined) add(owner.roomId, owner.botId, { since: entry.since, ...doingOf(entry) })
    }
    for (const [id] of subagentsByParent) {
      const owner = rt.groupOwners.get(id)
      const sub = owner !== undefined ? subagentDoingOf(id) : undefined
      if (sub !== undefined) add(owner.roomId, owner.botId, sub)
    }
    for (const job of rt.switchJobs()) {
      if (job.roomId !== undefined) add(job.roomId, job.botId, { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.botId === undefined ? { self: true } : {}) })
    }
    return rooms
  }

  const callDetail = (sessionId, callId) => {
    let args
    try { args = JSON.parse(live.get(sessionId)?.calls?.get(callId)?.args ?? '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')
    const text = first(['description', 'justification'])
    const code = first(['command', 'cmd', 'file_path', 'path', 'url', 'query'])
    return { ...(text ? { text: text.trim().slice(0, 300) } : {}), ...(code ? { code: code.trim().slice(0, 400) } : {}) }
  }

  const placeOf = (id) => {
    const room = rt.roomOf(rt.groupOwners.get(id)?.roomId) ?? rt.roomOf(id)
    return room ? `group "${room.name}"` : 'own chat'
  }
  const noteTurnFailure = (id, failure) => {
    rt.noteFailure({
      source: 'turn',
      text: failure.message || 'the model call failed',
      code: failure.code,
      status: failure.status,
      requestId: failure.requestId,
      bot: rt.botOf(rt.selfOf(id))?.name ?? (rt.roomOf(id) ? undefined : 'unknown Bot'),
      where: placeOf(id),
      sessionId: id,
    })
  }

  // The repair card reads DSH's own failure row, which can carry a code DS Bot has
  // corrected (a 403 content audit arrives as AUTH). Keep the corrected failure with
  // the part and turn it belongs to; the view sends it to the card, and the next
  // completed turn in that part drops it.
  const rememberFailure = (id, turn, failure, session) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot === undefined || turn === undefined) return
    const provider = session?.requestHeader?.()?.config?.provider
    const message = failure.message ? cleanText(failure.message, { redact: rt.redactSecrets }).slice(0, 500) : ''
    const failures = bot.failures ??= {}
    failures[id] = { turn, ...failure, message, ...(provider ? { provider } : {}), at: Date.now() }
    const keys = Object.keys(failures)
    if (keys.length > 6) {
      for (const key of keys.sort((a, b) => (failures[a].at ?? 0) - (failures[b].at ?? 0)).slice(0, keys.length - 6)) delete failures[key]
    }
    void rt.save().catch(() => {})
  }
  const forgetFailure = (id) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot?.failures?.[id] === undefined) return
    delete bot.failures[id]
    if (Object.keys(bot.failures).length === 0) delete bot.failures
    void rt.save().catch(() => {})
  }

  const noteCutOffTurn = (id, { session, wroteNothing, outputTokens }: { session?: any, wroteNothing?: any, outputTokens?: any }) => {
    const route = session.requestHeader?.()?.config
    const ref = route?.provider && route?.model ? `${route.provider}/${route.model}` : undefined
    settlement.recordCutOff(id, {
      wroteNothing: Boolean(wroteNothing),
      ref,
      tokensIn: rt.sessionTokens?.(session),
      outputTokens,
    })
  }

  const blockBot = (id, session, failure) => {
    const bot = rt.botOf(rt.selfOf(id))
    if (bot === undefined || !BLOCKING_CODES.has(failure.code)) return false
    const provider = session?.requestHeader?.()?.config?.provider ?? splitRef(bot.appliedModel)?.provider
    bot.blocked = {
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(provider ? { provider } : {}),
      at: Date.now(),
    }
    void rt.save().catch(() => {})
    return true
  }
  const unblockBot = (botId) => {
    const bot = rt.botOf(botId)
    if (bot?.blocked === undefined) return
    delete bot.blocked
    void rt.save().catch(() => {})
  }

  function unblockBots({ ref, signedIn = false, keyed }: Record<string, any> = {}) {
    if (rt.readOnly?.() !== undefined) return
    let refs
    try { refs = ref === undefined ? undefined : rt.keyRefs?.() } catch {}
    const fixes = ({ code, provider }) => (signedIn && SIGN_IN_CODES.has(code))
      || (ref !== undefined && KEY_CODES.has(code) && (refs?.get(provider) ?? ref) === ref)
      || (code === 'MISSING_CREDENTIAL' && provider !== undefined && keyed?.has(provider) === true)
    const lifted = (Object.values(state.bots ?? {}) as any[]).filter(bot => bot.blocked !== undefined && fixes(bot.blocked))
    if (lifted.length === 0) return
    for (const bot of lifted) delete bot.blocked
    void rt.save().catch(() => {})
    for (const bot of lifted) void rt.releaseKickoff(bot).catch(error => rt.warn('ds-bot: greeting of %s not sent again: %s', bot.name, error))
  }

  async function resumeBot(bot) {
    if (await rt.releaseKickoff(bot)) return
    if (rt.greetingOut?.(bot.id) || live.get(rt.chatOf(bot.id))?.turn !== undefined) return
    const code = bot.blocked?.code
    await rt.dispatch.sendNotice({
      toId: bot.id,
      role: 'continue',
      text: `Your last turn failed${code ? ` (${code})` : ''} and the user has fixed it. Answer the user's last unanswered message.`,
    })
  }
  ctx.on?.('subagent/start', (info) => {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '' || stoppedSubagents.has(childId)) return
    const parentId = subagentParent.get(childId)
      ?? ctx.get?.('agents')?.get?.(childId)?.session?.header?.parentSession
      ?? [...live.entries()].find(([, entry]) => [...(entry.calls?.values() ?? [])].some(call => call.name === 'subagent'))?.[0]
    if (parentId === undefined) return
    notedSubagentFailures.delete(childId)
    noteSubagentStart(parentId, childId, undefined)
  })
  ctx.on?.('subagent/end', function (info) {
    const parentId = carrierKeyOf(this)?.session?.id ?? subagentParent.get(info?.id)
    const helper = subagentsByParent.get(parentId)?.get(info?.id)?.label ?? endedSubagentLabels.get(info?.id)
    noteSubagentEnd(info?.id)
    endedSubagentLabels.delete(info?.id)
    const owner = rt.groupOwners.get(parentId)
    if (owner === undefined) return
    if (typeof info?.stopReason === 'string' && info.stopReason !== 'completed'
      && !stoppedSubagentParents.has(parentId) && !stoppedSubagents.has(info.id)) {
      noteSubagentFailure(parentId, info.id, { stopReason: info.stopReason, helper, closing: textOf(info?.lastAssistantMessage) })
    }
  })

  const laterTarget = (id) => {
    if (rt.chatOwners.has(id)) return id
    const group = rt.groupOwners.get(id)
    if (group !== undefined) return rt.roomOf(group.roomId)?.sessions?.[group.botId]
    const past = rt.pastOwners?.get(id)
    if (past !== undefined) {
      if (past.roomId !== undefined) return rt.roomOf(past.roomId)?.sessions?.[past.botId]
      const bot = rt.botOf(past.botId)
      return bot === undefined ? undefined : (threadCurrentOfPart(bot, id) ?? rt.chatOf?.(past.botId))
    }
    return undefined
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    const switchedEnd = event.type === 'turn/end' && live.get(id)?.switched === true && rt.pastOwners?.has(id)
    if (!rt.isBotSession(id) && !rt.roomOf(id) && !switchedEnd) {
      if (live.delete(id)) setActivity(id, undefined)
      return
    }
    const entry = liveOf(id)
    if (rt.groupOwners.has(id)) rt.touchRoomTurn?.(id)
    switch (event.type) {
      case 'subagent/catalog': {
        const childId = event.data?.childId
        const label = typeof event.data?.label === 'string' ? event.data.label.trim() : undefined
        noteSubagentStart(id, childId, label, event.time ?? Date.now())
        break
      }
      case 'tool/call': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.callId, name, String(event.data?.arguments ?? ''))
        if (name !== PROGRAM_TOOL) {
          entry.toolCount = (entry.toolCount ?? 0) + 1
          if (rt.groupOwners.has(id)) rt.workRoomTurn?.(id, name)
        }
        break
      }
      case 'tool/ptc-dispatch-start': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.subCallId, name, JSON.stringify(event.data?.arguments ?? {}))
        entry.toolCount = (entry.toolCount ?? 0) + 1
        if (rt.groupOwners.has(id)) rt.workRoomTurn?.(id, name)
        break
      }
      case 'tool/ptc-dispatch':
        endCall(id, entry, event.data?.subCallId)
        break
      case 'tool/result':
        endCall(id, entry, event.data?.callId)
        break
      case 'turn/start':
        setActivity(id, 'thinking')
        entry.turn = event.data.turn
        entry.since = event.time ?? Date.now()
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.info = undefined
        entry.toolCount = 0
        entry.usage = undefined
        entry.suppressedSubagent = false
        entry.switched = false
        entry.answers = false
        entry.opened = false
        entry.joined = []
        entry.later = []
        entry.steeredAt = undefined
        entry.carried = false
        let claimedPending
        let claimedPendingText
        if (entry.pending !== undefined) {
          claimedPending = entry.pending
          claimedPendingText = entry.pendingText
          claimTrigger(id, entry, claimedPending)
          entry.pending = undefined
          entry.pendingText = undefined
        }
        if (entry.carry !== undefined) {
          const carry = entry.carry
          entry.carry = undefined
          entry.texts = carry.texts
          entry.shown = carry.shown
          entry.answers = carry.answers
          entry.joined = carry.joined
          entry.later = carry.later
          entry.toolCount = carry.toolCount ?? 0
          entry.opened = true
          entry.carried = true
          if (carry.info !== undefined) claimTrigger(id, entry, carry.info)
          entry.joined = carry.joined
          if (carry.info !== undefined && claimedPending !== undefined
            && claimedPending.exchangeId !== carry.info.exchangeId
            && (expectsReply(claimedPending) || claimedPending.role === 'room') && !answersUser(claimedPending)) {
            entry.joined = [...carry.joined, { info: claimedPending, text: claimedPendingText }]
          }
        }
        break
      case 'user/message': {
        const source = event.data?.source
        if (source?.kind === 'user' && typeof source.rpcId === 'string') noteHeard(id, source.rpcId)
        if (source?.kind === SOURCE_KIND && source.role === 'room' && Array.isArray(source.requests)) {
          for (const requestId of source.requests) noteHeard(id, requestId)
        }
        if (source?.kind === 'subagent-settled' || source?.kind === 'agent-message') {
          const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
          // Only settlement ends a child's turn; an intermediate `agent-message` keeps the
          // child active and preserves its label until it actually settles.
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            noteSubagentEnd(childId)
          }
          if (stoppedSubagentParents.has(id) || (childId !== undefined && stoppedSubagents.has(childId))) {
            entry.suppressedSubagent = true
            void rt.resolveAgent(id).then(agent => agent?.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })).catch(() => {})
            break
          }
          if (source.kind === 'subagent-settled' && childId !== undefined) {
            const stopReason = noticeStopReason(source, event.data?.content)
            const label = endedSubagentLabels.get(childId)
            endedSubagentLabels.delete(childId)
            if (stopReason !== undefined && rt.groupOwners.has(id)) noteSubagentFailure(id, childId, { stopReason, helper: label })
          }
        } else if (source?.kind === 'user' || source?.kind === SOURCE_KIND) {
          stoppedSubagentParents.delete(id)
        }
        if (source?.kind === SOURCE_KIND && source.work !== undefined && source.replyTo !== undefined) rt.takenWork?.(source.work, source.replyTo)
        const bare = info => info?.handoff === true && info.resume !== true
        const opened = entry.opened === true
        if (entry.turn !== undefined && !bare(source)
          && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === 'schedule' || source?.kind === SOURCE_KIND)) {
          entry.opened = true
        }
        if (entry.turn !== undefined && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === SOURCE_KIND)) {
          if (bare(source)) {
            if (entry.answers) break
          } else {
            entry.answers = true
            if (bare(entry.info)) {
              unmarkExchangeTurn(id, entry.turn)
              entry.info = undefined
            }
          }
        }
        if (source?.kind === SOURCE_KIND && source.role === 'post' && rt.roomOf(id)) {
          const files = (Array.isArray(event.data.content) ? event.data.content : []).filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
          queueRoomMessage(rt.roomOf(id).id, {
            text: textOf(event.data.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(files.length > 0 ? { files } : {}),
            botId: source.senderSessionId,
            name: source.senderName,
            reportBack: source.reportBack === true,
            ...(source.claims === undefined ? {} : { claims: source.claims }),
            ...(source.changes === undefined ? {} : { changes: source.changes }),
            ...(source.member ? { member: true } : {}),
            ...(source.mentions ? { mentions: source.mentions } : {}),
            ...(source.sub ? { sub: source.sub } : {}),
            ...(source.late ? { late: true } : {}),
            ...(source.progress ? { progress: true } : {}),
            ...(source.quiet ? { quiet: true } : {}),
            ...(source.failed ? { failed: source.failed } : {}),
            ...(source.resumed ? { resumed: true } : {}),
            ...(source.again ? { again: true } : {}),
            ...(source.stopped ? { stopped: true } : {}),
            ...(source.done ? { done: true } : {}),
            ...(source.askedBy ? { askedBy: source.askedBy } : {}),
            ...(source.batch ? { batch: source.batch } : {}),
            ...(source.batchEnd ? { batchEnd: true } : {}),
            ...(source.fromRoomId ? { fromRoomId: source.fromRoomId } : {}),
            ...(source.logged !== undefined ? { logged: source.logged } : {}),
            ...(source.called ? { called: true } : {}),
          })
        } else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
          queueRoomMessage(rt.roomOf(id).id, { text: '', kickoff: true })
        } else if (source?.kind === SOURCE_KIND) {
          if (entry.turn === undefined) {
            entry.pending = source
            entry.pendingText = textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
          }
          else if (!opened) claimTrigger(id, entry, source)
          else if (source.work !== undefined && source.work !== rt.workOf?.(entry.info) && !expectsReply(source)) {
            entry.later = [...(entry.later ?? []), { info: source, text: textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '') }]
          } else if ((expectsReply(source) || source.role === 'room') && !answersUser(source)
            && source.exchangeId !== entry.info?.exchangeId
            && !(entry.joined ?? []).some(joined => joined.info.exchangeId === source.exchangeId)) {
            const text = textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
            entry.joined = [...(entry.joined ?? []), { info: source, text }]
          }
          // A mid-turn relay that owes no reply only informs the turn: it neither
          // claims the running turn nor queues as the next one's trigger.
        } else if (source?.kind === 'schedule' && rt.roomOf(id)) {
          queueRoomMessage(rt.roomOf(id).id, { text: reminderText(textOf(event.data.content)) })
        } else if (source?.kind === REFERENCE_KIND && rt.roomOf(id)) {
          attachReference(roomInbox.get(rt.roomOf(id).id), source, textOf(event.data.content))
        } else if (source?.kind === 'subagent-settled') {
          const run = rt.subWorkRun?.(source.senderSessionId)
          if (run !== undefined) {
            rt.takenWork?.(run.parent, run.id)
            const info = { kind: SOURCE_KIND, role: 'reply', work: run.parent, replyTo: run.id, exchangeId: run.id, senderSessionId: source.senderSessionId }
            if (entry.turn === undefined) entry.pending = info
            else if (entry.info === undefined && !opened) {
              // DSH opens the turn before it records the message that filled its
              // inbox: a notice that opened the turn claims it, like the first
              // relay of a turn.
              entry.opened = true
              entry.answers = true
              claimTrigger(id, entry, info)
            } else if (rt.workOf?.(entry.info) !== run.parent) entry.later = [...(entry.later ?? []), { info, text: textOf(event.data.content) }]
          }
        } else if (source?.kind === 'user' || source?.kind === REPLY_KIND) {
          if (rt.roomOf(id) && source.kind === 'user') {
            const content = Array.isArray(event.data.content) ? event.data.content : []
            const images = content.filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
            const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
            queueRoomMessage(rt.roomOf(id).id, { text: textOf(event.data.content), ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}), ...(viaOf(source) ? { via: viaOf(source) } : {}), ...(typeof source.rpcId === 'string' ? { request: source.rpcId } : {}) })
          }
          const own = rt.chatOwners.get(id)
          if (own !== undefined) rt.userWrote(own)
          let dropped = false
          if (state.questions[id] !== undefined) {
            rt.closeCard(id, state.questions[id], 'replied')
            delete state.questions[id]
            dropped = true
          }
          if (state.views?.[id] !== undefined) {
            rt.closeCard(id, state.views[id], 'replied')
            delete state.views[id]
            dropped = true
          }
          if (dropped) void rt.save().catch(() => {})
        }
        break
      }
      case 'agent/inbox/spliced':
        if (rt.roomOf(id)) rt.nudgeRoom?.(rt.roomOf(id).id)
        if (stoppedSubagentParents.has(id)) {
          for (const inserted of event.data?.inserted ?? []) {
            if (inserted?.source?.kind === 'subagent-settled' || stoppedSubagents.has(inserted?.source?.senderSessionId)) {
              void rt.resolveAgent(id).then(agent => agent?.inbox?.remove(inserted.id)).catch(() => {})
            }
          }
        }
        if (event.data?.target === 'next-step' && entry.turn !== undefined
          && (event.data.inserted ?? []).some(message => message?.source?.kind === 'user')) {
          entry.steeredAt = event.time ?? Date.now()
        }
        break
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content)
        const called = Array.isArray(content) && content.some(block => block?.type === 'tool-call')
        const messageUsage = event.data?.usage ?? usageChunk(event.data?.stream)
        if (messageUsage !== undefined) entry.usage = messageUsage
        if (text !== '' && text !== HANDOFF_ACK) {
          entry.texts.push(absoluteLinks(text, rt.sessionFolder?.(session)))
          if (entry.turn !== undefined) showSteps(id, entry, called ? entry.texts.length : entry.texts.length - 1)
        }
        entry.lastText = text
        entry.lastCalled = called
        entry.step = called && text !== HANDOFF_ACK ? stripWrittenCalls(text) || undefined : undefined
        break
      }
      case 'turn/end': {
        setActivity(id, undefined)
        const cut = entry.cut
        entry.cut = undefined
        const steerCut = cut !== undefined && event.data?.reason?.kind === 'aborted'
          && event.data.reason.reason?.kind === 'hook' && event.data.reason.reason.reason === STEER_CUT
        if (steerCut) {
          entry.carry = { info: entry.info, joined: entry.joined ?? [], later: entry.later ?? [], texts: entry.texts.slice(0, cut.texts), shown: entry.shown, answers: entry.answers, toolCount: entry.toolCount ?? 0 }
        }
        const info = entry.info
        const joined = entry.joined ?? []
        const texts = entry.texts.slice(entry.shown)
        const wroteText = entry.texts.length > 0
        const shown = entry.shown > 0 || (info?.retried === true && promisedOpenings.delete(info.exchangeId))
        const { lastText, lastCalled } = entry
        const usage = entry.usage
        const toolCount = entry.toolCount ?? 0
        const suppressedSubagent = entry.suppressedSubagent === true
        const switched = entry.switched === true
        const watched = entry.turn !== undefined
        const turn = entry.turn
        const said = entry.texts
        const began = entry.since
        entry.turn = undefined
        entry.info = undefined
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.toolCount = 0
        entry.suppressedSubagent = false
        entry.switched = false
        entry.joined = []
        entry.since = undefined
        entry.steeredAt = undefined
        entry.tool = undefined
        entry.calls = undefined
        entry.lastText = undefined
        entry.lastCalled = undefined
        entry.usage = undefined
        const later = entry.later ?? []
        entry.later = []
        if (steerCut || suppressedSubagent) break
        for (const result of later) {
          const targetSessionId = laterTarget(id)
          if (targetSessionId === undefined && (rt.groupOwners.has(id) || rt.pastOwners?.has(id))) continue
          void rt.dispatch.sendReply({
            fromId: result.info.senderSessionId,
            toId: rt.selfOf(id),
            ...(targetSessionId !== undefined ? { sessionId: targetSessionId } : {}),
            text: result.text,
            role: result.info.role,
            exchangeId: result.info.exchangeId,
            replyTo: result.info.replyTo,
            work: result.info.work,
            ...(result.info.roomId ? { roomId: result.info.roomId } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: handing back a result failed: %s', error))
        }
        const reason = event.data?.reason
        const failure = reason?.kind === 'error' && !switched ? turnFailure(reason.error) : undefined
        if (failure !== undefined) noteTurnFailure(id, failure)
        if (failure?.code === 'HOSTED_ENGINE_ROUTE') {
          const config = session.requestHeader?.()?.config
          const ref = config?.provider && config?.model ? `${config.provider}/${config.model}` : undefined
          if (ref !== undefined) void rt.routeRefused(ref, rt.botOf(rt.selfOf(id))).catch(error => rt.warn('ds-bot: %s still failing: %s', ref, error))
        }
        const held = rt.groupOwners.has(id) ? rt.takeRoomSteps?.(id) ?? '' : ''
        if (switched) break
        const owner = rt.chatOwners.get(id)
        const cutOff = watched && failure === undefined && reason?.kind === 'max-tokens'
        const route = session.requestHeader?.()?.config
        const outputTokens = Number(usage?.outputTokens)
        const usedBudget = Number.isFinite(outputTokens) && Number(route?.maxTokens) > 0 && outputTokens >= Number(route.maxTokens)
        const wroteNothing = cutOff && !wroteText && !usedBudget
        const premature = cutOff && prematureCutOff(usage, route)
        rt.noteCutOffTurn?.(id, { withoutText: wroteNothing, premature })
        if (cutOff) noteCutOffTurn(id, { session, wroteNothing, ...(premature ? { outputTokens } : {}) })
        if (failure !== undefined) {
          if (watched) rememberFailure(id, turn, failure, session)
          if (blockBot(id, session, failure) && owner !== undefined && info?.role === 'kickoff') rt.holdKickoffAgain(owner)
        } else if (reason?.kind === 'completed') {
          forgetFailure(id)
          unblockBot(rt.selfOf(id))
          if (owner !== undefined && (info === undefined || info.role === 'continue')) rt.userAnswered(owner)
        }
        const wroteCall = failure === undefined && reason?.kind === 'completed' && lastCalled !== true && writesToolCall(lastText)
        const promisedOnly = !wroteCall && failure === undefined && reason?.kind === 'completed'
          && toolCount === 0 && lastCalled !== true && info?.role === 'room'
          && promisesWork(lastText) && !rt.callsRoomMember?.(id, info, lastText)
        const retry = (wroteCall || promisedOnly) && info?.retried !== true && !(info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))
        if (retry) {
          if (promisedOnly) {
            const opening = stripWrittenCalls(lastText ?? '')
            if (opening !== '') {
              rememberStopped(promisedOpenings, info.exchangeId)
              void rt.roomStepText?.(id, info, opening, !shown)?.catch(() => {})
            }
            roomWaiters.get(info.exchangeId)?.touch()
            void retryPromisedWork(id, info).catch(error => rt.warn('ds-bot: asking %s to run its promised work failed: %s', id, error))
          } else {
            void retryWrittenCall(id, info).catch(error => rt.warn('ds-bot: asking %s to run its written tool call failed: %s', id, error))
          }
        }
        if (watched && !retry && failure === undefined && reason?.kind === 'completed') {
          const roomId = rt.groupOwners.get(id)?.roomId
          const cardId = roomId === undefined ? rt.cardOfSession?.(id) : undefined
          const toUser = roomId !== undefined || cardId !== undefined || (owner !== undefined && (info === undefined || info.role === 'continue'))
          const text = (wroteCall ? said.map(stripWrittenCalls) : said).join('\n\n').trim()
          if (toUser && text !== '') {
            const heard = takeHeard(id)
            rt.botReplied?.({ botId: rt.selfOf(id), ...(roomId === undefined ? {} : { roomId }), ...(cardId === undefined ? {} : { cardId, sessionId: id }), text, since: began ?? Date.now(), ...(heard.length > 0 ? { heard } : {}) })
          }
        }
        rt.cardTurnEnded?.()
        const replyText = () => {
          const reply = (wroteCall ? texts.map(stripWrittenCalls) : texts).join('\n\n').trim()
          if (wroteCall && reply === '') return 'Tried to run a tool but wrote the call as text, so it did not run.'
          if (cutOff) return reply === '' && wroteText ? CUT_OFF_NOTE : cutOffText(reply)
          return reply
        }
        const groupReply = () => rt.withRoomSteps?.(held, replyText()) ?? replyText()
        const aborted = reason?.kind === 'aborted'
        if (!retry && info?.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          const stopped = stoppedRoomTurns.delete(info.exchangeId)
          if (waiter !== undefined) {
            if (failure !== undefined) waiter.fail(failure)
            else waiter.resolve(aborted ? null : groupReply())
          } else if (!stopped && !aborted) {
            if (failure !== undefined) void rt.lateRoomFailure?.(id, info, failure)
            else void rt.lateRoomReply?.(id, info, groupReply(), { shown, toolCount })
          }
        } else if (!retry && speaksInGroup(id, info)) {
          // A turn that failed before it took any input (DSH can turn it down before its
          // first step) never names its call, so the call waiting on this Session fails.
          const inRound = failure !== undefined && info === undefined && rt.failRoomTurn?.(id, failure) === true
          if (failure !== undefined) { if (!inRound) void rt.lateRoomFailure?.(id, info ?? {}, failure) }
          else if (!aborted) void rt.lateRoomReply?.(id, info ?? {}, groupReply(), { shown, toolCount })
        } else if (!retry && info !== undefined) {
          void settlement.settle(id, info, { reply: replyText(), failure, aborted })
        }
        for (const request of joined) {
          if (request.info.role === 'room' && stoppedRoomTurns.delete(request.info.exchangeId)) continue
          if (failure !== undefined || aborted) {
            if (request.info.role === 'room') {
              if (failure !== undefined) void rt.lateRoomFailure?.(id, request.info, failure)
            } else settlement.settleDirect(id, request.info, { reply: '', failure, aborted })
            continue
          }
          void rt.dispatch.sendReply({
            fromId: request.info.senderSessionId,
            toId: rt.selfOf(id),
            sessionId: id,
            text: request.text,
            role: request.info.role,
            exchangeId: request.info.exchangeId,
            ...(request.info.role === 'room' ? { roomId: request.info.roomId, askedBy: request.info.askedBy, note: 'you read this call during your last task; answer it now' } : {}),
            ...(request.info.senderRoomId ? { fromRoomId: request.info.senderRoomId } : {}),
            ...(request.info.senderPart ? { fromPart: request.info.senderPart } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: deferred request delivery failed: %s', error))
        }
        break

      }
    }
  })

  // A subagent a Bot's turn delegates to is work handed on, like message_bot: each
  // run of the child hangs under the work the turn answers until its settlement
  // notice comes back, and its closing message joins that work's results. A child
  // can be sent more to do once it settled, and that is a fresh run on the same
  // child id, so the run — not the child — is the sub-work. These are Cordis
  // events, not Session events: the dispatch keys `this` by the delegating parent
  // Agent, which `carrierKeyOf` hands back.
  ctx.on('subagent/start', function (info) {
    const id = carrierKeyOf(this)?.session?.id
    const entry = id === undefined ? undefined : live.get(id)
    const work = rt.workOf?.(entry?.info)
    const self = id === undefined ? undefined : rt.selfOf(id)
    if (work === undefined || self === undefined || !rt.chatOwners.has(id) || typeof info?.id !== 'string' || typeof info?.runId !== 'string' || !rt.ownsWork?.(self, work)) return
    rt.openWork?.(info.runId, { from: self, parent: work, name: 'subagent', child: info.id })
  })
  ctx.on('subagent/end', (info) => {
    if (typeof info?.id !== 'string') return
    rt.settleSubWork?.(typeof info.runId === 'string' ? info.runId : info.id, subEndText(info), info.id)
  })
  ctx.on('tools/result', (exec, result) => {
    if (!SUBAGENT_TOOLS.has(exec?.name) || result?.isError || typeof result?.value?.subagentId !== 'string') return
    const description = exec.arguments?.description
    rt.nameSubWork?.(result.value.subagentId, `subagent${typeof description === 'string' && description.trim() !== '' ? ` ${description.trim()}` : ''}`)
  })

  const markSteerCut = (id) => {
    const entry = live.get(id)
    if (entry?.turn !== undefined) entry.cut = { texts: entry.texts.length }
  }

  // DSH's prompt admission wraps any unexpected failure as 'session/agent-busy' and
  // keeps the real cause in details.reason, which the window never shows and the log
  // never saw (#424). For a Session this team owns, the reason is written to the
  // diagnostics and put into the error the user reads.
  const prompt = ctx.sessionController?.prompt
  if (typeof prompt === 'function') {
    const controller = ctx.sessionController
    const admitted = async function (request, ...rest) {
      try {
        return await prompt.call(this, request, ...rest)
      } catch (error) {
        const id = request?.sessionId
        if (id === undefined || (rt.roomOf(id) === undefined && !rt.isBotSession(id))) throw error
        const reason = typeof error?.details?.reason === 'string' && error.details.reason !== ''
          ? cleanText(error.details.reason, { redact: rt.redactSecrets })
          : undefined
        rt.noteFailure({
          source: 'prompt',
          text: `prompt rejected for ${placeOf(id)}${reason === undefined ? '' : `: ${reason}`}`,
          code: error?.code,
          where: placeOf(id),
          sessionId: id,
        })
        // The gateway passes a RemoteError's code and details on as they are, but
        // wraps a fresh plain Error as 'gateway/internal': the reason is written on
        // the rejection itself, keeping its identity.
        if (reason !== undefined) {
          error.message = `${error?.message ?? 'prompt rejected'} — ${reason}`
          error.details = { ...error.details, reason }
        }
        throw error
      }
    }
    ctx.effect(() => {
      controller.prompt = admitted
      return () => { if (controller.prompt === admitted) controller.prompt = prompt }
    }, 'ds-bot: prompt rejection reasons')
  }

  Object.assign(rt, { live, liveOf, roomWaiters, roomProgress, roomInbox, activityView, workView, roomWorkView, turnsView, steeredView, callDetail, doingOf, stopRoomTurn, stopChat, releaseBot, unblockBots, resumeBot, markSteerCut, hasSubagents, stopSubagents, adoptLiveWork })
}
