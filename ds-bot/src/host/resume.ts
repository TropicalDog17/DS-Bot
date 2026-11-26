// DSH closes a turn it never finished as interrupted when the Session next opens, and a
// clean shutdown also cancels the messages still waiting in a Session's inbox.
// A Bot's background job (a command it started with run_in_background) dies with DSH,
// and DSH forgets it.
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND, STEER_CUT } from './constants.ts'
import { createSettlement, cutOffText, turnFailure } from './settlement.ts'
import { textOf } from './text.ts'
import { reach, threadCurrentOfPart } from './threads.ts'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

export const LABEL_MAX = 300
export const jobsText = jobs => [
  jobs.length === 1
    ? 'DeepSeek Harness restarted and stopped your background job, so it will not finish or wake you:'
    : `DeepSeek Harness restarted and stopped ${jobs.length} of your background jobs, so they will not finish or wake you:`,
  ...jobs.map(job => `- ${job.kind ?? 'job'} started ${new Date(job.since).toISOString()}: ${clip(job.label)}`),
  'What it ran or waited for (a herdr pane, a test run) may still be going or already done. Check that first, then start the wait again if you still need it, or go on with the work.',
].join('\n')
const clip = label => (String(label ?? '').length > LABEL_MAX ? `${String(label).slice(0, LABEL_MAX - 1)}…` : String(label ?? ''))

export function jobFate(events, jobId) {
  const settled = events.findLast(event => event?.type === 'job/settled' && event.data?.jobId === jobId)
  if (settled === undefined) return undefined
  return settled.data.cause === 'teardown' ? 'stopped' : 'settled'
}

export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && turn.reason.reason?.reason === STEER_CUT
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
}

export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.senderPart ? { senderPart: info.senderPart } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued), jobs: object(parsed?.jobs) }
  } catch {
    return { turns: {}, queued: {}, jobs: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const settlement = rt.settlement ??= createSettlement(rt)
  const file = join(home, 'inflight.json')

  let interrupted = readNotes(file)

  let turns = {}
  let queued = interrupted.queued
  let jobs = interrupted.jobs
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued, jobs })
    if (due) return
    due = true
    // Written in place: a rename over the file fails on Windows while anything reads
    // it, and a torn write only loses what one restart would pick up.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      await writeFile(file, snapshot, 'utf8')
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
    for (const [sessionId, list] of Object.entries(queued) as [string, any][]) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }

  rt.dispatch.attachOutbox({
    queue(sessionId, args) {
      queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args }] }
      persist()
    },
    forget: forgetQueued,
  })

  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued

  ctx.on('agent/inbox/discarded', ({ message }: Record<string, any> = {}) => {
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
  })
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  function cardLocation(sessionId) {
    const owner = rt.ownerOfSession?.(sessionId)
    if (owner?.cardId === undefined) return {}
    const { cardId, roomId } = owner
    return { cardId, ...(roomId === undefined ? {} : { roomId }) }
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'job/registered': {
        const data = event.data ?? {}
        if (typeof data.jobId !== 'string') break
        jobs = { ...jobs, [data.jobId]: { sessionId: id, botId: rt.selfOf(id), ...cardLocation(id), kind: data.kind, label: clip(data.label), since: data.startedAt ?? event.time ?? Date.now() } }
        persist()
        break
      }
      case 'job/settled': {
        const jobId = event.data?.jobId
        if (event.data?.cause === 'teardown' || jobs[jobId] === undefined) break
        jobs = { ...jobs }
        delete jobs[jobId]
        persist()
        break
      }
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        const info = rt.live.get(id)?.info
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : cardLocation(id)), since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}) }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') break
        update(id, () => undefined)
        break
      }
    }
  })

  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  async function resumeTurn(sessionId, record, stopped = []) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const text = stopped.length === 0 ? resumeText(record) : `${resumeText(record)}\n\n${jobsText(stopped)}`
    const { cardId, roomId } = record
    const room = roomId === undefined ? undefined : rt.roomOf(roomId)
    const target = reach(bot, { cardId, roomId, room })
    if (roomId !== undefined && (target.where === 'group' || cardId === undefined)) {
      if (room === undefined || !room.members.includes(bot.id)) return
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      if (record.resumed) return
      await rt.dispatch.sendGroupTurn({ toId: bot.id, sessionId: target.where === 'group' ? target.sessionId : sessionId, roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return
    }
    if (record.resumed) return
    const ownPart = cardId !== undefined ? { sessionId: target.sessionId }
      : rt.selfOf(sessionId) === bot.id && rt.isBotSession(sessionId) ? { sessionId } : {}
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      await rt.dispatch.sendReply({ fromId: trigger.senderSessionId, toId: bot.id, ...ownPart, ...(trigger.senderPart ? { fromPart: trigger.senderPart } : {}), role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
      return
    }
    await rt.dispatch.sendNotice({ toId: bot.id, ...ownPart, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}) })
  }

  const sessionFor = (sessionId, args) => {
    if (rt.isBotSession(sessionId)) return sessionId
    const roomId = args?.roomId
    const target = reach(rt.botOf(args?.toId), { roomId, room: roomId === undefined ? undefined : rt.roomOf(roomId) })
    return roomId === undefined || target.where === 'group' ? target.sessionId : undefined
  }

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. The notes stay queued until a turn takes the messages
  // up, so a send that fails here, or a Session that cannot be opened, leaves them
  // for the next start instead of losing them.
  async function resendQueued(sessionId, list) {
    const fresh = list.filter(item => rt.botOf(item.args?.toId) !== undefined
      && sessionFor(sessionId, item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
    if (fresh.length === 0) return
    const target = sessionFor(sessionId, fresh[0].args)
    const agent = await rt.resolveAgent(target)
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source?.exchangeId))
    for (const { args } of fresh) {
      if (waiting.has(args.exchangeId)) continue
      if (taken?.has(args.exchangeId) === true) {
        forgetQueued(args.exchangeId)
        continue
      }
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      await rt.dispatch.resend({ ...args, sessionId: sessionFor(sessionId, args) })
        .catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
  }

  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
  }

  async function reconcileEnded(sessionId, record, ended) {
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return
    const exchangeId = trigger.exchangeId
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const events = await logOf(sessionId)
    if (events === undefined) {
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      settlement.answerSender(sessionId, asker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    const bot = rt.botOf(sender)
    const target = reach(bot, { roomId: asker.senderRoomId, room: rt.roomOf(asker.senderRoomId) })
    const where = target.where === 'group' ? target.sessionId : threadCurrentOfPart(bot, asker.senderPart) ?? target.sessionId
    const sent = await logOf(where)
    if (sent !== undefined && answeredIn(sent, workId)) {
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    if (reason?.kind === 'blocked') return
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(sessionId, record)
      return
    }
    const failure = reason.kind === 'error' ? turnFailure(reason.error) : undefined
    const aborted = reason.kind === 'aborted'
    const cutOff = reason.kind === 'max-tokens'
    if (cutOff) {
      const withoutText = turn.texts.length === 0
      rt.noteCutOffTurn?.(sessionId, { withoutText })
      const context = events.findLast(event => event?.type === 'request/context')?.data
      const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
      settlement.recordCutOff(sessionId, { wroteNothing: withoutText, ref })
    }
    await settlement.settleWork(sessionId, workId, asker, {
      reply: cutOff ? cutOffText(said) : said,
      failure,
      aborted,
    })
  }

  async function stoppedJobs(noted) {
    const bySession = new Map()
    const forget = (jobId) => {
      jobs = { ...jobs }
      delete jobs[jobId]
    }
    for (const [jobId, job] of Object.entries(noted) as [string, any][]) {
      if (rt.botOf(job?.botId) === undefined || typeof job.sessionId !== 'string') forget(jobId)
      else bySession.set(job.sessionId, [...(bySession.get(job.sessionId) ?? []), { jobId, ...job }])
    }
    const stopped = new Map()
    for (const [sessionId, list] of bySession) {
      const events = await logOf(sessionId)
      const lost = []
      for (const job of list) {
        const fate = events === undefined ? 'stopped' : jobFate(events, job.jobId)
        if (fate === undefined) continue
        forget(job.jobId)
        if (fate === 'stopped') lost.push(job)
      }
      if (lost.length > 0) stopped.set(sessionId, lost)
    }
    persist()
    return stopped
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    const { turns: noted, queued: dropped, jobs: noteJobs } = interrupted
    interrupted = { turns: {}, queued: {}, jobs: {} }
    const pending = queued
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) continue
        const key = sessionFor(oldId, item.args) ?? oldId
        queued = { ...queued, [key]: [...(queued[key] ?? []), item] }
      }
    }
    persist()
    const cut = []
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
      if (first?.type === 'turn/end') {
        await reconcileEnded(sessionId, record, first).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
        continue
      }
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') update(sessionId, () => record)
      else cut.push([sessionId, record])
    }
    firstTurn = undefined
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list).catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
    taken = undefined
    const stopped = await stoppedJobs(noteJobs).catch((error) => {
      rt.warn('ds-bot: reading the background jobs a restart stopped failed: %s', error)
      return new Map()
    })
    for (const [sessionId, record] of cut) {
      await resumeTurn(sessionId, record, stopped.get(sessionId)).catch(error => rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error))
      stopped.delete(sessionId)
    }
    for (const [sessionId, list] of stopped) {
      const { botId, cardId, roomId = rt.groupOwners.get(sessionId)?.roomId } = list[0]
      const room = roomId === undefined ? undefined : rt.roomOf(roomId)
      const target = reach(rt.botOf(botId), { cardId, roomId, room })
      let where
      if (target.where === 'group' || (room !== undefined && cardId === undefined)) {
        if (!room.members.includes(botId)) continue
        where = { sessionId: target.where === 'group' ? target.sessionId : sessionId, role: 'room', roomId, note: 'picking up after a restart' }
      } else {
        const ownPart = cardId !== undefined ? { sessionId: target.sessionId }
          : rt.selfOf(sessionId) === botId && rt.isBotSession(sessionId) ? { sessionId } : {}
        where = { ...ownPart, role: 'resume' }
      }
      await rt.dispatch.sendNotice({ toId: botId, ...where, resumed: true, text: jobsText(list) })
        .catch(error => rt.warn('ds-bot: telling %s about its stopped jobs failed: %s', sessionId, error))
    }
    await rt.settleRoomBatches?.()
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0 || Object.keys(interrupted.jobs).length > 0
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => void rt.load().then(() => rt.settleRoomBatches?.()).catch(error => rt.warn('ds-bot: settling group batches failed: %s', error)), 0)
    timer?.unref?.()
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
