import { randomUUID } from 'node:crypto'
import { claimsFor } from './claims.ts'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from './tool-schema.ts'
import { GROUP_LINE_READ, LATE_ANSWER, ROOM_IDLE_RELAY_LIMIT, ROOM_REPLY_TIMEOUT_MS, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS, SOURCE_KIND, TEAM_TOOLS, TEXT_KEPT } from './constants.ts'
import { escapeRegExp, headOf, splitRef, textOf } from './text.ts'
import { viaOf } from '../shared/im-platforms.ts'
import { mentionSpans, speakerOf } from '../shared/mentions.ts'
import { GROUP_REF, output } from './tools.ts'
import { searchGroupBook } from './group-search.ts'
import { ensureSessionIndex } from './session-index.ts'
import { failureLine } from './turns.ts'
import { parseBook } from './ledger.ts'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8

const IDLE_ACK_WORDS = "收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|好嘞|行|ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack|done|all\\s+good|sounds\\s+good"
const IDLE_STATUS_WORDS = [
  '(?:收口)?(?:当前|目前|今日|今天)*(?:暂无|没有|无)+(?:待办|任务|新进展|新内容|进展|动作|变化|安排)',
  '待命', '保持待命', '继续待命', '原地待命', '静候', '静候下一步', '静候指令', '等候指令',
  '等待指令', '等待指示', '等待下一步', '等待安排', '等待新任务', '无事可做', '空转',
  'standby', 'standing\\s+by', 'idle', 'nothing\\s+(?:pending|to\\s+do|new)',
  'no\\s+pending\\s+(?:tasks?|work)', 'no\\s+new\\s+(?:work|tasks?|progress|updates?)',
  'no\\s+changes?', 'no\\s+updates?', 'waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)',
].join('|')
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')
const IDLE_TEXT_MAX = 45
const normalizeRelayBody = (text, everyone) => {
  let out = String(text ?? '')
  for (const bot of everyone) {
    out = out.replace(new RegExp(`@${escapeRegExp(bot.name)}\\b`, 'gi'), '')
    out = out.replaceAll(`@${bot.name}`, '')
  }
  return out.replace(/@(?:all|everyone|所有人|全体)/gi, '').replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ').trim().toLowerCase()
}
export const isIdleRelayText = (text, everyone, priorBodies) => {
  const norm = normalizeRelayBody(text, everyone)
  if (norm === '' || (norm.length <= IDLE_TEXT_MAX && IDLE_BODY.test(norm))) return true
  return priorBodies.some(prev => prev !== '' && (prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))))
}

const SHOWN_ONLY = new Set(['working', 'approval'])
const memberLine = record => record !== undefined && !SHOWN_ONLY.has(record.kind)

const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

const noticeText = (line) => {
  if (line.reason === 'missed') return `${(line.names ?? []).join(' and ')} did not answer within ${line.minutes} minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.`
  if (line.reason === 'paused' && line.idle && (line.names ?? []).length === 0) return `Paused: Bots here posted ${line.limit} status updates with no new work (no tool used, nobody called), the last from ${line.from ?? 'a member'}. The group answers no more of them until the user writes here; do not post again to start a round.`
  if (line.reason === 'paused' && line.idle) return `Paused: ${[line.from, ...(line.names ?? [])].filter(Boolean).join(' and ')} went back and forth ${line.limit} times without progress (no tool used, only thanks or repeats). The calls to @${(line.names ?? []).join(' and @')} wait until the user writes here; do not call them again.`
  if (line.reason === 'paused') return `Paused: Bots have called each other ${line.limit} times since the user last wrote here. The calls to @${(line.names ?? []).join(' and @')} wait until the user continues or writes here; do not call them again.`
  if (line.reason === 'admin-passed') return `${(line.names ?? []).join(' and ') || 'The admin'} did not answer or call anyone; call a member with @Name.`
  if (line.reason === 'folder') return `The group's folder ${line.path} is gone, so its members work in the team workspace; set the group's folder again in the group's settings.`
  if (line.reason === 'failed') return `${(line.names ?? []).join(' and ')} stopped: its model call failed (${line.detail}). What it was doing here is not finished; the user can switch its model in its settings or ask it to go on.`
  if (line.reason === 'helper-failed') return `${(line.names ?? []).join(' and ')}'s background helper did not finish: ${line.detail}. The work it was doing here is not finished; ask it to go on if it still matters.`
  return line.text ?? ''
}
export const lineText = (line, text = line.text) => {
  if (line.kind === 'lookup') return `[${speakerOf(line)} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${speakerOf(line)}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${speakerOf(line)}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${speakerOf(line)}'s work here]`
  if (line.kind === 'done') return `[${speakerOf(line)} finished the work it was asked for]`
  if (line.kind === 'notice') return `[${noticeText(line)}]`
  return `${speakerOf(line)}: ${text}`
}
const transcript = (lines, textOfLine = line => line.text) => lines.map(line => lineText(line, textOfLine(line))).join('\n')

export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

function mentionsOf(opener, everyone) {
  const saved = opener?.mentions
  if (saved === undefined || !Array.isArray(saved.ids)) return undefined
  const byId = new Map(everyone.map(bot => [bot.id, bot]))
  const found = []
  for (const id of saved.ids) {
    const bot = byId.get(id)
    if (bot !== undefined && !found.includes(bot)) found.push(bot)
  }
  return { all: saved.all === true, found }
}

export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_CALLS = 'Writing "@Name" calls that member at once, to answer or to do what you ask, as soon as your message is posted: call members before you start on your own part. Members called in one message start together and do not see each other\'s replies until they post, so when one needs another\'s result, call the first and ask it to call the next. When a member finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const slotLabel = (slot, self) => {
  if (slot.status === 'speaking') return slot === self ? `${slot.name} (you, now)` : `${slot.name} (answering now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = (room, routed) => [
  'You are this group\'s admin.',
  room.mode === 'admin' && !routed ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

const ROUTER_NOTE = 'You are the Main Bot: the user\'s plain messages in this group come to you first. Answer a quick question yourself. Hand a task on with board open (it reaches that Bot by itself), or call the member who should answer with @Name. Do not do the work yourself.'

const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

// DSH cannot open the Session at all: it is gone, or its stored log is corrupt. DSH
// reports a corrupt log only in the message of a generic failure.
const lostSession = error => error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`

export function install(rt) {
  const { ctx } = rt

  const bookOf = roomId => `group-${roomId}`
  const writes = () => rt.readOnly?.() === undefined

  const oldLogName = id => (/^[\w-]{1,128}$/.test(id) ? id : createHash('sha256').update(String(id)).digest('hex').slice(0, 32))
  rt.ledger.importer('group-', (book) => {
    const roomId = book.slice('group-'.length)
    const lines = new Map()
    for (const line of rt.roomOf(roomId)?.log ?? []) {
      if (!Number.isInteger(line?.seq)) continue
      const { length, ...rest } = line
      let text = rest.text
      if (length !== undefined) {
        try { text = readFileSync(join(rt.home, 'group-lines', roomId, `${line.seq}.txt`), 'utf8') } catch {}
      }
      lines.set(line.seq, { ...rest, ...(text === undefined ? {} : { text }) })
    }
    try {
      for (const line of parseBook(readFileSync(join(rt.home, 'group-logs', `${oldLogName(roomId)}.jsonl`), 'utf8'))) {
        if (Number.isInteger(line.seq)) lines.set(line.seq, line)
      }
    } catch {}
    return [...lines.values()].sort((a, b) => a.seq - b.seq)
  })

  const reconciled = new WeakSet()
  const ensureRoomLog = (room) => {
    if (typeof room.seq !== 'number') {
      room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
      room.seq = room.log.length
    }
    room.seen ??= {}
    if (!reconciled.has(room)) {
      reconciled.add(room)
      const ahead = rt.ledger.after(bookOf(room.id), room.seq)
      if (ahead.length > 0) {
        room.seq = Math.max(room.seq, ...ahead.map(record => record.seq))
        room.log = [...room.log, ...ahead.filter(memberLine).map(record => cutLine(record))].slice(-ROOM_LOG_MAX)
      }
    }
  }

  const memberText = room => (line) => {
    const whole = line.length === undefined ? line.text : rt.ledger.record(bookOf(room.id), line.seq)?.text
    if (whole === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const shown = headOf(whole, GROUP_LINE_READ)
    return whole.length > shown.length ? `${shown}… (cut; ${whole.length} characters in all)` : shown
  }

  const cutLine = (line, text = line.text ?? '') => {
    const kept = headOf(text, TEXT_KEPT)
    return kept.length === text.length ? line : { ...line, text: kept, length: text.length }
  }
  function keepGroupLine(roomId, line, text) {
    rt.ledger.open(bookOf(roomId))
    return cutLine(line, text)
  }

  function dropGroupLines(roomId) {
    rt.ledger.drop(bookOf(roomId))
    if (!writes()) return
    void rm(join(rt.home, 'group-lines', roomId), { recursive: true, force: true }).catch(() => {})
    void rm(join(rt.home, 'group-logs', `${oldLogName(roomId)}.jsonl`), { force: true }).catch(() => {})
  }

  const roomLineListeners = new Set<(...args: any[]) => void>()
  const say = (room, line) => {
    ensureRoomLog(room)
    room.seq += 1
    const record = { ...line, seq: room.seq, time: line.time ?? Date.now() }
    rt.ledger.append(bookOf(room.id), record)
    rt.roomLineAdded?.(room, record)
    if (!memberLine(record)) return record
    room.log = [...room.log, cutLine(record)].slice(-ROOM_LOG_MAX)
    for (const listener of roomLineListeners) {
      try { listener(room, record) } catch (error) { rt.warn('ds-bot: room line listener failed: %s', error) }
    }
    return record
  }

  function rowOf(record) {
    const botId = record.botId ?? record.about
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    const who = { botId, name: bot?.name ?? (record.kind === 'notice' ? record.names?.[0] : record.who), color: bot?.color }
    const time = record.time
    if (record.kind === undefined) {
      if (record.botId === undefined) return { kind: 'user', text: record.text, time, ...(record.via ? { via: record.via } : {}) }
      return { ...who, text: record.text, time, ...(record.duration === undefined ? {} : { duration: record.duration }), ...(record.claims === undefined ? {} : { claims: record.claims }), ...(record.changes === undefined ? {} : { changes: record.changes }) }
    }
    if (record.kind === 'lookup') return { kind: 'lookup', ...who, text: record.text, time }
    if (record.kind !== 'notice') return { kind: record.kind, ...who, time, ...(record.changes === undefined ? {} : { changes: record.changes }) }
    switch (record.reason) {
      case 'failed': return { kind: 'failed', ...who, code: record.code, ...(record.status ? { status: record.status } : {}), text: record.message ?? record.detail, time }
      case 'helper-failed': return { kind: 'helper-failed', ...who, ...(record.stopReason ? { stopReason: record.stopReason } : {}), ...(record.helper ? { helper: record.helper } : {}), text: record.detail, time }
      case 'missed': return { kind: 'missed', ...who, time }
      case 'admin-passed': return { kind: 'admin-passed', ...who, time }
      case 'paused': return { kind: 'paused', idle: record.idle, ...who, name: bot?.name ?? record.from, count: record.count ?? record.limit, limit: record.limit, names: record.names, time }
      case 'folder': return { kind: 'folder', text: noticeText(record), time }
      default: return undefined
    }
  }
  const rowsView = (roomId, from, to?, anchor?) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined) ensureRoomLog(room)
    let end = to
    if (end === undefined) {
      const records = rt.ledger.records(bookOf(roomId))
      const at = anchor === undefined ? -1 : records.findIndex(record => record.event === 'anchor' && record.id === anchor)
      const next = at === -1
        ? records.filter(record => record.event === 'anchor' && record.from > from).map(record => record.from)
        : [records.slice(at + 1).find(record => record.event === 'anchor')?.from].filter(seq => seq !== undefined)
      if (next.length > 0) end = Math.min(...next) - 1
    }
    const rows = rt.ledger.range(bookOf(roomId), from, end).filter(record => record.session !== true).map(rowOf).filter(Boolean)
    return { rows, open: end === undefined }
  }
  const groupRows = (roomId, from, to?, anchor?) => rowsView(roomId, from, to, anchor).rows
  const groupSearch = (roomId, query, page) => searchGroupBook(rt.ledger.records(bookOf(roomId)), query, page)

  Object.assign(rt, {
    keepGroupLine, dropGroupLines, groupRows, groupRowsView: rowsView, groupSearch,
    logRoom: (room, line) => say(room, line),
    onRoomLine: (listener) => {
      roomLineListeners.add(listener)
      return () => roomLineListeners.delete(listener)
    },
    groupLinesAfter: async (roomId, since) => rt.ledger.after(bookOf(roomId), since).filter(memberLine),
    groupLine: async (roomId, seq) => {
      const record = rt.ledger.record(bookOf(roomId), seq)
      return memberLine(record) ? record : undefined
    },
    searchGroupLog: async (roomId, query) => rt.ledger.search(bookOf(roomId), query).filter(memberLine),
  })

  const noteFailure = (room, member, failure) => {
    const { code, status, message } = failure
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'failed', names: [member.name], about: member.id, detail: failureLine(failure), code, ...(status ? { status } : {}), message })
  }

  const noteHelperFailure = async (sessionId, { stopReason, helper, closing }: Record<string, any> = {}) => {
    if (rt.readOnly() !== undefined) return
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const reason = typeof stopReason === 'string' && stopReason !== '' ? stopReason.slice(0, 40) : 'error'
    const cleanHelper = typeof helper === 'string' && helper.trim() !== '' ? helper.trim().slice(0, 120) : undefined
    const cleanClosing = typeof closing === 'string' && closing.trim() !== '' ? closing.replace(/\s+/g, ' ').trim().slice(0, 240) : undefined
    const summary = `subagent ended (${reason})${cleanClosing ? `: ${cleanClosing}` : ''}`
    const detail = cleanHelper ? `${cleanHelper} — ${summary}` : summary
    say(room, {
      who: 'DS Bot',
      kind: 'notice',
      reason: 'helper-failed',
      names: [member.name],
      about: member.id,
      stopReason: reason,
      ...(cleanHelper ? { helper: cleanHelper } : {}),
      detail,
    })
    await rt.save()
  }
  rt.subagentFailureNotice = noteHelperFailure

  async function roomFolderNotice(roomId, folder) {
    const room = rt.roomOf(roomId)
    if (room === undefined || folder === undefined || room.workDir !== folder || room.folderNotice === folder) return
    room.folderNotice = folder
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'folder', path: folder })
    await rt.save()
  }
  rt.roomFolderNotice = roomFolderNotice

  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }) })
    const gone = rt.roomOf(room.id) !== room || !room.members.includes(member.id) || rt.botOf(member.id) === undefined
    if (gone || room.sessions?.[member.id] !== undefined) {
      void ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused group Session of %s in %s not archived: %s', member.name, room.name, error))
      return gone ? undefined : groupSessionFor(room, member)
    }
    room.sessions[member.id] = id
    ensureSessionIndex(rt).registerGroupMember(id, member.id, room.id)
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      const effort = await rt.desiredEffort(member, ref)
      await rt.selectSessionModel(id, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.applyPermission(member, id, room)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    await rt.resolveAgent(id)
      .catch(error => rt.warn('ds-bot: scoped tools for %s in %s not applied: %s', member.name, room.name, error))
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  function roomPrompt(room, member, round, slot, finished = { results: [], quiet: [] }) {
    const { results, quiet } = finished
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const routes = room.mode === 'admin' && rt.isMain(member.id)
    const routed = room.mode === 'admin' && routerOf(room) !== undefined
    const lead = [routes ? ROUTER_NOTE : '', leads ? adminNote(room, routed) : ''].filter(Boolean).join(' ')
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const owed = results.filter(result => ![...earlier, ...current].some(line => line.seq === result.seq))
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) return { text: [members, notice, lead, roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n'), images: [], files: [] }
    const answering = new Set(round.slots.filter(other => other.status === 'speaking').map(other => other.id))
    const working = workingIn(room).filter(item => item.bot.id !== member.id && !answering.has(item.bot.id))
      .map(item => ({ ...item, unread: unreadCount(room, item.bot.id) }))
    const text = [
      members,
      notice,
      lead,
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier, memberText(room))}` : '',
      owed.length ? `Results of the work you asked for that the lines here leave out (oldest first):\n${owed.map(result => (result.line
        ? transcript([result.line], memberText(room))
        : `[${result.name}'s result, message #${result.seq}, is not available here; read_group_chat with seq ${result.seq} reads it]`)).join('\n')}` : '',
      quiet.length ? `Finished without a closing message: ${quiet.join(' and ')}. What they said while they worked is their result; read_group_chat reads it.` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current, memberText(room))}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min${item.unread > 0 ? `, with ${item.unread} group message(s) it has not read yet` : ''})`).join(', ')}.` : '',
      ...placeLines(round, slot),
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
    const shown = [...earlier, ...owed.flatMap(result => result.line ?? []), ...current]
    return { text, images: shown.flatMap(line => line.images ?? []), files: shown.flatMap(line => line.files ?? []), requests: shown.flatMap(line => line.request ?? []) }
  }

  async function finishedLines(room, slot) {
    if (slot.finished === undefined) return { results: [], quiet: [] }
    const results: any[] = [...new Map(slot.finished.results.map(result => [result.seq, result])).values()].sort((a: any, b: any) => a.seq - b.seq)
    const inLog = new Map(room.log.map(line => [line.seq, line]))
    return {
      results: await Promise.all(results.map(async ({ name, seq }) => ({ name, seq, line: inLog.get(seq) ?? await rt.groupLine(room.id, seq).catch(() => undefined) }))),
      quiet: [...new Set(slot.finished.names)].filter(name => !results.some(result => result.name === name)),
    }
  }

  function placeLines(round, slot) {
    const lines = []
    if (slot.ordered) {
      const order = round.slots.filter(other => other.ordered)
      const index = order.indexOf(slot)
      const after = order.length - index - 1
      lines.push(`Members answer this message one at a time: ${order.map(other => slotLabel(other, slot)).join(' → ')}.`,
        `You are number ${index + 1} of ${order.length}. ${index === 0 ? 'Nobody spoke before you' : `${index} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`)
    } else {
      const together = round.slots.filter(other => other !== slot && other.batch === slot.batch && other.id !== slot.id)
      if (together.length > 0) lines.push(`Called together with you: ${together.map(other => other.name).join(', ')}. You answer at the same time and do not see each other's replies until they post.`)
    }
    const latest = new Map()
    for (const other of round.slots) if (other.id !== slot.id && !(slot.ordered && other.ordered)) latest.set(other.id, other)
    if (latest.size > 0) lines.push(`Also in this round: ${[...latest.values()].map(other => slotLabel(other, slot)).join(', ')}.`)
    return lines
  }

  const workingIn = room => room.members.flatMap((id) => {
    const sessionId = room.sessions?.[id]
    const entry = rt.live.get(sessionId)
    const bot = rt.botOf(id)
    if (bot === undefined) return []
    if (entry?.turn !== undefined) return [{ bot, since: entry.since ?? Date.now() }]
    if (sessionId !== undefined && rt.hasSubagents?.(sessionId)) {
      const subSince = rt.roomWorkView?.()?.[room.id]?.find(item => item.botId === id)?.since
      return [{ bot, since: subSince ?? Date.now() }]
    }
    return []
  })
  const unreadCount = (room, botId) => unseenLines(room, botId).length
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  const batches = (): Record<string, any> => (rt.state.roomBatches ??= {})
  const saveSoon = () => void rt.save().catch(() => {})
  const batchOf = (roomId, botId, by) => Object.values(batches()).find(batch => batch.roomId === roomId && batch.by === by && batch.pending.includes(botId))
  const batchesOf = (roomId, botId) => Object.values(batches()).filter(batch => batch.roomId === roomId && batch.pending.includes(botId))
  const unpend = (batch, botId) => { batch.pending = batch.pending.filter(id => id !== botId) }

  const activeInRoom = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId !== undefined && (rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true)) return true
    if (sessionId !== undefined && (rt.unreadOf?.(sessionId)?.length ?? 0) > 0) return true
    return [...rt.roomProgress.values()].some(round => round.roomId === room.id
      && round.slots.some(slot => slot.id === botId && (slot.status === 'waiting' || slot.status === 'speaking')))
  }

  const registerBatch = (roomId, by, callees) => {
    if (by === undefined || callees.length === 0) return undefined
    for (const [key, old] of Object.entries(batches())) if (rt.roomOf(old.roomId) === undefined) delete batches()[key]
    const batch = {
      key: randomUUID(),
      roomId,
      by,
      pending: callees.map(peer => peer.id),
      done: [],
      doneIds: [],
      results: [],
      worked: false,
      answered: false,
      at: Date.now(),
    }
    for (const peer of callees) {
      const prev = batchOf(roomId, peer.id, by)
      if (prev === undefined) continue
      unpend(prev, peer.id)
      if (prev.pending.length === 0) {
        batch.done.push(...prev.done)
        batch.doneIds.push(...(prev.doneIds ?? []))
        batch.results.push(...prev.results)
        batch.worked ||= prev.worked
        batch.answered ||= prev.answered
        delete batches()[prev.key]
      }
    }
    batches()[batch.key] = batch
    saveSoon()
    return batch.key
  }

  const pruneBatchPending = (room, batch) => {
    for (const otherId of batch.pending) {
      if (!room.members.includes(otherId) || !activeInRoom(room, otherId)) unpend(batch, otherId)
    }
  }

  const batchOfSlot = (roomId, slot) => (slot.batchKey === undefined ? undefined : batches()[slot.batchKey]) ?? batchOf(roomId, slot.id, slot.by)
  const markSlotWorked = (roomId, slot) => {
    const batch = batchOfSlot(roomId, slot)
    if (batch !== undefined && !batch.worked) {
      batch.worked = true
      saveSoon()
    }
  }

  const batchOfTurn = (roomId, botId, info) => (info?.askedBy !== undefined ? batchOf(roomId, botId, info.askedBy) : undefined)
    ?? (info?.role !== 'room' ? batchesOf(roomId, botId)[0] : undefined)

  const leaveBatch = (room, batch, botId, { keep = false } = {}) => {
    unpend(batch, botId)
    pruneBatchPending(room, batch)
    if (batch.pending.length === 0) {
      if (!keep) delete batches()[batch.key]
    }
    saveSoon()
  }
  const closeBatch = (key) => {
    if (key !== undefined && batches()[key]?.pending.length === 0) {
      delete batches()[key]
      saveSoon()
    }
  }
  const recordResult = (key, name, seq) => {
    const batch = key === undefined ? undefined : batches()[key]
    if (batch === undefined) return
    batch.results.push({ name, seq })
    saveSoon()
  }
  const wakeOf = (key) => {
    const batch = key === undefined ? undefined : batches()[key]
    return batch !== undefined && batch.pending.length === 0 && batch.done.length > 0 ? { names: [...batch.done], results: [...batch.results] } : undefined
  }
  rt.settleRoomBatches = async () => {
    if (rt.readOnly?.() !== undefined) return
    let changed = false
    for (const batch of Object.values(batches())) {
      const room = rt.roomOf(batch.roomId)
      if (room === undefined || rt.botOf(batch.by) === undefined) {
        delete batches()[batch.key]
        changed = true
        continue
      }
      const before = batch.pending.length
      pruneBatchPending(room, batch)
      if (batch.pending.length > 0) continue
      changed ||= before > 0
      const members = room.members.map(rt.botOf).filter(Boolean)
      const doneIds = batch.doneIds ?? []
      const last = members.find(bot => bot.id === doneIds.at(-1)) ?? members.find(bot => doneIds.includes(bot.id))
        ?? members.find(bot => bot.name === batch.done.at(-1)) ?? members.find(bot => bot.id !== batch.by)
      if (!room.members.includes(batch.by) || batch.done.length === 0 || last === undefined || !batch.worked || batch.answered) {
        delete batches()[batch.key]
        changed = true
        continue
      }
      await postToRoom(room, last, '', { late: true, done: true, askedBy: batch.by, batch: batch.key, batchEnd: true })
        .catch((error) => {
          delete batches()[batch.key]
          rt.warn('ds-bot: a batch in %s left by a restart did not wake its caller: %s', room.name, error)
        })
    }
    if (changed) saveSoon()
  }
  const finishedNote = names => `${names.join(' and ')} finished the work you asked for`
  const giveResults = (round, botId, wake) => {
    const slot = round.slots.findLast(other => other.id === botId && other.status === 'waiting')
    if (slot === undefined) return
    slot.finished = slot.finished === undefined ? wake
      : { names: [...new Set([...slot.finished.names, ...wake.names])], results: [...slot.finished.results, ...wake.results] }
  }

  const dropMemberFromBatch = (room, botId) => {
    const owed = batchesOf(room.id, botId)
    for (const batch of owed) leaveBatch(room, batch, botId)
    return owed
  }

  const postInRound = (room, member, text, duration?, claims?, changes?) => {
    say(room, { who: member.name, botId: member.id, text, ...(duration === undefined ? {} : { duration }), ...(claims === undefined ? {} : { claims }), ...(changes === undefined ? {} : { changes }) })
    void rt.save().catch(() => {})
    return room.seq
  }

  const claimsOf = (session, text, worked, calledPeer = false) => session === undefined ? undefined : claimsFor({
    text,
    base: rt.sessionFolder?.(session),
    worked,
    subagents: rt.hasSubagents?.(session.id) === true,
    runningJobs: rt.runningJobs?.(session.id)?.length ?? null,
    calledPeer,
  })

  async function roomTurn(room, member, sessionId, { text, images = [], files = [], requests = [] }, note, signal, round, by, said = [], heard: (line: any) => void = () => {}, onWork = () => {}) {
    if (signal.aborted) return null
    const startedAt = Date.now()
    const exchangeId = randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    const seenAt = room.seq
    const busy = rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true
    const done = new Promise<any>((resolve) => {
      let timer
      let grace
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        rt.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => {
        onWork()
        grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS)
      }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        postInRound(room, member, step, Date.now() - startedAt)
        heard(step)
      }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, say, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await rt.dispatch.sendGroupTurn({ toId: member.id, sessionId, roomId: room.id, exchangeId, note, text, images, files, requests, steer: busy, ...(by ? { askedBy: by } : {}) })
      room.seen[member.id] = seenAt
      if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      const lost = lostSession(error)
      if (lost && room.sessions?.[member.id] === sessionId) {
        rt.retireGroupSession(room, member.id)
        void rt.save().catch(() => {})
      }
      rt.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    if ((typeof reply === 'string' || reply?.failure !== undefined) && !rt.hasSubagents?.(sessionId)) started.splice(started.indexOf(turn), 1)
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  const waitersOf = (sessionId) => {
    const owner = rt.groupOwners.get(sessionId)
    return [...rt.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId
      || (owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  }
  rt.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  rt.failRoomTurn = (sessionId, failure) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.fail(failure)
    return waiters.length > 0
  }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
  rt.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.work()
    const owner = rt.groupOwners.get(sessionId)
    if (waiters.length > 0 || owner === undefined) return
    const batch = batchOfTurn(owner.roomId, owner.botId, rt.live.get(sessionId)?.info)
    if (batch !== undefined) batch.worked = true
  }
  rt.nudgeRoom = (roomId) => {
    for (const round of rt.roomProgress.values()) {
      if (round.roomId === roomId) setImmediate(() => round.nudge?.())
    }
  }

  function callIn(round, callees, note, by, { ordered = false } = {}) {
    if (callees.length === 0) return
    round.batches = (round.batches ?? 0) + 1
    const batchKey = registerBatch(round.roomId, by, callees)
    let last
    for (const peer of callees) {
      const waiting = round.slots.findIndex(slot => slot.id === peer.id && slot.status === 'waiting' && (by === undefined || slot.by === undefined || slot.by === by))
      const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
      const slot = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots[waiting]
      if (moves && waiting !== -1) round.slots.splice(waiting, 1)
      slot.note = note
      slot.batch = round.batches
      if (batchKey !== undefined) slot.batchKey = batchKey
      if (by === undefined) delete slot.by
      else slot.by = by
      if (!moves) slot.ordered = false
      else if (!ordered) round.slots.push(slot)
      else {
        slot.ordered = true
        const queue = round.slots.findIndex(other => other.ordered && other.status === 'waiting')
        round.slots.splice(last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue, 0, slot)
        last = slot
      }
    }
    round.nudge?.()
  }

  const startable = (round, slot) => {
    if (slot.status !== 'waiting' || round.slots.some(other => other.id === slot.id && other.status === 'speaking')) return false
    if (!slot.ordered) return true
    const at = round.slots.indexOf(slot)
    return round.slots.every((other, index) => !other.ordered || other === slot || (other.status !== 'speaking' && !(other.status === 'waiting' && index < at)))
  }

  const releaseParked = (room, round) => {
    const parked = room.paused ?? []
    const due = parked.filter(entry => entry.idle !== true || round.userMessage === true)
    if (due.length === 0) return
    const left = parked.filter(entry => !due.includes(entry))
    if (left.length > 0) room.paused = left
    else delete room.paused
    for (const entry of due) {
      if (round.slots.some(slot => slot.id === entry.id && slot.status === 'waiting')) continue
      const peer = rt.botOf(entry.id)
      const batchKey = peer && entry.by !== undefined ? registerBatch(room.id, entry.by, [peer]) : undefined
      round.batches = (round.batches ?? 0) + 1
      round.slots.push({
        id: entry.id, name: entry.name, status: 'waiting', batch: round.batches,
        ...(batchKey !== undefined ? { batchKey } : {}),
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        ...(entry.by !== undefined ? { by: entry.by } : {}),
      })
    }
  }

  const waitingLines = agent => ['nextStep', 'nextTurn'].flatMap((list) => {
    const lines = []
    for (const message of agent?.inbox?.[list] ?? []) {
      if (message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) break
      lines.push({ id: message.id, text, ...(viaOf(message.source) ? { via: viaOf(message.source) } : {}), ...(typeof message.source.rpcId === 'string' ? { request: message.source.rpcId } : {}) })
    }
    return lines
  })

  function drainRoomInbox(room, round, agent) {
    if (round.kickoff) return
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return
    unpauseRoomIdle(room)
    round.userMessage = true
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      say(room, { who: 'User', text: line.text, ...(line.via ? { via: line.via } : {}), ...(line.request ? { request: line.request } : {}) })
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      const { speakers, ordered } = openingCall(room, { text: line.text })
      callIn(round, speakers, note, undefined, { ordered })
    }
    releaseParked(room, round)
    void rt.save().catch(() => {})
  }

  const countIdleStep = (room) => {
    if (room.idlePaused !== undefined) return
    room.idleRelays = (room.idleRelays ?? 0) + 1
  }
  const clearIdleStreak = (room) => {
    if (room.idlePaused !== undefined) return
    if (room.idleRelays !== undefined) delete room.idleRelays
  }
  const unpauseRoomIdle = (room) => {
    if (room.idleRelays !== undefined) delete room.idleRelays
    if (room.idlePaused !== undefined) delete room.idlePaused
  }
  function holdIdleCalls(room, round, member, callees, { named = [], all = false } = {}) {
    if (room.idlePaused === undefined && (room.idleRelays ?? 0) < ROOM_IDLE_RELAY_LIMIT) return false
    if (room.idlePaused === undefined) room.idlePaused = { from: member.id, count: room.idleRelays ?? ROOM_IDLE_RELAY_LIMIT, noticed: false }
    if (callees.length > 0) {
      const parked = room.paused ?? []
      for (const peer of callees) {
        if (parked.some(entry => entry.id === peer.id)) continue
        const note = named.includes(peer) ? `${member.name} mentioned you` : all ? `${member.name} called everyone` : `${member.name} posted in the group`
        parked.push({ id: peer.id, name: peer.name, note, by: member.id, idle: true })
      }
      room.paused = parked
    }
    announceRoomIdlePaused(room, round, member, callees)
    return true
  }
  function announceRoomIdlePaused(room, round, member, callees) {
    if (room.idlePaused === undefined || room.idlePaused.noticed === true) return
    room.idlePaused.noticed = true
    const names = callees.map(peer => peer.name)
    say(room, { who: 'DS Bot', kind: 'notice', reason: 'paused', idle: true, from: member.name, about: member.id, count: room.idlePaused.count ?? ROOM_IDLE_RELAY_LIMIT, limit: ROOM_IDLE_RELAY_LIMIT, names })
    void rt.save().catch(() => {})
  }

  function callFrom(room, round, member, text, called, { worked = false, byBot = false } = {}) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const others = everyone.filter(other => other.id !== member.id)
    const { all, found: named } = mentionsIn(text, everyone)
    const found = named.filter(other => other.id !== member.id)
    const callees = (rt.isAdminOf(room, member.id) && all ? [...found, ...others.filter(other => !found.includes(other))] : found)
      .filter(peer => !called.has(peer.id))
    let idleStep = false
    if (worked) {
      clearIdleStreak(room)
    } else if (byBot) {
      const history = round.botBodies?.get(member.id) ?? []
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...history, norm])
      idleStep = isIdleRelayText(text, everyone, history)
      if (idleStep) countIdleStep(room)
      else clearIdleStreak(room)
    } else {
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...(round.botBodies?.get(member.id) ?? []), norm])
    }
    for (const peer of callees) called.add(peer.id)
    if (byBot && idleStep && holdIdleCalls(room, round, member, callees, { named, all })) return
    if (callees.length === 0) return
    callIn(round, callees, `${member.name} mentioned you`, member.id)
  }

  async function runRound(room, round, signal, agent) {
    const turns = new Set()
    let due = true
    let wake: (value?: any) => void = () => {}
    round.nudge = () => { due = true; wake() }
    signal.addEventListener('abort', round.nudge, { once: true })
    while (!signal.aborted) {
      if (!due) await new Promise((resolve) => { wake = resolve })
      due = false
      if (signal.aborted) break
      drainRoomInbox(room, round, agent)
      for (const slot of round.slots) {
        if (!startable(round, slot)) continue
        const turn = memberTurn(room, round, slot, signal)
          .catch(error => rt.warn('ds-bot: group turn of %s in %s failed: %s', slot.name, room.name, error))
          .finally(() => { turns.delete(turn); round.nudge() })
        turns.add(turn)
      }
      if (turns.size === 0 && !round.slots.some(slot => slot.status === 'waiting') && (round.kickoff || waitingLines(agent).length === 0)) break
    }
    round.closed = true
    await Promise.allSettled([...turns])
    delete round.nudge
    const alone = round.soleAdmin !== undefined && round.slots.find(slot => slot.id === round.soleAdmin.id)?.status === 'passed'
    const answered = round.slots.some(slot => ['posted', 'working', 'waiting-approval'].includes(slot.status))
    if (alone && !answered) {
      say(room, { who: 'DS Bot', kind: 'notice', reason: 'admin-passed', names: [round.soleAdmin.name], about: round.soleAdmin.id })
      await rt.save()
    }
  }

  async function memberTurn(room, round, slot, signal) {
    const member = rt.botOf(slot.id)
    if (member === undefined || !room.members.includes(slot.id)) {
      slot.status = 'left'
      dropMemberFromBatch(room, slot.id)
      return
    }
    slot.status = 'speaking'
    let session
    try {
      session = await groupSessionFor(room, member)
    } catch (error) {
      rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
      slot.status = 'failed'
      const own = batchOfSlot(room.id, slot)
      if (own !== undefined) leaveBatch(room, own, member.id)
      round.failed.push(member.name)
      noteFailure(room, member, { code: 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
      return
    }
    if (session === undefined) {
      slot.status = 'left'
      dropMemberFromBatch(room, member.id)
      return
    }
    const prompt = roomPrompt(room, member, round, slot, await finishedLines(room, slot))
    round.shown?.push(member.id)
    const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
    const said = []
    const posted = []
    const called = new Set()
    const startedAt = Date.now()
    let worked = false
    const answeredBot = slot.by !== undefined || slot.fromBot === true
    const onWork = () => {
      worked = true
      slot.worked = true
      clearIdleStreak(room)
      markSlotWorked(room.id, slot)
    }
    const reply = await roomTurn(
      room, member, session.id, { text, images: prompt.images, files: prompt.files, requests: prompt.requests }, slot.note ?? 'your turn', signal, round, slot.by, said,
      (line) => {
        posted.push(room.seq)
        callFrom(room, round, member, line, called, { worked, byBot: answeredBot })
      },
      onWork,
    )
    const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
    const changes = await rt.turnChanges?.(session.id)
    const subRunning = rt.hasSubagents?.(session.id) === true
    if (reply?.failure !== undefined) {
      slot.status = 'failed'
      round.failed.push(member.name)
      noteFailure(room, member, reply.failure)
    } else if (reply?.approval) {
      slot.status = 'waiting-approval'
      say(room, { who: member.name, botId: member.id, kind: 'approval' })
    } else if (reply?.working) {
      slot.status = 'working'
      markSlotWorked(room.id, slot)
      say(room, { who: member.name, botId: member.id, kind: 'working' })
    } else if (subRunning) {
      if (final !== undefined) {
        postInRound(room, member, final, Date.now() - startedAt, claimsOf(session, final, true), changes)
        callFrom(room, round, member, final, called, { worked: true, byBot: answeredBot })
      }
      slot.status = 'working'
      markSlotWorked(room.id, slot)
      say(room, { who: member.name, botId: member.id, kind: 'working' })
    } else if (changes !== undefined && final === undefined && typeof reply === 'string') {
      slot.status = 'posted'
      say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      posted.push(room.seq)
    } else if (final !== undefined || (typeof reply === 'string' && said.length > 0)) {
      slot.status = 'posted'
      if (final !== undefined && final.trim() !== '') {
        posted.push(postInRound(room, member, final, Date.now() - startedAt, claimsOf(session, final, worked, callsIn(room, member, final)), changes))
        callFrom(room, round, member, final, called, { worked, byBot: answeredBot })
      } else if (changes !== undefined) {
        say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      }
    } else {
      slot.status = reply === null ? 'cancelled' : typeof reply === 'string' ? 'passed' : 'missed'
      round.passed.push(member.name)
      if (changes !== undefined) say(room, { who: member.name, botId: member.id, kind: 'done', text: '', changes })
      if (reply?.missed) {
        say(room, { who: 'DS Bot', kind: 'notice', reason: 'missed', names: [member.name], about: member.id, minutes: Math.round(ROOM_REPLY_TIMEOUT_MS / 60000) })
      }
    }
    if (['posted', 'passed', 'failed', 'left', 'cancelled'].includes(slot.status)) {
      const batch = batchOfSlot(room.id, slot)
      if (batch !== undefined) {
        if (slot.status === 'posted') {
          batch.done.push(member.name)
          batch.doneIds.push(member.id)
          batch.results.push(...posted.map(seq => ({ name: member.name, seq })))
          if (called.size > 0) batch.answered = true
          if (worked) batch.worked = true
        }
        leaveBatch(room, batch, member.id)
        if (batch.pending.length === 0 && batch.done.length > 0 && batch.worked && !batch.answered && !signal.aborted) {
          const caller = rt.botOf(batch.by)
          const wake = { names: [...batch.done], results: [...batch.results] }
          if (caller !== undefined && room.members.includes(caller.id)) {
            if (!round.slots.some(other => other.id === caller.id && other.status === 'waiting')) callIn(round, [caller], finishedNote(wake.names), undefined)
            giveResults(round, caller.id, wake)
          }
        }
      }
    }
  }

  // A round runs in DS Bot, not inside the group_relay call that opened it: the call ends
  // at once, so DSH neither cuts a long round short (PTC) nor holds the group's Session.
  const laterPosts = new Map()
  const finalizing = new Set()
  let disposed = false
  rt.roomActive = roomId => runningRound(roomId) !== undefined || finalizing.has(roomId)
  const roundRuns = new Map()
  rt.roomRounds = roomId => [...(roundRuns.get(roomId) ?? [])]
  const runningRound = roomId => [...rt.roomProgress.values()].find(round => round.roomId === roomId)
  const stoppedFinishing = new Set()
  rt.stopRoomRound = (roomId) => {
    const round = runningRound(roomId)
    round?.abort.abort()
    if (finalizing.has(roomId)) stoppedFinishing.add(roomId)
    return round !== undefined || finalizing.has(roomId)
  }
  async function joinRound(room, running, posts, agent) {
    const round = running.starting ? await running.ready : running
    if (round === undefined) {
      const current = runningRound(room.id)
      if (current !== undefined) return joinRound(room, current, posts, agent)
      if (finalizing.has(room.id)) laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...posts])
      else startRound(room, posts, agent ?? await rt.resolveAgent(rt.sessionOfRoom(room)))
      return
    }
    if (round.closed || round.abort?.signal.aborted) {
      laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...posts])
      return
    }
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const post of posts) {
      if (post.logged !== undefined) continue
      const own = round.kickoff || post.kickoff || post.images !== undefined || (post.references?.length ?? 0) > 0
      if (own) {
        laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), post])
        continue
      }
      const sender = post.botId === undefined ? undefined : rt.botOf(post.botId)
      if (sender !== undefined) {
        const text = [post.text, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        if (post.failed !== undefined) round.failed.push(sender.name)
        else if (post.resumed || post.stopped || post.done) say(room, { who: sender.name, botId: sender.id, kind: post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed', text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
        else {
          say(room, { who: sender.name, botId: sender.id, text, ...(post.files === undefined ? {} : { files: post.files }), ...(post.claims === undefined ? {} : { claims: post.claims }), ...(post.changes === undefined ? {} : { changes: post.changes }), session: true })
          if (post.batch !== undefined && text !== '') recordResult(post.batch, sender.name, room.seq)
        }
        callPost(room, round, sender, post.text ?? '', post)
        if (post.batchEnd) closeBatch(post.batch)
        continue
      }
      if (post.botId !== undefined) continue
      const text = [post.text, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
      say(room, { who: 'User', text, ...(post.files === undefined ? {} : { files: post.files }), ...(post.via === undefined ? {} : { via: post.via }), session: true })
      unpauseRoomIdle(room)
      round.userMessage = true
      const { all, found } = mentionsIn(post.text ?? '', members)
      const { speakers, ordered } = openingCall(room, { text: post.text ?? '' })
      callIn(round, speakers, all || found.length > 0 ? 'the user mentioned you' : 'new message from the user', undefined, { ordered })
    }
    releaseParked(room, round)
    round.nudge?.()
    await rt.save()
  }

  ctx.effect(() => () => {
    disposed = true
    for (const round of rt.roomProgress.values()) round.abort?.abort()
  }, 'ds-bot: group rounds')

  function startRound(room, queued, agent, key = randomUUID()) {
    const controller = new AbortController()
    const holder: Record<string, any> = { roomId: room.id, slots: [], starting: true, abort: controller }
    holder.ready = new Promise((resolve) => { holder.settle = resolve })
    rt.roomProgress.set(key, holder)
    const run = runRoundFrom(room, queued, agent, key, controller.signal, holder)
      .catch(error => rt.warn('ds-bot: group round in %s failed: %s', room.name, error))
      .finally(() => {
        holder.settle(undefined)
        if (rt.roomProgress.get(key) === holder) rt.roomProgress.delete(key)
      })
    const runs = roundRuns.get(room.id) ?? new Set()
    runs.add(run)
    roundRuns.set(room.id, runs)
    void run.finally(() => {
      runs.delete(run)
      if (runs.size === 0 && roundRuns.get(room.id) === runs) roundRuns.delete(room.id)
    })
    return run
  }
  async function runRoundFrom(room, queued, agent, key, signal, holder) {
    const posts = queued.length > 0 ? queued : [{ text: '' }]
    const startSeq = Math.min(room.seq + 1, ...posts.map(post => post.logged).filter(seq => typeof seq === 'number'))
    const event = item => item.failed || item.resumed || item.stopped || item.done
    const userPost = post => post.botId === undefined && post.kickoff !== true && !event(post)
    const stoppedOnly = posts.length > 0 && posts.every(item => event(item) && item.stopped === true)
    for (const post of posts.filter(item => !item.kickoff && !event(item) && item.logged === undefined)) {
      const readings = post.images === undefined ? [] : await rt.imagesForGroup(post.images, rt.sessionOfRoom(room))
      const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
      const who = post.botId ? rt.botOf(post.botId)?.name ?? post.name ?? 'Bot' : 'User'
      say(room, {
        who,
        ...(post.botId ? { botId: post.botId } : {}),
        text,
        ...(post.images === undefined ? {} : { images: post.images }),
        ...(post.files === undefined ? {} : { files: post.files }),
        ...(post.via === undefined ? {} : { via: post.via }),
        ...(post.request === undefined ? {} : { request: post.request }),
        ...(post.claims === undefined ? {} : { claims: post.claims }),
        ...(post.changes === undefined ? {} : { changes: post.changes }),
        session: true,
      })
      if (post.batch !== undefined && text !== '') recordResult(post.batch, who, room.seq)
    }
    await rt.save()
    const callsNobody = post => post.member === true && openingSpeakers(room, post).length === 0
    const open = posts.filter(post => post.called !== true)
    const opener = open.findLast(post => !event(post) && !callsNobody(post)) ?? open.findLast(post => !event(post)) ?? open.at(-1) ?? { text: '', quiet: true }
    const references = posts.flatMap(post => post.references ?? [])
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const poster = opener.botId === undefined ? undefined : rt.botOf(opener.botId)
    const idlePost = poster !== undefined && !event(opener) && opener.quiet !== true && isIdleRelayText(opener.text ?? '', everyone, [])
    if (posts.some(userPost)) unpauseRoomIdle(room)
    const holdsPost = idlePost && room.idlePaused !== undefined
    const named = opener.botId === undefined ? [] : (mentionsOf(opener, everyone) ?? mentionsIn(opener.text ?? '', everyone)).found
    const opened = openingCall(room, opener)
    const speakers = holdsPost ? [] : opened.speakers
    const ordered = holdsPost ? false : opened.ordered
    const wake = opener.batch === undefined || opener.askedBy === undefined ? undefined : wakeOf(opener.batch)
    const calledByOpener = speakers.filter(member => named.includes(member))
    const openingBatchKey = opener.botId !== undefined && calledByOpener.length > 0 ? registerBatch(room.id, opener.botId, calledByOpener) : undefined
    const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
    const first = room.mode === 'admin' ? (routerOf(room) ?? admin) : undefined
    const soleAdmin = opener.botId === undefined && !opener.kickoff && first !== undefined
      && speakers.length === 1 && speakers[0].id === first.id
      ? first : undefined
    const round: Record<string, any> = {
      roomId: room.id,
      members: room.members,
      startSeq,
      ...(posts.some(userPost) ? { userMessage: true } : {}),
      ...(opener.kickoff ? { kickoff: true } : {}),
      ...(stoppedOnly ? { stoppedOnly: true } : {}),
      ...(references.length > 0 ? { references, shown: [] } : {}),
      slots: speakers.map(member => ({
        id: member.id, name: member.name, status: 'waiting', batch: 1,
        ...(ordered ? { ordered: true } : {}),
        ...(opener.botId !== undefined ? { fromBot: true } : {}),
        ...(opener.kickoff ? { note: 'the group was just created' } : {}),
        ...(named.includes(member) ? { by: opener.botId, ...(openingBatchKey ? { batchKey: openingBatchKey } : {}) } : {}),
        ...(opener.done ? { note: `${opener.name ?? 'a member'} finished the work you asked for` } : {}),
        ...(wake !== undefined && member.id === opener.askedBy ? { finished: wake, ...(named.includes(member) ? {} : { note: finishedNote(wake.names) }) } : {}),
      })),
      batches: 1,
      ...(soleAdmin ? { soleAdmin: { id: soleAdmin.id, name: soleAdmin.name, color: soleAdmin.color } } : {}),
      from: startSeq,
      abort: holder.abort,
      passed: [],
      failed: [],
      started: [],
    }
    if (!idlePost && poster !== undefined && !event(opener) && opener.quiet !== true) clearIdleStreak(room)
    if (holdsPost) holdIdleCalls(room, round, poster, opened.speakers, { named, all: (mentionsOf(opener, everyone) ?? mentionsIn(opener.text ?? '', everyone)).all === true })
    for (const post of posts.filter(item => item.failed && item.logged === undefined)) {
      round.failed.push(rt.botOf(post.botId)?.name ?? post.name)
    }
    for (const post of posts.filter(item => (item.resumed || item.stopped || item.done) && item.logged === undefined)) {
      const name = rt.botOf(post.botId)?.name ?? post.name
      const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
      say(room, { who: name, botId: post.botId, kind, text: '', ...(post.changes === undefined ? {} : { changes: post.changes }) })
    }
    if (posts.some(post => post.resumed || post.stopped || post.done)) await rt.save()
    for (const post of posts) if (post.batchEnd) closeBatch(post.batch)
    releaseParked(room, round)
    rt.roomProgress.set(key, round)
    holder.settle(round)
    try {
      await runRound(room, round, signal, agent)
    } catch (error) {
      rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
    } finally {
      finalizing.add(room.id)
      rt.roomProgress.delete(key)
      round.to = room.seq
      rt.ledger.append(bookOf(room.id), { event: 'round', from: round.from, to: round.to, passed: round.passed, failed: round.failed, ...(signal.aborted ? { stopped: true } : {}), time: Date.now() })
    }
    try {
      if (signal.aborted) {
        for (const turn of round.started) {
          void rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId)
            ?.catch(error => rt.warn('ds-bot: stopping a turn of the round in %s failed: %s', room.name, error))
        }
      }
      await rt.save()
      const rows = groupRows(room.id, round.from, round.to)
      for (const post of open) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, { rows, passed: round.passed, failed: round.failed })
      }
      for (const { post, ids, from } of round.reports ?? []) {
        if (!rt.botOf(post.botId)) continue
        const names = ids.map(id => rt.botOf(id)?.name).filter(Boolean)
        void reportRound(room, post, {
          rows: groupRows(room.id, from, round.to).filter(row => ids.includes(row.botId)),
          passed: round.passed.filter(name => names.includes(name)),
          failed: round.failed.filter(name => names.includes(name)),
        })
      }
    } finally {
      finalizing.delete(room.id)
      const later = laterPosts.get(room.id) ?? []
      const stopped = stoppedFinishing.delete(room.id)
      if (!signal.aborted && !stopped && !disposed && later.length > 0 && rt.roomOf(room.id) === room) {
        laterPosts.delete(room.id)
        startRound(room, later, agent)
      }
    }
  }

  rt.teamTools.push(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots it calls in this group chat, and collect their replies.',
    parameters: {
      roundId: { type: 'string', description: 'Unique id of this relay round' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const from = Math.min(room.seq + 1, ...queued.map(post => post.logged).filter(seq => typeof seq === 'number'))
      const anchor = randomUUID()
      rt.ledger.append(bookOf(room.id), { event: 'anchor', id: anchor, from, time: Date.now() })
      const running = runningRound(room.id)
      if (running !== undefined) await joinRound(room, running, queued, exec.agent)
      else if (finalizing.has(room.id)) laterPosts.set(room.id, [...(laterPosts.get(room.id) ?? []), ...queued])
      else {
        const left = laterPosts.get(room.id) ?? []
        laterPosts.delete(room.id)
        startRound(room, [...left, ...queued], exec.agent, exec.callId)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ from, anchor })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context and part 0, an earlier chat imported from before you existed, when there is one. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOfThread(botId, id)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        say(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        void rt.save().catch(() => {})
      }
      const imported = rt.importedPart(botId)
      const listed = imported === undefined ? parts : [imported, ...parts]
      const partsNote = listed.length > 1 ? `\n\nYour own chat has ${listed.length} parts: ${rt.partIndex(listed)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around, id)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = listed.find(item => item.number === number)
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.imported) return `Part ${number} is an earlier chat imported from before you existed (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}); it has no handoff note. Search it with words, or read around one of its anchors, such as "part ${number} #12".${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: {
      group: GROUP_REF,
      seq: { type: 'integer', description: 'Read one message whole: the seq that a cut message or a memory source names, however old' },
      query: { type: 'string', description: 'Words to find in everything said in this group, newest first' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      if (args.seq !== undefined) {
        const line = room.log.find(entry => entry.seq === Number(args.seq))
        if (line !== undefined) return lineText(line, memberText(room)(line))
        const kept = await rt.groupLine(room.id, Number(args.seq)).catch(() => undefined)
        return kept === undefined ? `"${room.name}" has no message ${args.seq}.` : lineText(kept, headOf(kept.text ?? '', GROUP_LINE_READ))
      }
      if (typeof args.query === 'string' && args.query.trim() !== '') {
        const found = await rt.searchGroupLog(room.id, args.query).catch(() => [])
        return found.length === 0 ? `Nothing said in "${room.name}" has "${args.query}".` : `In "${room.name}" (newest first):\n${found.map(line => `#${line.seq} ${lineText(line, headOf(line.text, TEXT_KEPT))}`).join('\n')}`
      }
      const short = (line) => {
        if (line.text === undefined) return ''
        const length = line.length ?? line.text.length
        return length <= TEXT_KEPT ? line.text : `${headOf(line.text, TEXT_KEPT)}… (cut; ${length} characters in all; read_group_chat with seq ${line.seq} reads it whole)`
      }
      const lines = room.log.slice(-ROOM_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${transcript(lines, short)}`
    },
  }))

  function openingCall(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    const router = opener.botId === undefined && room.mode === 'admin' ? routerOf(room) : undefined
    const at = speakers => ({ speakers, ordered: false })
    if (opener.kickoff) return at(router ? [router] : admin ? [admin] : [])
    if (opener.quiet) return at([])
    if (opener.done) return at(members.filter(bot => bot.id === opener.askedBy))
    const { all, found: named } = mentionsOf(opener, everyone) ?? mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.progress) return at(found)
    if (opener.late) return at(found.length > 0 ? found : members.filter(bot => bot.id === opener.askedBy))
    if (opener.member) return at(found)
    if (found.length > 0 && !all) return at(found)
    if (!all && router) return at([router])
    if (!all && room.mode === 'admin' && admin) return at([admin])
    const speakers = admin ? [admin, ...members.filter(bot => bot !== admin)] : members
    return { speakers, ordered: !all && speakers.length > 1 }
  }
  const openingSpeakers = (room, opener) => openingCall(room, opener).speakers
  function routerOf(room) {
    const id = (room.members ?? []).find(id => rt.isMain(id) && rt.botOf(id) !== undefined)
    return id === undefined ? undefined : rt.botOf(id)
  }

  function callPost(room, round, sender, text, extra) {
    if (extra.failed !== undefined && !extra.askedBy) return false
    if (extra.resumed || extra.stopped) return false
    const post = { ...extra, botId: sender.id, name: sender.name, text }
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const named = (mentionsOf(post, everyone) ?? mentionsIn(text, everyone)).found
    const idlePost = !extra.done && extra.progress !== true && extra.late !== true && isIdleRelayText(text, everyone, [])
    if (!idlePost) clearIdleStreak(room)
    const opened = openingCall(room, post)
    if (idlePost && room.idlePaused !== undefined && holdIdleCalls(room, round, sender, opened.speakers, { named, all: (mentionsOf(post, everyone) ?? mentionsIn(text, everyone)).all === true })) return true
    const { speakers, ordered } = opened
    if (speakers.length === 0) return false
    const by = speakers.filter(peer => named.includes(peer))
    const rest = speakers.filter(peer => !named.includes(peer))
    const wake = extra.batch === undefined ? undefined : wakeOf(extra.batch)
    const note = extra.done ? `${sender.name} finished the work you asked for` : undefined
    callIn(round, by, note ?? `${sender.name} mentioned you`, sender.id, { ordered })
    callIn(round, rest, wake === undefined ? note : finishedNote(wake.names), undefined, { ordered })
    if (wake !== undefined) giveResults(round, extra.askedBy, wake)
    if (extra.reportBack) {
      (round.reports ??= []).push({ post: { botId: sender.id, name: sender.name, reportBack: true, ...(extra.sub ? { sub: extra.sub } : {}), ...(extra.fromRoomId ? { fromRoomId: extra.fromRoomId } : {}) }, ids: speakers.map(peer => peer.id), from: room.seq + 1 })
    }
    return true
  }

  async function postToRoom(room, sender, text, extra: Record<string, any> = {}, files = []) {
    const noticeOnly = extra.resumed === true || extra.stopped === true || (extra.failed !== undefined && !extra.askedBy)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id
      && (noticeOnly ? !round.starting : round.nudge !== undefined && !round.closed && !round.abort?.signal.aborted))
    if (running !== undefined) {
      if (extra.failed !== undefined) {
        running.failed.push(sender.name)
      } else if (extra.resumed === true || extra.stopped === true || extra.done === true) {
        const kind = extra.done === true ? 'done' : extra.stopped === true ? 'stopped' : extra.again === true ? 'cut' : 'resumed'
        say(room, { who: sender.name, botId: sender.id, kind, text: '', ...(extra.changes === undefined ? {} : { changes: extra.changes }) })
      } else {
        const line = [text, ...files.map(fileLine)].filter(Boolean).join('\n')
        say(room, { who: sender.name, botId: sender.id, text: line, ...(files.length > 0 ? { files } : {}), ...(extra.claims === undefined ? {} : { claims: extra.claims }), ...(extra.changes === undefined ? {} : { changes: extra.changes }) })
        if (extra.batch !== undefined && line !== '') recordResult(extra.batch, sender.name, room.seq)
      }
      callPost(room, running, sender, text, extra)
      if (extra.batchEnd) closeBatch(extra.batch)
      await rt.save()
      return
    }
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }, ...files.map(attachment => ({ type: 'file', attachment }))],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...extra },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.postToRoom = postToRoom

  async function lateRoomReply(sessionId, info, reply, { shown = false, toolCount = 0 } = {}) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, reply)
    if (rt.hasSubagents?.(sessionId) === true) {
      if (!isPass(text)) {
        const calls = callsIn(room, member, text)
        await postToRoom(room, member, text, { progress: true, ...(!calls ? { quiet: true } : {}) })
          .catch(error => rt.warn('ds-bot: subagent progress from %s failed: %s', member.name, error))
      }
      return
    }
    const batch = batchOfTurn(room.id, member.id, info)
    const askedBy = info.role === 'room' ? info.askedBy : (info.askedBy ?? batch?.by)
    const named = mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.filter(bot => bot.id !== member.id)
    let waitingPeers = false
    let batchDoneBefore = false
    if (batch !== undefined) {
      if (named.length > 0) batch.answered = true
      if (!isPass(text) || shown) {
        batch.done.push(member.name)
        ;(batch.doneIds ??= []).push(member.id)
      }
      leaveBatch(room, batch, member.id, { keep: true })
      waitingPeers = batch.pending.length > 0
      batchDoneBefore = !waitingPeers && batch.done.length > 0 && !batch.answered
    }
    const inBatch = batch === undefined ? {} : { batch: batch.key, ...(waitingPeers ? {} : { batchEnd: true }) }
    const session = await rt.resolveAgent(sessionId).then(agent => agent?.session, () => undefined)
    const claims = isPass(text) ? undefined : claimsOf(session, text, toolCount > 0, named.length > 0)
    const changes = await rt.turnChanges?.(sessionId)
    const moved = extra => (changes === undefined ? extra : { ...extra, changes })
    const post = (body, extra) => postToRoom(room, member, body, { late: true, ...moved(extra), ...inBatch, ...(claims === undefined ? {} : { claims }) })
      .catch((error) => {
        if (batch !== undefined) closeBatch(batch.key)
        rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error)
      })
    const lateDone = (extra = {}) => postToRoom(room, member, '', { late: true, done: true, ...moved(extra), ...(askedBy ? { askedBy } : {}) })
      .catch(error => rt.warn('ds-bot: late completion from %s failed: %s', member.name, error))
    if (waitingPeers && named.length === 0) {
      if (!isPass(text)) await post(text, { quiet: true })
      else if (changes !== undefined) await lateDone({ quiet: true })
      return
    }
    const done = isPass(text) && (shown || batchDoneBefore) && askedBy !== undefined
    if (isPass(text) && !done) {
      if (batch !== undefined) closeBatch(batch.key)
      if (changes !== undefined) await lateDone()
      return
    }
    await post(done ? '' : text, { ...(done ? { done: true } : {}), ...(askedBy ? { askedBy } : {}) })
  }
  rt.lateRoomReply = lateRoomReply

  const memberIn = (sessionId, info) => {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info?.roomId)
    const member = rt.botOf(owner?.botId)
    return room !== undefined && member !== undefined && room.members.includes(member.id) ? { room, member } : undefined
  }
  const callsIn = (room, member, text) => mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.some(bot => bot.id !== member.id)
  rt.callsRoomMember = (sessionId, info, raw) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    return room !== undefined && member !== undefined && callsIn(room, member, stripOwnName(member.name, raw ?? ''))
  }

  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    ensureRoomLog(room)
    const calls = callsIn(room, member, text)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) {
      postInRound(room, member, text)
      return
    }
    const quiet = !calls
    await rt.save()
    await postToRoom(room, member, text, { progress: true, ...(quiet ? { quiet: true } : {}) })
  }

  const held = new Map()
  ctx.effect(() => () => { for (const entry of held.values()) clearTimeout(entry.timer) }, 'ds-bot: group step lines')
  const flushSteps = (sessionId) => {
    const entry = held.get(sessionId)
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.lines.length === 0) return undefined
    entry.last = Date.now()
    return postStep(sessionId, entry.info, entry.lines.splice(0).join('\n\n'))
  }
  rt.roomStepText = async (sessionId, info, raw, first) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    const entry = held.get(sessionId) ?? { last: 0, lines: [] }
    held.set(sessionId, entry)
    entry.info = info
    entry.lines.push(text)
    if ((first && info?.role === 'room') || callsIn(room, member, text) || Date.now() - entry.last >= ROOM_STEP_GAP_MS) return flushSteps(sessionId)
    entry.timer ??= setTimeout(() => void flushSteps(sessionId)?.catch(error => rt.warn('ds-bot: step lines from %s not posted: %s', member.name, error)), entry.last + ROOM_STEP_GAP_MS - Date.now())
  }
  rt.takeRoomSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return ''
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.last = Date.now()
    return entry.lines.splice(0).join('\n\n')
  }
  rt.withRoomSteps = (lines, reply) => (lines === '' ? reply : isPass(reply) ? lines : `${lines}\n\n${reply}`)

  async function stopMemberWork(roomId, botId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = rt.own(room?.sessions, botId)
    const turnRunning = sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined
    const subRunning = sessionId !== undefined && rt.hasSubagents?.(sessionId) === true
    if (room === undefined || member === undefined || sessionId === undefined || (!turnRunning && !subRunning)) return false
    dropMemberFromBatch(room, botId)
    await rt.stopSubagents?.(sessionId)
    if (turnRunning) {
      const agent = await rt.resolveAgent(sessionId)
      agent.cancel({ kind: 'user' })
    }
    await postToRoom(room, member, '', { quiet: true, stopped: true })
    return true
  }
  rt.stopMemberWork = stopMemberWork

  async function stopRoomWork(roomId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const failures = []
    const attempt = async (work) => {
      try {
        return await work()
      } catch (error) {
        rt.warn('ds-bot: stopping work in %s failed: %s', room.name, error)
        failures.push(error)
        return false
      }
    }
    const round = rt.roomActive(room.id)
    if (round) await attempt(async () => rt.stopRoomRound(room.id))
    let stopped = false
    for (const botId of room.members) stopped = (await attempt(() => stopMemberWork(room.id, botId))) || stopped
    if (failures.length > 0) throw failures[0]
    return round || stopped
  }
  rt.stopRoomWork = stopRoomWork
  Object.assign(rt, {
    workingInRoom: workingIn,
    roomBatchPending: roomId => Object.values(batches()).some(batch => batch.roomId === roomId && batch.pending.length > 0),
  })

  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const owed = info.askedBy !== undefined ? [batchOf(room.id, member.id, info.askedBy)].filter(Boolean) : batchesOf(room.id, member.id)
    for (const batch of owed) leaveBatch(room, batch, member.id, { keep: true })
    const woken = owed.find(batch => batch.pending.length === 0 && batch.done.length > 0 && !batch.answered)
    for (const batch of owed) if (batch !== woken) closeBatch(batch.key)
    const wakeCaller = woken?.by
    const { code, status, message } = failure
    noteFailure(room, member, failure)
    await postToRoom(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
      late: true,
      ...(wakeCaller ? { askedBy: wakeCaller, batch: woken.key, batchEnd: true } : { quiet: true }),
      failed: { code, ...(status ? { status } : {}), message },
    }).catch((error) => {
      if (woken !== undefined) closeBatch(woken.key)
      rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error)
    })
  }
  rt.lateRoomFailure = lateRoomFailure

  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  async function reportRound(room, post, round) {
    const lines = round.rows.filter(row => row.kind === undefined).map(row => `${row.name}: ${row.text}`)
    const waiting = round.rows.filter(row => row.kind === 'approval').map(row => row.name)
    const working = round.rows.filter(row => row.kind === 'working').map(row => row.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; read_group_chat shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.` : '',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.rows.filter(row => row.kind === 'failed').map(row => `${row.name} (${failureLine({ code: row.code, status: row.status, message: row.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    const work = post.sub === undefined ? undefined : rt.closeWork(post.sub, `Group "${room.name}"`, text)
    const late = work === undefined && post.sub !== undefined ? rt.abandonedWork?.(post.sub) : undefined
    const body = late === undefined ? text : LATE_ANSWER + text
    const back = rt.roomOf(post.fromRoomId)?.sessions?.[post.botId]
    await rt.dispatch.sendReply({ toId: post.botId, ...(back ? { sessionId: back } : {}), role: 'report', roomId: room.id, text: body, ...(work ? { work, replyTo: post.sub } : {}) })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      const room = rt.roomOf(options.sessionId)
      if (room === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))

      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
      if (!declared.has('group_relay') && !declared.has('run_code')) {
        rt.warn('ds-bot: group %s cannot relay: group_relay is not available in its Session', room.name)
        const text = 'This group could not pass the message on: its relay tool is not available. Restart DS Bot; if it keeps happening, report it.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      // Every round is new work, even though the tool needs no input. Its id keeps
      // DSH's repeat-call guard from treating consecutive relay turns as a loop.
      const roundId = `${Date.now()}-${randomUUID()}`
      // Only for a group made under the PTC preset, which can call nothing but run_code;
      // new group Sessions get the standard preset.
      const [name, args] = declared.has('run_code') && !declared.has('group_relay')
        ? ['run_code', JSON.stringify({ description: `Relay the group chat to its Bots (${roundId})`, code: `return await tools.group_relay({ roundId: ${JSON.stringify(roundId)} })`, timeoutMs: 600_000 })]
        : ['group_relay', JSON.stringify({ roundId })]
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
