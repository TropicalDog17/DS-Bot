import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createCardThreads } from './card-threads.ts'
import { HANDOFF_ACK, REPLY_KIND, SOURCE_KIND } from './constants.ts'
import {
  NOTE_TIMEOUT_MS,
  canonicalHeadings,
  carryOriginSource,
  createPartHandoff,
  handoffPackage,
  handoffSource,
  noteText,
} from './part-handoff.ts'
import {
  cardText,
  createPartView,
  handoffReply,
  historyEntry,
  questionReply,
  readReply,
  replyText,
  viewCardText,
  viewReply,
} from './part-view.ts'
import { RESUME_DELAY_MS } from './resume.ts'
import { ensureSessionIndex } from './session-index.ts'
import { createClock, estimateTokens, splitRef, textOf } from './text.ts'
import {
  activateSegmentPart,
  focusOpenPart,
  isOpenPart,
  ownChatSessions,
  pushThreadPart,
  startOpenPart,
  successorOfMovedPart,
  threadCurrent,
  threadCurrentOfPart,
  threadOf,
  threadOfPart,
} from './threads.ts'

export {
  canonicalHeadings,
  cardText,
  handoffReply,
  historyEntry,
  questionReply,
  readReply,
  replyText,
  viewCardText,
  viewReply,
}

const NOTE_COOLDOWN_MS = [60_000, 300_000, 900_000]
const SWITCH_ATTEMPTS = 5
const OVERFLOW = 'CONTEXT_WINDOW_EXCEEDED'
const STUCK_CODES = ['IMAGE_OFFLOAD_REQUIRED']
const FOLDER_RETRY_MS = 300_000
const PAUSE_NOTE = 'DS Bot paused your turn for a context check. Go on with it now from where you stopped.'

export function install(rt) {
  const { ctx, config, state } = rt
  const index = ensureSessionIndex(rt)
  const clock = createClock(config.timeZone)

  function partsOf(botId?, roomId?, segments?, currentSessionId?) {
    const room = rt.roomOf(roomId)
    if (botId === undefined) {
      if (room === undefined) return []
      const earlier = room.parts ?? []
      const parts = earlier.map((segment, idx) => ({ ...segment, number: idx + 1, startedAt: earlier[idx - 1]?.endedAt ?? room.createdAt }))
      const current = rt.sessionOfRoom(room)
      if (current !== undefined) parts.push({ sessionId: current, number: parts.length + 1, startedAt: earlier.at(-1)?.endedAt ?? room.createdAt })
      return parts
    }
    const bot = rt.botOf(botId)
    if (bot === undefined) return []
    const earlier = (room ? room.segments?.[botId] : (segments ?? bot.segments)) ?? []
    const current = room ? room.sessions?.[botId] : (currentSessionId ?? rt.chatOf(botId))
    const parts = earlier.map((segment, idx) => ({ ...segment, number: idx + 1, startedAt: earlier[idx - 1]?.endedAt ?? bot.createdAt }))
    if (current !== undefined) parts.push({ sessionId: current, number: parts.length + 1, startedAt: earlier.at(-1)?.endedAt ?? bot.createdAt })
    return parts
  }

  function partsOfThread(botId, sessionId) {
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (bot === undefined) return []
    const thread = sessionId === undefined ? undefined : threadOfPart(bot, sessionId)
    if (thread === undefined) return partsOf(bot.id)
    const current = thread.thread === 'current' ? rt.chatOf(bot.id) : bot.openParts[thread.index].sessionId
    return partsOf(bot.id, undefined, thread.segments, current)
  }

  const switches = new Map()
  const folderRetry = new Map()
  const rescued = new Map()
  const freshParts = new Map()
  const partBase = new Map<string, number>()
  const noteFailures = new Map()
  const checking = new Set()
  const cliCompactions = new Map<string, number>()
  const condensedUnmeasured = new Set<string>()
  const cutOffs = new Map()
  rt.noteCutOffTurn = (sessionId, { withoutText, premature }) => {
    if (withoutText || premature) cutOffs.set(sessionId, (cutOffs.get(sessionId) ?? 0) + 1)
    else cutOffs.delete(sessionId)
  }
  const engineRetry = new Map()
  const engineWakes = new Map()

  const placeOf = sessionId => index.placeOf(sessionId)
  const currentOf = owner => (owner.roomId === undefined ? (owner.next ?? rt.chatOf(owner.botId))
    : owner.botId === undefined ? rt.sessionOfRoom(rt.roomOf(owner.roomId))
      : rt.roomOf(owner.roomId)?.sessions?.[owner.botId])
  const threadTargetOf = (sessionId, owner) => {
    if (owner.roomId !== undefined || owner.botId === undefined) return currentOf(owner)
    const bot = rt.botOf(owner.botId)
    return owner.next ?? threadCurrentOfPart(bot, sessionId) ?? rt.chatOf(owner.botId)
  }
  const grown = (sessionId, tokens, lines) => tokens >= (partBase.get(sessionId) ?? 0) + lines.check / 4
  const readOnly = () => rt.readOnly() !== undefined

  const handoff = createPartHandoff({
    rt,
    clock,
    placeOf,
    partsOf,
    partsOfThread,
    partBase,
    cliCompactions,
    condensedUnmeasured,
  })

  async function forward(owner, messages, target = currentOf(owner)) {
    if (target === undefined || messages.length === 0) return
    await rt.ensureCapabilities(target)
    const agent = await rt.resolveAgent(target)
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    for (const message of messages) {
      const kind = message.source?.kind
      // DSH's notice of a folder change is about the Session it was queued in; the part
      // that goes on has its own folder, which its handoff names.
      if (kind === 'working-directory') continue
      const exchangeId = message.source?.exchangeId
      if (exchangeId !== undefined && pending.some(queued => queued.source?.exchangeId === exchangeId)) continue
      const copy = createUserMessage({ content: message.content, ...(message.source ? { source: message.source } : {}) })
      if (kind === 'user' || kind === SOURCE_KIND || kind === REPLY_KIND) agent.followup(copy)
      else agent.inject(copy)
      pending.push(copy)
    }
    await ctx.sessions.flush(agent.session)
  }

  // The plugin's own fiber is disposed (a reload, or DSH closing): every service
  // lookup fails with the same inactive-context error, and logging through rt.warn
  // would fail the same way, so an unloaded failure is noted once at info instead.
  const unloaded = error => ctx.fiber?.uid === null || /in inactive context/.test(String(error?.message ?? error))
  const noteInfo = (template, ...args) => { try { ctx.logger.info(template, ...args) } catch {} }

  const inboxTargetOf = message => (message.source?.kind === 'user' || message.source?.kind === SOURCE_KIND || message.source?.kind === REPLY_KIND ? 'next-turn' : 'next-step')

  const restore = (agent, messages) => {
    for (const message of [...messages].reverse()) {
      const exchangeId = message.source?.exchangeId
      const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
      if (pending.some(queued => queued.id === message.id || (exchangeId !== undefined && queued.source?.exchangeId === exchangeId))) continue
      agent.inbox.prepend(inboxTargetOf(message), message)
    }
  }

  // Input in the inbox is durable but does not wake the driver; send() is what wakes
  // it. Re-send what waits, in order, the first message with the wake.
  const wake = (agent) => {
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    for (const message of pending) agent.inbox.remove(message.id)
    pending.forEach((message, idx) => agent.send(message, inboxTargetOf(message), idx === 0))
  }

  let heldBackRun
  function heldBack() {
    heldBackRun ??= handOnHeld().finally(() => { heldBackRun = undefined })
    return heldBackRun
  }
  async function handOnHeld() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    for (const [sessionId, owner] of Object.entries(state.switching ?? {})) {
      try {
        const agent = await rt.resolveAgent(sessionId)
        const held = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
        const target = threadTargetOf(sessionId, owner)
        if (target !== sessionId) {
          await forward(owner, held, target)
          for (const message of held) agent.inbox.remove(message.id)
          await rt.moveSchedules?.(sessionId, target)
          await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
            .catch(error => rt.warn('ds-bot: earlier part %s not archived: %s', sessionId, error))
        } else {
          try { wake(agent) } catch (error) { rt.warn('ds-bot: part %s could not be woken for its kept input: %s', sessionId, error) }
        }
        delete state.switching[sessionId]
        await rt.save()
      } catch (error) {
        rt.warn('ds-bot: input kept in part %s was not handed on: %s', sessionId, error)
      }
    }
  }

  function startSwitch(agent, { resume = false, carry = [], info, joined, overflow = false, failed, bare = false, folder = false, manual = false, cutoff = false, engine = false, hard = overflow || folder || manual || engine || cutoff }: Record<string, any> = {}) {
    const place = placeOf(agent.id)
    if (place === undefined || switches.has(agent.id) || readOnly()) return
    const resumeOrigin = resume || place.botId === undefined ? rt.replyOrigin?.hold(agent.id) : undefined
    const job: Record<string, any> = { ...place, carry: [...carry], info, joined, resume, resumeOrigin, overflow, failed, bare, folder, engine, hard, manual, cutoff, since: Date.now() }
    switches.set(agent.id, job)
    void runSwitch(agent, job)
      .catch(error => {
        const name = rt.botOf(job.botId)?.name ?? rt.roomOf(job.roomId)?.name ?? agent.id
        if (unloaded(error)) return noteInfo('ds-bot: plugin unloaded while %s switched parts; input kept in part %s', name, agent.id)
        rt.warn('ds-bot: %s did not move on to a fresh part: %s', name, error)
      })
      .finally(async () => {
        switches.delete(agent.id)
        if (job.moved) {
          if (!job.originSent) rt.replyOrigin?.release(job.resumeOrigin)
          if (job.kept !== true) {
            delete state.switching[agent.id]
            await rt.save()
          }
          noteFailures.delete(agent.id)
          folderRetry.delete(agent.id)
          engineRetry.delete(agent.id)
          void followFolder(job)
          return
        }
        if (folder) folderRetry.set(agent.id, Date.now() + FOLDER_RETRY_MS)
        if (job.engine) engineRetry.set(agent.id, Date.now() + FOLDER_RETRY_MS)
        if (!job.noteFailed) partBase.set(agent.id, handoff.sizeOf(agent.session) ?? 0)
        const back = job.carry.splice(0)
        const noted = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => textOf(message.content) === PAUSE_NOTE)
        if (resume && !back.some(message => textOf(message.content) === PAUSE_NOTE) && !noted) {
          const carried = job.joined?.length ? { joined: job.joined } : {}
          back.unshift(createUserMessage({
            content: [{ type: 'text', text: PAUSE_NOTE }],
            source: carryOriginSource(job, job.info
              ? { ...job.info, ...carried }
              : { kind: SOURCE_KIND, form: 'relay', role: 'resume', exchangeId: randomUUID(), senderName: 'DS Bot', ...carried }),
          }))
        }
        await forward(job, back, threadTargetOf(agent.id, job)).then(() => {
          delete state.switching[agent.id]
        }).catch((error) => {
          job.kept = true
          try { restore(agent, back) } catch {}
          if (unloaded(error)) return noteInfo('ds-bot: plugin unloaded during the switch of %s; input kept in part %s', agent.id, agent.id)
          rt.warn('ds-bot: input for %s was not handed on: %s', agent.id, error)
          try { wake(agent) } catch {}
        })
        if (!job.originSent) rt.replyOrigin?.release(job.resumeOrigin)
        await rt.save()
      })
      // A state write that fails here must not end up as an unhandled rejection.
      .catch(error => rt.warn('ds-bot: the switch of %s did not finish: %s', agent.id, error))
  }

  async function runSwitch(agent, job) {
    state.switching[agent.id] = job.roomId === undefined ? { botId: job.botId } : { botId: job.botId, roomId: job.roomId }
    await rt.save()
    for (let attempt = 1; ; attempt += 1) {
      await agent.whenIdle()
      try {
        await agent.runMaintenance(signal => moveOn(agent, job, signal))
        break
      } catch (error) {
        if (!job.started && attempt < SWITCH_ATTEMPTS) continue
        throw error
      }
    }
    if (job.moved) {
      rt.renewMemory(agent.id)
      await rt.closeLocalAgentSession?.(agent.id)?.catch(error => rt.warn('ds-bot: the local agent of earlier part %s did not stop: %s', agent.id, error))
      try {
        await rt.moveSchedules(agent.id, job.next ?? currentOf(job))
      } catch (error) {
        job.kept = true
        throw error
      }
      await ctx.workspaceRegistry.archiveSession(agent.id, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: earlier part %s not archived: %s', agent.id, error))
    }
  }

  async function freshRoute(bot, session) {
    const ref = await rt.desiredModel(bot)
    if (ref !== undefined) return { ref, effort: await rt.desiredEffort(bot, ref) }
    const route = session.requestHeader()?.config
    return route?.provider && route?.model ? { ref: `${route.provider}/${route.model}`, effort: route.reasoningEffort } : undefined
  }
  const selectRoute = (named, sessionId, { ref, effort }) => rt.selectSessionModel(sessionId, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    .then(() => true, (error) => {
      rt.warn('ds-bot: model for the fresh part of %s not applied: %s', named.name, error)
      return false
    })

  const engineOfRoute = route => (route?.provider && route?.model ? rt.engineOf?.(`${route.provider}/${route.model}`) : undefined)
  function offEngine(agent, place, selection?) {
    const wanted = place?.botId === undefined ? undefined : rt.engineOfBot?.(rt.botOf(place.botId))
    if (wanted === undefined) return false
    return [agent.session.requestHeader?.()?.config, selection].some(route => engineOfRoute(route) !== undefined && engineOfRoute(route) !== wanted)
  }
  const engineMoved = (agent, place, selection?) => Date.now() >= (engineRetry.get(agent.id) ?? 0) && offEngine(agent, place, selection)

  function holdStep(agent, payload) {
    restore(agent, payload.messages)
    rt.warn('ds-bot: %s waits for a part on what it runs on now; its input is kept', rt.botOf(placeOf(agent.id)?.botId)?.name ?? agent.id)
    if (!readOnly() && !engineWakes.has(agent.id)) {
      const place = placeOf(agent.id)
      const timer = setTimeout(() => {
        engineWakes.delete(agent.id)
        if (place === undefined || currentOf(place) !== agent.id) return
        try { wake(agent) } catch (error) { rt.warn('ds-bot: part %s could not be woken for its kept input: %s', agent.id, error) }
      }, Math.max(0, (engineRetry.get(agent.id) ?? 0) - Date.now()))
      timer.unref?.()
      engineWakes.set(agent.id, timer)
    }
    return takeOverStep(agent, payload)
  }
  ctx.effect(() => () => {
    for (const timer of engineWakes.values()) clearTimeout(timer)
    engineWakes.clear()
  }, 'ds-bot: wake parts that wait for their run mode')

  async function moveOn(agent, job, signal) {
    job.started = true
    const bot = job.botId === undefined ? undefined : rt.botOf(job.botId)
    const room = rt.roomOf(job.roomId)
    if (bot === undefined ? room === undefined
      : job.roomId !== undefined && (room === undefined || !room.members.includes(bot.id))) return
    const thread = bot === undefined || room !== undefined ? undefined : threadOf(bot, agent.id)
    if (bot !== undefined && room === undefined && thread === undefined) return
    job.engine ||= engineMoved(agent, job)
    const name = bot?.name ?? room?.name ?? agent.id
    const session = agent.session
    const tokens = handoff.sizeOf(session)
    const lines = await handoff.contextLines(session).catch(() => undefined)
    const parts = bot === undefined ? partsOf(undefined, room.id) : partsOf(bot.id, room?.id, thread?.segments, thread === undefined ? undefined : agent.id)
    const number = parts.length
    const budget = Math.min(handoff.RECENT_TOKENS, Math.floor((lines?.check ?? 4 * handoff.RECENT_TOKENS) / 4))
    const readLines = (): any => (job.bare ? { recent: [], earlier: [], unlisted: 0, complete: true } : handoff.handoffLines(agent.id, { budget, group: room !== undefined, number }))
    let carried = job.folder ? await readLines() : undefined
    const whole = carried?.whole === true && !session.deriveMessages().some(message => message.role === 'tool')
    let written
    let failure
    const local = handoff.localPart(session)
    if (!job.engine && !job.overflow && job.cutoff !== true && job.failed === undefined && !whole && bot !== undefined) {
      try {
        const noteSignal = AbortSignal.any([signal, AbortSignal.timeout(NOTE_TIMEOUT_MS)])
        written = local ? await handoff.writeLocalNote(agent, noteSignal, { folder: job.folder }) : await handoff.writeNote(agent, noteSignal, { folder: job.folder })
      } catch (error) {
        if (signal.aborted) throw error
        failure = error
      }
    }
    if (written === undefined && !job.hard && !job.engine && !local) {
      const count = (noteFailures.get(agent.id)?.count ?? 0) + 1
      const wait = NOTE_COOLDOWN_MS[Math.min(count, NOTE_COOLDOWN_MS.length) - 1]
      noteFailures.set(agent.id, { count, until: Date.now() + wait })
      job.noteFailed = true
      rt.warn('ds-bot: handoff note for %s failed (%d in a row); part %d goes on, next try in %ds: %s', name, count, number, wait / 1000, failure)
      return
    }
    if (failure !== undefined) rt.warn('ds-bot: handoff note for %s failed past the hard line; moving on with the earlier note: %s', name, failure)
    const previous = parts.at(-2)
    const earlierNote = previous?.note ? { note: previous.note, noteFrom: previous.noteFrom ?? previous.number } : {}
    const noted: Record<string, any> = written !== undefined ? { note: written.note }
      : job.engine ? { fallback: 'engine', ...earlierNote }
      : { fallback: whole ? 'whole' : job.failed !== undefined ? 'failure' : job.overflow ? 'overflow' : job.cutoff === true ? 'cutoff' : 'failed', ...earlierNote }
    carried ??= await readLines()
    if (signal.aborted) throw signal.reason
    const dir = rt.workDirOf(job)
    const intended = dir !== undefined && await rt.isFolder(dir) ? dir : rt.teamFolder()
    const freshId = await rt.createSession(room === undefined ? name : bot === undefined ? room.name : `${name} · ${room.name}`, { dir })
    // The group's own Session never asks the model, so it takes the team's default; the
    // earlier part's route may be one DSH no longer serves (#1310).
    if (bot === undefined) await rt.selectRoomSession(freshId)
    const picked = bot === undefined ? undefined : await freshRoute(bot, session)
    if (picked !== undefined && !await selectRoute({ name }, freshId, picked) && job.engine) engineRetry.set(freshId, Date.now() + FOLDER_RETRY_MS)
    if (bot !== undefined) await rt.applyPermission(bot, freshId, room)
      .catch(error => rt.warn('ds-bot: permission for the fresh part of %s not applied: %s', name, error))
    const current = bot === undefined ? rt.sessionOfRoom(room)
      : room !== undefined ? room.sessions?.[bot.id]
        : thread === undefined ? rt.chatOf(bot.id) : threadCurrent(bot, agent.id)
    const gone = bot === undefined ? rt.roomOf(room.id) !== room
      : rt.botOf(bot.id) === undefined || (room !== undefined && (rt.roomOf(room.id) !== room || !room.members.includes(bot.id)))
    if (gone || current !== agent.id) {
      await ctx.workspaceRegistry.archiveSession(freshId, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused fresh part of %s not archived: %s', name, error))
      return
    }
    const segment = { sessionId: agent.id, endedAt: Date.now(), ...(tokens !== undefined ? { tokens } : {}), ...noted }
    if (bot === undefined) {
      ;(room.parts ??= []).push(segment)
      room.sessionId = freshId
      if (job.resumeOrigin !== undefined) rt.replyOrigin?.peek(freshId, job.resumeOrigin)
    } else if (room !== undefined) {
      room.segments ??= {}
      ;(room.segments[bot.id] ??= []).push(segment)
      room.sessions[bot.id] = freshId
    } else {
      pushThreadPart(bot, agent.id, freshId, segment)
      const successor = successorOfMovedPart(bot, freshId)
      if (successor !== undefined) {
        job.next = successor
        if (state.switching[agent.id] !== undefined) state.switching[agent.id].next = successor
      }
      if (state.questions[agent.id] !== undefined) {
        const pending = state.questions[agent.id]
        state.questions[freshId] = pending.callId && !pending.callSessionId ? { ...pending, callSessionId: agent.id } : pending
        delete state.questions[agent.id]
      }
      if (state.views?.[agent.id] !== undefined) {
        const pending = state.views[agent.id]
        state.views[freshId] = pending.callId && !pending.callSessionId ? { ...pending, callSessionId: agent.id } : pending
        delete state.views[agent.id]
      }
    }
    await rt.save()
    const now = bot === undefined ? undefined : await freshRoute(bot, session)
    if (now !== undefined && (now.ref !== picked?.ref || now.effort !== picked?.effort)) await selectRoute({ name }, freshId, now)
    if (job.failed !== undefined) rescued.set(freshId, job.bare ? 'bare' : 'carried')
    job.moved = true
    const resume = job.resume || job.overflow
    const held = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    const carry = []
    let folder
    try {
      await rt.ensureCapabilities(freshId)
      const fresh = await rt.resolveAgent(freshId)
      const cwd = fresh.session.header?.cwd
      folder = cwd !== undefined && cwd !== session.header?.cwd ? cwd : undefined
      if (intended !== undefined && cwd !== undefined && cwd !== intended) {
        folderRetry.set(freshId, Date.now() + FOLDER_RETRY_MS)
        rt.warn('ds-bot: the fresh part of %s did not start in %s; it works in %s', name, intended, cwd)
      }
      const engine = job.engine ? rt.engineNameOf?.(bot.model ?? bot.appliedModel) : undefined
      const text = handoffPackage({ room, self: bot === undefined, segment, lines: carried, number: number + 1, resume, overflow: job.overflow, cutoff: job.cutoff === true, failed: job.failed, bare: job.bare, folder, manual: job.manual, engine })
      freshParts.set(freshId, estimateTokens(text))
      fresh.followup(createUserMessage({ content: [{ type: 'text', text }], source: handoffSource(job, resume) }))
      await ctx.sessions.flush(fresh.session)
      carry.push(...job.carry.splice(0))
      await forward(job, [...carry, ...held], freshId)
    } catch (error) {
      job.kept = true
      try { restore(agent, [...carry, ...job.carry.splice(0)]) } catch {}
      throw error
    }
    for (const message of held) agent.inbox.remove(message.id)
    for (let late = job.carry.splice(0); late.length > 0; late = job.carry.splice(0)) {
      await forward(job, late, threadTargetOf(agent.id, job)).catch((error) => {
        job.kept = true
        try { restore(agent, late) } catch {}
        throw error
      })
    }
    ctx.logger.info('ds-bot: %s%s moved on to part %d at %d tokens (check line %d, hard line %d); %s; %d latest and %d earlier messages carried%s', name, bot !== undefined && room !== undefined ? ` in ${room.name}` : '', number + 1, tokens ?? -1, lines?.check ?? -1, lines?.hard ?? -1,
      written !== undefined ? `note written in ${written.attempts} attempt(s)` : `note put together by DS Bot (${noted.fallback}${noted.note ? `, carries part ${noted.noteFrom}'s` : ', nothing to carry'})`,
      carried.recent.length, carried.earlier.length, folder === undefined ? '' : `; now works in ${folder}`)
  }

  // Before a turn's first step an empty batch ends the turn as completed, whereas a reject
  // ends it as blocked. Later in a turn an empty batch would run another model step.
  const takeOverStep = (agent, payload) => (payload.step === 1 && rt.live.get(agent.id)?.carried !== true
    ? { kind: 'enter', messages: [] }
    : { kind: 'reject' })

  ctx.on('agent/pre-step', async (payload, next) => {
    await rt.load()
    const { agent } = payload
    const past = index.pastOwners.get(agent.id)
    if (past !== undefined && !rt.isBotSession(agent.id)) {
      await forward(past, payload.messages, threadTargetOf(agent.id, past)).catch(error => rt.warn('ds-bot: input for %s was not handed on: %s', agent.id, error))
      return takeOverStep(agent, payload)
    }
    const place = placeOf(agent.id)
    if (place === undefined) return next()
    handoff.adoptCompaction(agent)
    const job = switches.get(agent.id)
    if (job !== undefined) {
      job.carry.push(...payload.messages)
      return takeOverStep(agent, payload)
    }
    const fresh = freshParts.get(agent.id)
    if (fresh !== undefined) {
      freshParts.delete(agent.id)
      partBase.set(agent.id, (handoff.sizeOf(agent.session) ?? 0) + fresh)
    }
    if (!readOnly() && await folderMove(agent, { midTurn: payload.step > 1 }) !== undefined) return switchBeforeStep(agent, payload, { folder: true })
    if (place.botId === undefined) return next()
    if (!readOnly() && engineMoved(agent, place, payload.modelSelection)) return switchBeforeStep(agent, payload, { engine: true })
    if (offEngine(agent, place, payload.modelSelection)) return holdStep(agent, payload)
    if (handoff.localPart(agent.session)) return next()
    const lines = await handoff.contextLines(agent.session).catch(() => undefined)
    const tokens = handoff.tokensOf(agent.session)
    if (lines === undefined || tokens === undefined || tokens < lines.hard || !grown(agent.id, tokens, lines) || readOnly()) return next()
    if (await handoff.decide(agent, { midTurn: payload.step > 1 }) === 'compact' && await handoff.condense(agent, lines, { inTurn: true, signal: payload.signal })) return next()
    if (!await handoff.canMakeRoom(agent, payload.messages)) return next()
    return switchBeforeStep(agent, payload, { hard: true })
  }, { prepend: true })

  function switchBeforeStep(agent, payload, options) {
    const running = switches.get(agent.id)
    if (running !== undefined) {
      running.carry.push(...payload.messages)
      return takeOverStep(agent, payload)
    }
    const entry = rt.liveOf(agent.id)
    const midTurn = payload.step > 1 || entry.carried === true
    entry.switched = true
    startSwitch(agent, { resume: midTurn, carry: payload.messages, info: midTurn ? entry.info : undefined, joined: midTurn ? [...(entry.joined ?? [])] : undefined, ...options })
    return takeOverStep(agent, payload)
  }

  async function folderMove(agent, { midTurn = false } = {}) {
    const place = placeOf(agent.id)
    const cwd = agent.session.header?.cwd
    if (place === undefined || cwd === undefined || (midTurn && place.roomId !== undefined) || Date.now() < (folderRetry.get(agent.id) ?? 0)) return undefined
    const wanted = rt.workDirOf(place)
    const usable = wanted !== undefined && await rt.isFolder(wanted)
    if (!usable && rt.teamFolder() === undefined) await rt.ensureWorkspace()
    const target = usable ? wanted : rt.teamFolder()
    return target === undefined || target === cwd ? undefined : target
  }

  // DSH 0.2.1 checks a Session's folder as it puts each model request together, before
  // agent/pre-step, and fails the turn when both the folder and the one the Session was
  // made in are gone.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context.agent
    const folders = ctx.get?.('workingDirectory')
    if (agent === undefined || typeof folders?.get !== 'function' || readOnly()) return next()
    const current = folders.get(agent.session)
    if (current === undefined) return next()
    await rt.load()
    if (rt.roomOf(agent.id) !== undefined) {
      if (current === rt.teamFolder() && await rt.isFolder(current)) return next()
      const team = await rt.keepTeamFolder()
      if (team === undefined) return next()
      if (current !== team) {
        await folders.set(agent, team, context.signal)
          .catch(error => rt.warn('ds-bot: the group chat works in %s and could not change to %s: %s', current, team, error))
      }
      return next()
    }
    const place = placeOf(agent.id)
    const wanted = rt.workDirOf(place)
    const usable = wanted !== undefined && await rt.isFolder(wanted)
    if (!usable) await rt.roomFolderNotice?.(place?.roomId, wanted)
    if (await rt.isFolder(current)) return next()
    const team = await rt.keepTeamFolder()
    if (current === team || !rt.isBotSession(agent.id)) return next()
    const target = usable ? wanted : team
    if (target !== undefined) {
      await folders.set(agent, target, context.signal)
        .catch(error => rt.warn('ds-bot: %s works in %s, which is gone, and could not change to %s: %s', rt.botOf(place?.botId)?.name ?? agent.id, current, target, error))
    }
    return next()
  }, { prepend: true })

  async function followFolder(owner) {
    const bot = owner.roomId === undefined && owner.botId !== undefined ? rt.botOf(owner.botId) : undefined
    const sessions = bot === undefined ? [currentOf(owner)] : ownChatSessions(bot)
    const name = owner.botId === undefined ? rt.roomOf(owner.roomId)?.name ?? owner.roomId : rt.botOf(owner.botId)?.name ?? owner.botId
    for (const sessionId of sessions) {
      if (sessionId === undefined || switches.has(sessionId) || readOnly()) continue
      try {
        const agent = await rt.resolveAgent(sessionId)
        if (agent.status === 'idle' && await folderMove(agent) !== undefined) startSwitch(agent, { folder: true })
      } catch (error) {
        rt.warn('ds-bot: %s did not move to its working folder: %s', name, error)
      }
    }
  }

  async function followEngine(botId) {
    for (const sessionId of [...ownChatSessions(rt.botOf(botId)), ...rt.groupSessionsOf(botId)]) {
      if (sessionId === undefined || switches.has(sessionId) || readOnly()) continue
      engineRetry.delete(sessionId)
      try {
        const agent = await rt.resolveAgent(sessionId)
        if (agent.status === 'idle' && engineMoved(agent, placeOf(sessionId))) startSwitch(agent, { engine: true })
      } catch (error) {
        rt.warn('ds-bot: %s did not follow its run mode in %s: %s', rt.botOf(botId)?.name ?? botId, sessionId, error)
      }
    }
  }

  ctx.on('agent/request-error', async (payload, next) => {
    const failure = payload.failure
    if (!STUCK_CODES.includes(failure?.code)) return next()
    const decided = await next()
    if (decided !== undefined || payload.signal?.aborted) return decided
    await rt.load()
    const { agent } = payload
    if (!rt.isBotSession(agent.id) || switches.has(agent.id) || readOnly() || rescued.get(agent.id) === 'bare') return decided
    const entry = rt.liveOf(agent.id)
    entry.switched = true
    startSwitch(agent, { resume: true, info: entry.info, joined: [...(entry.joined ?? [])], overflow: true, failed: failure.code, bare: rescued.has(agent.id) })
    return undefined
  }, { prepend: true })

  ctx.on('agent/request-error', async (payload, next) => {
    if (payload.failure?.code !== OVERFLOW || payload.signal?.aborted) return next()
    await rt.load()
    const { agent } = payload
    if (!rt.isBotSession(agent.id) || switches.has(agent.id) || readOnly() || !await handoff.canMakeRoom(agent)) return next()
    const entry = rt.liveOf(agent.id)
    entry.switched = true
    startSwitch(agent, { resume: true, info: entry.info, joined: [...(entry.joined ?? [])], overflow: true })
    return undefined
  }, { prepend: true })

  async function checkContext(agent) {
    if (switches.has(agent.id) || freshParts.has(agent.id) || checking.has(agent.id) || readOnly()) return
    if (lastTurnEnd(agent)?.data?.reason?.kind === 'error') return
    if (handoff.localPart(agent.session)) return checkLocal(agent)
    if ((cutOffs.get(agent.id) ?? 0) >= 2) {
      if (await handoff.canMakeRoom(agent)) {
        cutOffs.delete(agent.id)
        startSwitch(agent, { cutoff: true })
      }
      return
    }
    const lines = await handoff.contextLines(agent.session)
    const tokens = handoff.tokensOf(agent.session)
    if (lines === undefined || tokens === undefined || tokens < lines.check || !grown(agent.id, tokens, lines)) return
    const hard = tokens >= lines.hard
    if (!hard && Date.now() < (noteFailures.get(agent.id)?.until ?? 0)) return
    checking.add(agent.id)
    try {
      if (await handoff.decide(agent, { midTurn: false }) === 'compact') {
        const condensed = await handoff.condense(agent, lines, { inTurn: false })
        if (condensed !== false) return
      }
      if (switches.has(agent.id)) return
      if (!await handoff.canMakeRoom(agent)) return
      startSwitch(agent, { hard: (handoff.tokensOf(agent.session) ?? tokens) >= lines.hard })
    } finally {
      checking.delete(agent.id)
    }
  }

  async function checkLocal(agent) {
    const context = rt.localAgentContext?.(agent.id)
    const lines = await handoff.contextLines(agent.session).catch(() => undefined)
    if (context === undefined || lines === undefined) return
    const tokens = context.used
    const condensed = context.compactions > (cliCompactions.get(agent.id) ?? 0)
    cliCompactions.set(agent.id, context.compactions)
    if (condensedUnmeasured.has(agent.id) && tokens !== undefined) {
      condensedUnmeasured.delete(agent.id)
      if (tokens >= lines.check) {
        if (await handoff.canMakeRoom(agent)) startSwitch(agent, { hard: tokens >= lines.hard })
        return
      }
    }
    const past = tokens !== undefined && tokens >= lines.check && grown(agent.id, tokens, lines)
    if (!past && !condensed) return
    checking.add(agent.id)
    try {
      if (await handoff.decide(agent, { midTurn: false }) === 'compact') {
        if (!past) {
          partBase.set(agent.id, tokens ?? 0)
          return
        }
        if (await handoff.condense(agent, lines, { inTurn: false }) !== false) return
      }
      if (switches.has(agent.id) || !await handoff.canMakeRoom(agent)) return
      startSwitch(agent, { hard: (handoff.sizeOf(agent.session) ?? tokens ?? 0) >= lines.hard })
    } finally {
      checking.delete(agent.id)
    }
  }

  function lastTurnEnd(agent) {
    const latest = agent.session.seq - 1
    for (let seq = latest; seq >= Math.max(0, latest - 199); seq -= 1) {
      const event = agent.session.eventAt?.(seq)
      if (event?.type === 'turn/end') return event
    }
    return undefined
  }

  function releaseRescued(agent) {
    if (!rescued.has(agent.id)) return
    const end = lastTurnEnd(agent)
    if (end !== undefined && end.data?.reason?.kind !== 'error') rescued.delete(agent.id)
  }

  ctx.effect(() => {
    const timer = setTimeout(() => void heldBack().catch(error => rt.warn('ds-bot: handing on input kept in earlier parts failed: %s', error)), RESUME_DELAY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'ds-bot: hand on input kept in earlier parts')

  // An archive from DSH's own Session list while the team runs: an unarchive started here
  // queues behind that archive and undoes it.
  const keepCurrent = ({ sessionId }) => {
    if (readOnly() || !(rt.isBotSession(sessionId) || index.roomOwners.has(sessionId))) return
    void ctx.workspaceRegistry.unarchiveSession(sessionId)
      .catch(error => rt.warn('ds-bot: current Session %s is archived in DSH and could not be taken out: %s', sessionId, error))
  }
  ctx.on('workspace/session-stop', keepCurrent)
  ctx.on('workspace/session-activity', (request, next) => {
    keepCurrent(request)
    return next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && rt.isBotSession(agent.id)) {
      releaseRescued(agent)
      void checkContext(agent).catch(error => rt.warn('ds-bot: context check for %s failed: %s', agent.id, error))
    }
  })

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    const messages = options.messages ?? []
    const since = messages.findLastIndex(message => message.role === 'assistant' || message.role === 'tool') + 1
    const opened = messages.slice(since).filter(message => message.role === 'user' && (message.source?.kind === 'user' || message.source?.kind === SOURCE_KIND))
    const bare = opened.length > 0 && opened.every(message => message.source.kind === SOURCE_KIND && message.source.handoff === true && message.source.resume !== true)
    if (!bare) return next()
    return (async function* acknowledge() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: HANDOFF_ACK }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: HANDOFF_ACK } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  const partView = createPartView({ rt, partsOf, partsOfThread })
  rt.chatTail = partView.chatTail

  async function newPart(sessionId) {
    await rt.load()
    const agent = await rt.resolveAgent(sessionId)
    const place = placeOf(sessionId)
    if (place?.botId === undefined || place.roomId !== undefined) throw Object.assign(new Error('Only a Bot\'s own chat can start a fresh part'), { code: 'bot/invalid' })
    if (agent.status === 'idle') {
      startSwitch(agent, { manual: true })
      return true
    }
    const bot = rt.botOf(place.botId)
    if (bot === undefined || switches.has(sessionId)) throw Object.assign(new Error('The Bot is working; wait for it to finish or stop it first'), { code: 'bot/busy' })
    await openPartNow(bot, agent)
    return true
  }

  async function openPartNow(bot, agent) {
    const dir = rt.workDirOf({ botId: bot.id })
    const freshId = await rt.createSession(bot.name, { dir })
    const picked = await freshRoute(bot, agent.session)
    if (picked !== undefined) await selectRoute({ name: bot.name }, freshId, picked)
    await rt.applyPermission(bot, freshId, undefined)
      .catch(error => rt.warn('ds-bot: permission for the new part of %s not applied: %s', bot.name, error))
    if (rt.botOf(bot.id) !== bot) {
      await ctx.workspaceRegistry.archiveSession(freshId, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused fresh part of %s not archived: %s', bot.name, error))
      return
    }
    startOpenPart(bot, freshId)
    index.registerChat(freshId, bot.id)
    await rt.save()
    const now = await freshRoute(bot, agent.session)
    if (now !== undefined && (now.ref !== picked?.ref || now.effort !== picked?.effort)) await selectRoute({ name: bot.name }, freshId, now)
  }

  async function switchPart(botId, partId) {
    await rt.load()
    const bot = rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    const current = rt.chatOf(botId)
    if (partId === current) return false
    if (isOpenPart(bot, partId)) {
      focusOpenPart(bot, partId)
      await rt.applyModel(bot, { force: true }).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
      await rt.applyPermission(bot, partId, undefined).catch(() => {})
      await rt.save()
      return true
    }
    if (!(bot.segments ?? []).some(segment => segment.sessionId === partId)) {
      throw Object.assign(new Error('Unknown part'), { code: 'bot/not-found' })
    }
    const live = rt.live.get(current)
    if (live?.turn !== undefined) throw Object.assign(new Error('The Bot is working; wait for it to finish or stop it first'), { code: 'bot/busy' })
    // DSH turns away every step of an archived Session and every task aimed at it.
    await ctx.workspaceRegistry.unarchiveSession(partId)
    activateSegmentPart(bot, partId)
    index.swapChatPart(current, partId, botId)
    state.switching[current] = { botId }
    if (state.questions[current] !== undefined) {
      rt.closeCard(current, state.questions[current], 'dismissed')
      delete state.questions[current]
    }
    if (state.views?.[current] !== undefined) {
      rt.closeCard(current, state.views[current], 'dismissed')
      delete state.views[current]
    }
    await rt.applyModel(bot, { force: true }).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    await rt.applyPermission(bot, partId, undefined).catch(() => {})
    await rt.save()
    try {
      await rt.moveSchedules?.(current, partId)
      await ctx.workspaceRegistry.archiveSession(current, { stopActivity: true })
      delete state.switching[current]
      await rt.save()
    } catch (error) {
      rt.warn('ds-bot: earlier part %s not archived: %s', current, error)
    }
    return true
  }

  const cardThreads = createCardThreads({ rt, freshRoute, selectRoute })
  const cardOfSession = sessionId => cardThreads.ofSession(sessionId)?.cardId
  Object.assign(rt, {
    cardThreads,
    clock,
    partsOf,
    partsOfThread,
    historyEntry,
    partLines: handoff.partLines,
    noteText,
    earlierPage: partView.earlierPage,
    chatPage: partView.chatPage,
    displayItems: partView.displayItems,
    applySteps: partView.applySteps,
    followFolder,
    followEngine,
    heldBack,
    newPart,
    switchPart,
    openCardThread: cardThreads.open,
    closeCardThread: cardThreads.close,
    cardTurnEnded: cardThreads.turnEnded,
    cardOfSession,
    cardSession: cardThreads.sessionOf,
    sessionTokens: session => handoff.tokensOf(session),
    switchJobs: () => switches.values(),
  })
}
