import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES, SECTION_COLORS, SECTION_NAME_MAX, TEXT_KEPT } from './constants.ts'
import { replaceFile } from './files.ts'
import { homeLock } from './home-lock.ts'
import { createSessionIndex, nonEmptyId } from './session-index.ts'
import { currentColor, headOf, normalize, unquote } from './text.ts'
import { AMBIGUOUS_OLD_ROUTES, legacyRoute } from './local-agents/engines.ts'

export const own = (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined)

function cleanReplyOrigins(state) {
  const entries = state.imReplyOrigins
  if (entries === undefined) return false
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    delete state.imReplyOrigins
    return true
  }
  let changed = false
  const fields = ['connId', 'chatKey', 'senderId', 'binding', 'issuedBy', 'exchangeId', 'botId']
  for (const [token, entry] of Object.entries(entries) as [string, any][]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || !fields.every(field => typeof entry[field] === 'string' && entry[field] !== '')
      || !Number.isFinite(entry.at)) {
      delete entries[token]
      changed = true
    } else if (Object.hasOwn(entry, 'activeOn')) {
      delete entry.activeOn
      changed = true
    }
  }
  return changed
}

export function install(rt) {
  const { ctx, home, statePath } = rt

  const state: Record<string, any> = { version: 1, mainBotIds: [], bots: {}, privateArchives: [], rooms: {}, agents: {}, sections: [], capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, requests: {}, questions: {}, views: {}, closedCards: {}, prefs: {}, switching: {}, revision: 0 }
  let loaded = null
  let storeReady = false
  let writing = Promise.resolve()
  const { warn } = rt
  const sessionIdOf = nonEmptyId

  const EMPTY = JSON.stringify(state)
  let holder
  let lockBroken = false
  let stuck
  let warnedReadOnly = false
  let stopped = false
  let seen = ''
  let lockEpoch = 0
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const lock = homeLock(join(home, 'state.lock'))
  const claimLock = () => {
    if (lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      lockBroken = true
      holder = undefined
      warn('ds-bot: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (stuck !== undefined) return `The Bot team file ${statePath} could not be read (${stuck}). DS Bot does not change it; fix or move the file and reload.`
    if (holder === undefined) return undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  const readFileState = () => {
    let contents
    try {
      contents = readFileSync(statePath, 'utf8')
    } catch (error) {
      seen = stamp()
      if (error?.code === 'ENOENT') {
        stuck = undefined
        return undefined
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('ds-bot: unreadable state %s: %s', statePath, error)
      return undefined
    }
    seen = stamp()
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch (error) {
      const backup = `${statePath}.broken-${Date.now()}`
      try {
        copyFileSync(statePath, backup)
        stuck = undefined
        warn('ds-bot: unreadable state %s: %s; backed up as %s', statePath, error, backup)
      } catch (copyError) {
        stuck = copyError?.code ?? copyError?.message ?? error?.message ?? String(error)
        warn('ds-bot: unreadable state %s: %s; backup failed: %s', statePath, error, copyError)
      }
      return undefined
    }
    if (parsed?.version === 1) {
      stuck = undefined
      return parsed
    }
    stuck = 'saved by a newer DS Bot; update DS Bot'
    return undefined
  }

  const adopt = (parsed) => {
    lockEpoch += 1
    const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, 'capabilities')
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    state.prefs ??= {}
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    if (state.computer === null || typeof state.computer !== 'object' || Array.isArray(state.computer)) state.computer = {}
    let migrated = !hadCapabilities
    if (state.capabilities === null || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities)) {
      state.capabilities = { items: {} }
      migrated = true
    } else if (state.capabilities.items === null || typeof state.capabilities.items !== 'object' || Array.isArray(state.capabilities.items)) {
      state.capabilities.items = {}
      migrated = true
    }
    if (state.bots === null || typeof state.bots !== 'object' || Array.isArray(state.bots)) state.bots = {}
    if (state.rooms === null || typeof state.rooms !== 'object' || Array.isArray(state.rooms)) state.rooms = {}
    for (const [id, bot] of Object.entries(state.bots) as [string, any][]) {
      if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
        delete state.bots[id]
        migrated = true
        continue
      }
      if (sessionIdOf(bot.id) === undefined) bot.id = id
      if (!Array.isArray(bot.capabilities)) {
        bot.capabilities = []
        migrated = true
      }
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      if (bot.computer !== undefined && (bot.computer === null || typeof bot.computer !== 'object' || Array.isArray(bot.computer))) delete bot.computer
      else if (bot.computer !== undefined && (bot.computer.apps === null || typeof bot.computer.apps !== 'object' || Array.isArray(bot.computer.apps))) delete bot.computer.apps
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    for (const [id, room] of Object.entries(state.rooms) as [string, any][]) {
      if (!room || typeof room !== 'object' || Array.isArray(room)) {
        delete state.rooms[id]
        migrated = true
        continue
      }
      if (sessionIdOf(room.id) === undefined) room.id = id
      if (!Array.isArray(room.members)) room.members = []
    }
    if (migrateLocalRoutes(state)) migrated = true
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    if (state.mainBotIds.length > 1) {
      state.mainBotIds = state.mainBotIds.slice(0, 1)
      migrated = true
    }
    if (!Array.isArray(state.privateArchives)) state.privateArchives = []
    if (!Array.isArray(state.sections)) state.sections = []
    else {
      const seen = new Set()
      state.sections = state.sections
        .filter(sec => sec && typeof sec === 'object' && typeof sec.id === 'string' && sec.id !== '' && typeof sec.name === 'string' && sec.name.trim() !== '' && !seen.has(sec.id) && seen.add(sec.id))
        .map(sec => ({
          id: sec.id,
          name: sec.name.trim().slice(0, SECTION_NAME_MAX),
          ...(sec.collapsed === true ? { collapsed: true } : {}),
          ...(SECTION_COLORS.includes(sec.color) ? { color: sec.color } : {}),
        }))
    }
    const sectionIds = new Set(state.sections.map(sec => sec.id))
    for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms), ...Object.values(state.agents)] as any[]) {
      if (entry.sectionId !== undefined && (typeof entry.sectionId !== 'string' || !sectionIds.has(entry.sectionId) || entry.id === state.mainBotIds[0])) {
        delete entry.sectionId
      }
    }
    if (state.whaleStored !== true) {
      const first = (Object.values(state.bots) as any[]).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'whale' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    if (state.works === null || typeof state.works !== 'object' || Array.isArray(state.works)) state.works = {}
    if (cleanReplyOrigins(state)) migrated = true
    if (state.requests === null || typeof state.requests !== 'object' || Array.isArray(state.requests)) state.requests = {}
    if (state.roomBatches === null || typeof state.roomBatches !== 'object' || Array.isArray(state.roomBatches)) state.roomBatches = {}
    for (const [key, batch] of Object.entries(state.roomBatches) as [string, any][]) {
      if (!Array.isArray(batch?.pending) || !Array.isArray(batch.done) || !Array.isArray(batch.results) || batch.key !== key) delete state.roomBatches[key]
    }
    if (state.views === null || typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {}
    if (state.closedCards === null || typeof state.closedCards !== 'object' || Array.isArray(state.closedCards)) state.closedCards = {}
    if ('closedViews' in state) {
      delete state.closedViews
      migrated = true
    }
    if ('btwCards' in state) {
      delete state.btwCards
      migrated = true
    }
    const writer = holder === undefined && stuck === undefined
    for (const room of Object.values(state.rooms) as any[]) {
      if (!('botRounds' in room)) continue
      delete room.botRounds
      migrated = true
    }
    for (const room of Object.values(state.rooms) as any[]) {
      if (['lateRounds', 'quietNoticed', 'quietShown', 'relays', 'relayLimit'].every(key => room[key] === undefined)) continue
      delete room.lateRounds
      delete room.quietNoticed
      delete room.quietShown
      delete room.relays
      delete room.relayLimit
      migrated = true
    }
    for (const room of Object.values(state.rooms) as any[]) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    for (const room of Object.values(state.rooms) as any[]) {
      const members = room.members.filter(id => state.bots[id])
      const admin = members.includes(room.admin) ? room.admin : null
      if (members.length === room.members.length && admin === room.admin) continue
      room.members = members
      room.admin = admin
      migrated = true
    }
    for (const entry of state.exchanges) {
      if (typeof entry.text !== 'string' || entry.text.length <= TEXT_KEPT || entry.length !== undefined) continue
      entry.length = entry.text.length
      entry.text = headOf(entry.text, TEXT_KEPT)
      migrated = true
    }
    for (const room of (writer ? Object.values(state.rooms) : []) as any[]) {
      if (!Array.isArray(room.log)) continue
      const log = room.log.map(line => (typeof line.text === 'string' && line.length === undefined && typeof line.seq === 'number' ? rt.keepGroupLine(room.id, line, line.text) : line))
      if (log.some((line, index) => line !== room.log[index])) {
        room.log = log
        migrated = true
      }
    }
    const stale = (Object.values(state.rooms) as any[]).filter(room => !room.named && room.name !== rt.autoRoomName(room.members))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    indexSessions()
    return { migrated: migrated || stale.length > 0, stale }
  }

  const hasLoaded = () => storeReady
  const syncReadOnly = () => {
    if (storeReady && adopting === undefined && (stuck !== undefined || holder !== undefined) && stamp() !== seen) {
      adopt(readFileState())
      rt.onStoreSync?.()
    }
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const { migrated, stale } = adopt(readFileState())
    storeReady = true
    rt.onStoreSync?.()
    if (holder !== undefined) return
    if (migrated && stuck === undefined) {
      try {
        await save()
      } catch (error) {
        warn('ds-bot: saving the migrated Bot team failed: %s', error)
      }
    }
    for (const room of stale) void rt.retitleRoom(room)
  })()

  let adopting
  const adoptAfterReclaim = () => {
    const run = (adopting ?? writing).then(async () => {
      if (stamp() !== seen) {
        const aside = `${statePath}.replaced-${Date.now()}`
        try {
          await writeFile(aside, JSON.stringify(state))
          warn('ds-bot: %s changed while no host held the team; it is adopted and this host\'s state is kept as %s', statePath, aside)
        } catch (error) {
          warn('ds-bot: %s changed while no host held the team; it is adopted, and this host\'s state is lost because it could not be kept aside: %s', statePath, error)
        }
      }
      adopt(readFileState())
    })
    writing = run.catch(() => {})
    const tracked = run.finally(() => { if (adopting === tracked) adopting = undefined })
    adopting = tracked
    return tracked
  }

  const reclaimHeld = () => {
    warnedReadOnly = false
    if (adopting !== undefined) return adopting
    return stamp() === seen ? undefined : adoptAfterReclaim()
  }

  const refresh = async () => {
    await load()
    const hadHolder = holder !== undefined
    if (hadHolder) {
      claimLock()
      if (holder === undefined) {
        warn('ds-bot: the other dsh has closed; this one now saves the Bot team')
        warnedReadOnly = false
        adopt(readFileState())
        rt.onStoreSync?.()
        return
      }
    } else if (!lockBroken && !lock.owns()) {
      claimLock()
      if (lockBroken) return
      if (holder === undefined) {
        await reclaimHeld()
        rt.onStoreSync?.()
        return
      }
      warn('ds-bot: %s', readOnly())
    }
    if (adopting !== undefined) {
      await adopting
      rt.onStoreSync?.()
      return
    }
    if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) adopt(readFileState())
    rt.onStoreSync?.()
  }

  const warnReadOnly = () => {
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }
  const writable = () => {
    if (stuck !== undefined) return warnReadOnly()
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) {
        const pending = reclaimHeld()
        if (pending !== undefined) void pending.catch(() => {})
        return true
      }
    }
    return warnReadOnly()
  }

  const save = ({ required = false } = {}) => {
    if (stopped) return required ? Promise.reject(new Error('The Bot team cannot be saved after this host stopped.')) : writing
    indexSessions()
    if (!writable()) return required ? Promise.reject(new Error(`This host cannot save the Bot team: ${readOnly()}`)) : writing
    const run = writing.then(async () => {
      if (stuck !== undefined || holder !== undefined) {
        if (required) throw new Error(`This host cannot save the Bot team: ${readOnly()}`)
        warnReadOnly()
        return
      }
      const epoch = lockEpoch
      state.revision += 1
      state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
      const snapshot = JSON.stringify(state)
      const temp = `${statePath}.${process.pid}.tmp`
      try {
        await mkdir(home, { recursive: true })
        const ensureLock = () => {
          if (lockBroken) return
          const owned = lock.owns()
          const changed = owned && stamp() !== '' && stamp() !== seen
          if (changed) void adoptAfterReclaim().catch(() => {})
          if (!owned || changed || lockEpoch !== epoch) {
            const error: any = new Error(changed ? 'ds-bot: the Bot team file changed under this host\'s lock' : 'ds-bot lost the state lock to another dsh')
            error.code = 'ELOCKLOST'
            throw error
          }
        }
        ensureLock()
        await writeFile(temp, snapshot, 'utf8')
        ensureLock()
        await replaceFile(temp, statePath, ensureLock)
        seen = stamp()
        rt.capabilitiesStateSaved?.()
        for (const listener of savedListeners) {
          try { listener() } catch (error) { warn('ds-bot: saved listener failed: %s', error) }
        }
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = run.catch(() => {})
    return run.catch(error => {
      warn('ds-bot: state write failed: %s', error)
      throw error
    })
  }

  ctx.effect(() => () => {
    stopped = true
    return writing.finally(() => lock.release())
  }, 'ds-bot: state lock')

  const sessionIndex = createSessionIndex({ warn })
  const { chatOwners, groupOwners, roomOwners, pastOwners } = sessionIndex
  const botOf = id => (id === undefined ? undefined : own(state.bots, id))
  const roomOf = id => (id === undefined ? undefined : own(state.rooms, id) ?? own(state.rooms, sessionIndex.roomOwnerOf(id)))
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)
  const chatOf = botId => sessionIdOf(botOf(botId)?.sessionId) ?? botId
  const sessionOfRoom = room => (room === undefined ? undefined : sessionIdOf(room.sessionId) ?? room.id)
  // DSH turns away every step of an archived Session and every task aimed at it, so a
  // Session the team speaks from now leaves the archive: an earlier open of an old part
  // could leave one there, and DSH's own Session list can archive one. Earlier parts
  // stay archived.
  let restoring
  const restoreCurrent = () => {
    const registry = ctx.workspaceRegistry
    if (restoring !== undefined || readOnly() !== undefined || typeof registry?.unarchiveSession !== 'function') return
    let archived
    try {
      archived = new Set(registry.archivedSessionIds ?? [])
    } catch {
      return
    }
    const held = sessionIndex.currentSessionIds().filter(id => archived.has(id))
    if (held.length === 0) return
    restoring = (async () => {
      for (const sessionId of held) {
        await registry.unarchiveSession(sessionId)
          .then(() => warn('ds-bot: current Session %s was archived in DSH; taken back out', sessionId))
          .catch(error => warn('ds-bot: current Session %s is archived in DSH and could not be taken out: %s', sessionId, error))
      }
    })().finally(() => { restoring = undefined })
  }
  const onSessionIdentityChange = sessionIndex.onChange
  const indexSessions = () => {
    sessionIndex.reindex({ bots: state.bots, rooms: state.rooms })
    rt.indexAgents?.()
    rt.syncScopedTools?.()
    sessionIndex.notifyChanged()
    restoreCurrent()
  }
  const selfOf = sessionIndex.selfOf
  const isBotSession = sessionIndex.isBotSession
  const groupSessionsOf = botId => (Object.values(state.rooms) as any[]).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    if (room.memberDirs !== undefined) delete room.memberDirs[botId]
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    for (const segment of room.segments?.[botId] ?? []) delete state.switching[segment.sessionId]
    if (room.segments !== undefined) delete room.segments[botId]
    delete state.switching[sessionId]
    sessionIndex.removeGroupMember(sessionId)
    rt.cancelApprovals?.(sessionId)
    // A plain archive refuses a running Session, which would go on working for a group
    // that no longer has it.
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  const retireGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    sessionIndex.removeGroupMember(sessionId)
    rt.cancelApprovals?.(sessionId)
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    const byId = own(state.bots, ref)
    if (byId) return byId
    const wanted = normalize(unquote(ref)).replace(/^@/, '')
    return (Object.values(state.bots) as any[]).find(bot => normalize(bot.name) === wanted)
  }
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    const byId = own(state.rooms, ref)
    if (byId) return [byId]
    const wanted = normalize(unquote(ref))
    return (Object.values(state.rooms) as any[]).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  const savedListeners = new Set<() => void>()
  const onSaved = (listener) => {
    savedListeners.add(listener)
    return () => savedListeners.delete(listener)
  }

  const closeCard = (sessionId, card, outcome) => {
    if (typeof card?.callId !== 'string') return
    const target = typeof card.callSessionId === 'string' ? card.callSessionId : sessionId
    state.closedCards[target] = { ...own(state.closedCards, target), [card.callId]: outcome }
  }

  Object.assign(rt, {
    state, load, save, refresh, readOnly, hasLoaded, syncReadOnly, own, onSaved, closeCard,
    botOf, roomOf, isMain, chatOf, sessionOfRoom, selfOf, isBotSession,
    sessionIndex, chatOwners, groupOwners, roomOwners, pastOwners, onSessionIdentityChange,
    groupSessionsOf, dropGroupSession, retireGroupSession, findBot, findRooms, isAdminOf,
  })
}

// the Bot's Sessions are selected again on the new route. An old `opencode/...`
// ref is also DSH's own OpenCode provider: it moves only for a Bot that ran on
// the local CLI (a CLI record for one of its Sessions) or on its "CLI default".
export function migrateLocalRoutes(state) {
  let changed = false
  const ranOn = new Map()
  for (const [sessionId, record] of Object.entries(state.localAgents?.sessions ?? {}) as [string, any][]) {
    const next = legacyRoute(record?.route)
    if (next === undefined) continue
    if (!ranOn.has(record.route)) ranOn.set(record.route, new Set())
    ranOn.get(record.route).add(sessionId)
    record.route = next
    changed = true
  }
  const split = (ref) => {
    const at = typeof ref === 'string' ? ref.indexOf('/') : -1
    return at <= 0 ? undefined : { provider: ref.slice(0, at), model: ref.slice(at + 1) }
  }
  const sessionsOf = (bot) => {
    const ids = [bot.id, bot.sessionId, ...(bot.segments ?? []).map(segment => segment?.sessionId)]
    for (const room of Object.values(state.rooms ?? {}) as any[]) {
      ids.push(room?.sessions?.[bot.id], ...(room?.segments?.[bot.id] ?? []).map(segment => segment?.sessionId))
    }
    return ids.filter(Boolean)
  }
  for (const bot of Object.values(state.bots ?? {}) as any[]) {
    for (const key of ['model', 'appliedModel']) {
      const ref = split(bot[key])
      const next = legacyRoute(ref?.provider)
      if (next === undefined) continue
      const local = !AMBIGUOUS_OLD_ROUTES.has(ref.provider) || ref.model === 'default'
        || sessionsOf(bot).some(id => ranOn.get(ref.provider)?.has(id))
      if (!local) continue
      if (key === 'model' || bot.model === undefined) bot.model = `${next}/${ref.model}`
      delete bot.appliedModel
      changed = true
    }
  }
  return changed
}
