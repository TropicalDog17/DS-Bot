import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GONE, MEMORY_LIMITS, REVIEW_MEMORY_MAX, ROUTED, TEAM_SHARED, bodySize, cleanDay, cleanEntry, cleanTopic, isPinned, parseReview, parseShortened, reviewEntries, splitEntry } from './memory-entries.ts'
import { REVIEW_CHANGES_MAX, reviewRequest, reviewSystem, shortenRequest, shortenSystem, writtenIn } from './memory-copy.ts'
import { speakerOf } from '../shared/mentions.ts'

const REVIEW_DELAY_MS = 2_000
const REVIEW_READ_MS = 15_000
const REVIEW_FIRST_LINES = 6
const REVIEW_CONTEXT_LINES = 4
const REVIEW_TEXT_MAX = 16_000
const REVIEW_USER_LINE_MAX = 3_000
const REVIEW_OTHER_LINE_MAX = 800
const REVIEW_PASSES_MAX = 4

export function installReview(rt, memory) {
  const { ctx, config } = rt
  const { root, reviewOn, mainLimit, TEAM, ownScope, groupScope, keeperOf, writesTeam, labelOf, fileName, today, writeText, settled, loadScope, addEntry, replaceEntry, removeEntry, entryProblem, secretEntry, botShot, languageNow } = memory

  const cursorsPath = join(root, 'reviewed.json')
  let cursors
  const cursorsNow = () => {
    if (cursors === undefined) {
      try {
        const value = JSON.parse(readFileSync(cursorsPath, 'utf8'))
        cursors = value !== null && typeof value === 'object' ? value : {}
      } catch {
        cursors = {}
      }
    }
    return cursors
  }
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} …(cut)` : text)
  const ends = (text, max) => (text.length > max ? `${text.slice(0, Math.ceil(max * 2 / 3))} …(middle cut)… ${text.slice(-Math.floor(max / 3))}` : text)

  const reviewLine = (who, text, bot) => (who === 'user'
    ? ends(text, REVIEW_USER_LINE_MAX)
    : clip(who === 'you' ? `${bot.name}: ${text.replace(/^You: /, '')}` : text, REVIEW_OTHER_LINE_MAX))

  async function chatBatch(sessionId, bot, since) {
    const fresh = []
    const earlier = []
    let through
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(REVIEW_READ_MS), { pages: Infinity })) {
      through ??= line.seq
      if (since === undefined ? fresh.length < REVIEW_FIRST_LINES || !fresh.some(seen => seen.who === 'user') : line.seq > since) fresh.push(line)
      else if (earlier.push(line) >= REVIEW_CONTEXT_LINES) break
    }
    const parts = rt.partsOfThread(bot.id, sessionId)
    const at = parts.findIndex(part => part.sessionId === sessionId)
    return {
      through,
      fresh: fresh.reverse(),
      earlier: earlier.reverse(),
      where: 'its own chat with the user',
      source: (lines) => {
        const said = lines.findLast(line => line.who === 'user')
        return said === undefined ? undefined : `part ${at === -1 ? Math.max(parts.length, 1) : at + 1} #${said.seq}`
      },
    }
  }

  function groupBatch(room, since) {
    const log = (room.log ?? []).filter(line => line.kind === undefined && typeof line.text === 'string' && line.text.trim() !== '')
    const lastUser = log.findLastIndex(line => line.who === 'User' && line.botId === undefined)
    let start = since === undefined ? Math.max(0, Math.min(log.length - REVIEW_FIRST_LINES, lastUser === -1 ? log.length : lastUser)) : log.findIndex(line => line.seq > since)
    if (start === -1) start = log.length
    const line = (entry) => {
      const who = entry.botId === undefined && entry.who === 'User' ? 'user' : 'bot'
      return { who, text: `${who === 'user' ? 'User' : speakerOf(entry)}: ${entry.text}`, seq: entry.seq }
    }
    return {
      through: log.at(-1)?.seq,
      fresh: log.slice(start).map(line),
      earlier: log.slice(Math.max(0, start - REVIEW_CONTEXT_LINES), start).map(line),
      where: `the group chat "${room.name}"`,
      source: (lines) => {
        const said = lines.findLast(item => item.who === 'user') ?? lines.at(-1)
        return said === undefined ? `group "${room.name}"` : `group "${room.name}" #${said.seq}`
      },
    }
  }

  function fitted(lines, bot) {
    const kept = []
    let used = 0
    for (const line of lines) {
      const text = reviewLine(line.who, line.text, bot)
      if (kept.length > 0 && used + text.length > REVIEW_TEXT_MAX) break
      kept.push(text)
      used += text.length
    }
    return { texts: kept, count: kept.length }
  }

  function routeOf(change, keeper, home, team) {
    if (home.kind === 'group') return { scope: home }
    if (change.team === true && team) return { scope: TEAM }
    if (typeof change.for === 'string' && change.for.trim() !== '') {
      const bot = rt.findBot(change.for)
      if (!rt.isMain(keeper.id)) return { scope: home, error: 'only a Main Bot keeps notes for another Bot' }
      if (bot === undefined) return { scope: home, error: `there is no Bot named "${clip(change.for, 60)}"` }
      if (rt.isPrivate(bot.id)) return { scope: home, error: 'a private Bot keeps its own memory' }
      return { scope: ownScope(bot.id) }
    }
    if (typeof change.group === 'string' && change.group.trim() !== '') {
      const room = roomsOf(keeper).find(item => item.name === change.group.trim())
      return room === undefined ? { scope: home, error: `the keeper is in no group named "${clip(change.group, 60)}"` } : { scope: groupScope(room.id) }
    }
    return { scope: home }
  }
  const roomsOf = keeper => (Object.values(rt.state.rooms) as any[]).filter(room => room.members.includes(keeper.id))

  async function fitLong({ keeper, name, numbered, changes, tag, teamWrites }) {
    const max = MEMORY_LIMITS.entry
    const fits = (change) => {
      if (change.op !== 'add' && change.op !== 'edit') return true
      const text = cleanEntry(change.text)
      if (text.length <= max || secretEntry(text)) return true
      if (change.op === 'add') return false
      const target = numbered[Number(change.entry) - 1]
      return target === undefined || isPinned(target) || (target.scope === 'team' && (target.file.topic === undefined || !teamWrites()))
    }
    const long = changes.filter(change => !fits(change))
    if (long.length === 0) return changes
    let answers = []
    try {
      answers = parseShortened(await botShot(keeper, shortenSystem(max), shortenRequest(long.map(change => cleanEntry(change.text))), tag), long.length)
    } catch (error) {
      rt.warn('ds-bot: memory review of %s could not shorten %d long entries: %s', name, long.length, error?.message ?? error)
    }
    return changes.flatMap((change) => {
      const at = long.indexOf(change)
      if (at === -1) return [change]
      const texts = (answers[at] ?? [change.text]).map(cleanEntry).filter(text => text !== '')
      const pieces = texts.flatMap(text => splitEntry(text, max))
      if (pieces.length === 0) return [change]
      if (pieces.length > texts.length) rt.warn('ds-bot: memory review of %s cut a long entry into %d at sentence ends: "%s"', name, pieces.length, clip(cleanEntry(change.text), 160))
      const [first, ...rest] = pieces
      if (change.op === 'add') return [{ ...change, text: first }, ...rest.map(text => ({ ...change, text, piece: true }))]
      const target = numbered[Number(change.entry) - 1]
      const into = { scope: target.scope === 'team' ? TEAM : undefined, topic: target.file.topic }
      return [{ ...change, text: first }, ...rest.map(text => ({ op: 'add', text, into, piece: true, ...(change.until === undefined ? {} : { until: change.until }) }))]
    })
  }

  async function applyReview({ keeper, name, home, numbered, changes: asked, source, teamWrites, tag }) {
    const actor = { id: keeper.id, name: keeper.name, auto: true }
    const changes = await fitLong({ keeper, name, numbered, changes: asked, tag, teamWrites })
    const done = []
    let pieces = 0
    const counts = () => ({ kept: done.length - pieces, changed: done.filter(result => result.changed).length })
    let failed
    const order = change => ({ remove: 0, edit: 1 })[String(change?.op)] ?? 2
    for (const change of changes.toSorted((a, b) => order(a) - order(b))) {
      if (rt.botOf(keeper.id) === undefined) return counts()
      const team = teamWrites()
      const op = String(change?.op ?? '')
      const target = numbered[Number(change?.entry) - 1]
      const into = change.into
      const route = op === 'add' && into === undefined ? routeOf(change, keeper, home, team) : undefined
      const scope = into !== undefined ? into.scope ?? home : op === 'add' ? route.scope : target?.scope === 'team' ? TEAM : home
      const topic = into !== undefined ? into.topic : op === 'add' && scope.kind === 'team' ? cleanTopic(String(change?.topic ?? TEAM_SHARED)) : op === 'add' && change?.topic !== undefined ? cleanTopic(String(change.topic)) : undefined
      const label = labelOf(scope, keeper.id)
      const text = cleanEntry(change?.text)
      const until = cleanDay(change?.until)
      const meta = { source, ...(scope.kind === 'team' ? { by: keeper.name } : {}), added: today(), ...(until === undefined ? {} : { until }) }
      const badTopic = op === 'add' && change?.topic !== undefined && String(change.topic).trim() !== '' && topic === undefined
      const problem = op === 'add' || op === 'edit' ? entryProblem(text) : undefined
      const leftOut =
        op !== 'add' && target === undefined ? `it names entry ${change?.entry}, which is not listed` :
        op !== 'add' && isPinned(target) ? 'it changes an entry the user pinned' :
        op !== 'add' && target.scope === 'team' && target.file.topic === undefined ? 'it changes what every Bot always reads, which only the user does' :
        route?.error !== undefined ? route.error :
        scope.kind === 'team' && !team ? 'it is for the team memory, which the review may not write' :
        badTopic ? `it names the topic "${clip(String(change.topic), 60)}", which cannot be a topic name` :
        problem !== undefined ? (secretEntry(text) ? 'the entry looks like a key, token, password, or ID number, which memory never keeps' : `the entry "${clip(text, 160)}": ${problem}`) :
        undefined
      if (leftOut !== undefined) {
        rt.warn('ds-bot: memory review of %s left out a change: %s', name, leftOut)
        continue
      }
      try {
        if (op === 'add') {
          done.push(await addEntry({ scope, topic, text, meta, actor, label }))
          if (change.piece === true) pieces += 1
        }
        else if (op === 'edit') done.push(await replaceEntry({ scope, topic: target.file.topic, match: target.text, text, meta, actor, label }))
        else if (op === 'remove') done.push(await removeEntry({ scope, topic: target.file.topic, match: target.text, actor, label }))
      } catch (failure) {
        if (failure?.code === GONE) return counts()
        const held = op === 'remove' ? `the removal of "${clip(target.text, 160)}"` : `the entry "${clip(text, 160)}"`
        const aimed = `${fileName(op === 'add' ? { topic } : target.file)} of ${label}`
        rt.warn('ds-bot: memory review of %s left out a change: %s for %s: %s', name, held, aimed, failure?.message ?? failure)
        if (!ROUTED.has(failure?.code)) failed ??= failure
      }
    }
    if (failed !== undefined) throw failed
    return counts()
  }

  const roomCopy = room => ({ id: room.id, name: room.name, seq: room.seq, log: [...room.log ?? []] })
  const joinLogs = (kept, now) => {
    if (kept === undefined || kept.id !== now.id) return roomCopy(now)
    const oldest = now.log?.[0]?.seq ?? Infinity
    return { ...roomCopy(now), log: [...kept.log.filter(line => line.seq < oldest), ...now.log ?? []] }
  }

  const withKeptLines = (room, kept) => {
    if (kept.length === 0) return room
    const bySeq = new Map<any, any>((room.log ?? []).map(line => [line.seq, line]))
    for (const line of kept) bySeq.set(line.seq, line)
    return { ...room, log: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
  }

  const reviewOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { key: `chat:${sessionId}`, sessionId, botId: chat }
    const owner = rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
    if (owner === undefined) return undefined
    if (owner.roomId === undefined) return { key: `chat:${sessionId}`, sessionId, botId: owner.botId }
    const room = rt.roomOf(owner.roomId)
    return room === undefined ? undefined : { key: `group:${room.id}`, roomId: room.id, room: roomCopy(room) }
  }

  async function reviewChat(seen) {
    const bot = rt.botOf(reviewOf(seen.sessionId)?.botId ?? seen.botId)
    if (bot === undefined) return
    const since = cursorsNow()[seen.key]
    await reviewBatch({
      key: seen.key, since, batch: await chatBatch(seen.sessionId, bot, since),
      keeper: bot, name: bot.name, home: ownScope(bot.id), teamWrites: () => writesTeam(bot.id),
      who: `The Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`,
      tag: { sessionId: rt.chatOf(bot.id), kind: 'memory' },
      alive: () => rt.botOf(bot.id) !== undefined,
      next: () => queueReview(seen),
    })
  }

  async function reviewGroup(seen) {
    const live = rt.roomOf(seen.roomId)
    const keeper = live === undefined ? undefined : keeperOf(live)
    if (keeper === undefined) return
    const since = cursorsNow()[seen.key]
    const room = withKeptLines(joinLogs(seen.room, live), await rt.groupLinesAfter(live.id, since).catch((error) => {
      rt.warn('ds-bot: the log of group "%s" could not be read: %s', live.name, error?.message ?? error)
      return []
    }))
    const members = live.members.map(id => rt.botOf(id)).filter(Boolean).map(bot => `${bot.name}${live.admin === bot.id ? ' (admin)' : ''}`)
    await reviewBatch({
      key: seen.key, since, batch: groupBatch(room, since),
      keeper, name: `group "${live.name}"`, home: groupScope(live.id), teamWrites: () => false, group: true,
      who: `The group chat: "${live.name}", with the user and ${members.join(', ')}.`,
      tag: { sessionId: live.id, kind: 'memory' },
      alive: () => rt.botOf(keeper.id) !== undefined && rt.roomOf(live.id)?.members.includes(keeper.id) === true,
      next: () => queueReview({ ...seen, room }),
    })
  }

  async function reviewBatch({ key, since, batch, keeper, name, home, teamWrites, group = false, who, tag, alive, next }) {
    if (batch.through === undefined || (since !== undefined && batch.through <= since)) return
    const fresh = fitted(batch.fresh, keeper)
    const read = batch.fresh.slice(0, fresh.count)
    const more = fresh.count < batch.fresh.length
    let through = more ? read.at(-1).seq : batch.through
    let again = more
    if (since === undefined && read.length > 0) {
      cursorsNow()[key] = read[0].seq - 1
      await writeText(cursorsPath, JSON.stringify(cursors))
    }
    if (read.some(line => line.who === 'user')) {
      const { homeFiles, teamFiles } = await settled(() => ({ homeFiles: loadScope(home), teamFiles: loadScope(TEAM) }))
      const said = read.filter(line => line.who === 'user').map(line => line.text).join('\n')
      const tagged = group ? 'group' : 'own'
      const { numbered, left } = reviewEntries(homeFiles, teamFiles, REVIEW_MEMORY_MAX, said, tagged)
      const sizes = { home: bodySize(homeFiles[0]), homeLimit: mainLimit(home), team: bodySize(teamFiles[0]), teamLimit: mainLimit(TEAM) }
      const earlier = batch.earlier.map(line => reviewLine(line.who, line.text, keeper))
      const language = writtenIn(read.filter(line => line.who === 'user').map(line => line.text.replace(/^User: /, '')), languageNow())
      const reply = await botShot(keeper, reviewSystem({ teamWrites: teamWrites(), group, routes: !group && rt.isMain(keeper.id), rooms: group || !teamWrites() ? [] : roomsOf(keeper).map(room => room.name) }), reviewRequest({ who, tag: tagged, numbered, left, sizes, where: batch.where, earlier, fresh: fresh.texts, more, language }), tag)
      if (!alive()) return
      const parsed = parseReview(reply)
      if (parsed === undefined) {
        rt.warn('ds-bot: memory review of %s got no list of changes from the model: %s', name, clip(reply.replace(/\s+/g, ' '), 120))
      } else {
        const { changes, leftOut } = parsed
        for (const change of leftOut) {
          const whole = JSON.stringify(change)
          rt.warn('ds-bot: memory review of %s left out a change: %s', name, secretEntry(whole) ? 'it looks like a key, token, password, or ID number, which memory never keeps' : `it is not a well-formed change: ${clip(whole, 160)}`)
        }
        const { kept, changed } = await applyReview({ keeper, name, home, numbered, changes, source: batch.source(read), teamWrites, tag })
        if (!alive()) return
        const prior = overflowed.get(key)
        const passes = prior !== undefined && prior.since === since ? prior.passes : 0
        if (kept >= REVIEW_CHANGES_MAX && changed > 0 && passes < REVIEW_PASSES_MAX) {
          overflowed.set(key, { since, passes: passes + 1 })
          through = since
          again = true
        } else {
          overflowed.delete(key)
        }
      }
    }
    const now = cursorsNow()[key]
    if (through !== undefined && (now === undefined || through > now)) {
      cursorsNow()[key] = through
      await writeText(cursorsPath, JSON.stringify(cursors))
    }
    if (again) next()
  }
  const overflowed = new Map()

  const reviewTimers = new Map()
  const reviewQueue = new Map()
  let reviewChain = Promise.resolve()
  let reviewsRunning = 0
  const memoryReviews = () => reviewTimers.size + reviewQueue.size + reviewsRunning
  function queueReview(seen) {
    const prior = reviewQueue.get(seen.key)
    if (prior !== undefined) {
      if (seen.room !== undefined) reviewQueue.set(seen.key, { ...seen, room: joinLogs(prior.room, seen.room) })
      return
    }
    reviewQueue.set(seen.key, seen)
    reviewChain = reviewChain.then(async () => {
      const waited = reviewQueue.get(seen.key)
      reviewQueue.delete(seen.key)
      reviewsRunning += 1
      try {
        if (rt.readOnly() === undefined) await (waited.roomId === undefined ? reviewChat(waited) : reviewGroup(waited))
      } catch (error) {
        rt.warn('ds-bot: memory review of %s failed: %s', waited.key, error?.message ?? error)
      } finally {
        reviewsRunning -= 1
      }
    })
  }

  if (reviewOn) {
    const delay = config.memoryReviewDelayMs ?? REVIEW_DELAY_MS
    const turnOwners = new Map()
    ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id
      if (id === undefined || (!rt.isBotSession(id) && !turnOwners.has(id))) return
      clearTimeout(reviewTimers.get(id))
      reviewTimers.delete(id)
      if (status !== 'idle') {
        if (!turnOwners.has(id)) turnOwners.set(id, reviewOf(id))
        return
      }
      const started = turnOwners.get(id)
      turnOwners.delete(id)
      const seen = reviewOf(id) ?? started
      if (seen === undefined) return
      const timer = setTimeout(() => {
        reviewTimers.delete(id)
        queueReview(seen)
      }, delay)
      timer.unref?.()
      reviewTimers.set(id, timer)
    })
    ctx.effect(() => () => {
      for (const timer of reviewTimers.values()) clearTimeout(timer)
      reviewTimers.clear()
      turnOwners.clear()
    }, 'ds-bot: memory review')
  }

  return { memoryReviews }
}
