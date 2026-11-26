import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { install as installBtw } from './btw.ts'
import { install as installSide } from './side.ts'
import { handoffReply, questionReply, viewReply } from './parts.ts'
import { threadCurrentOfPart } from './threads.ts'
import { validateViewAnswer } from 'deep-view/core'
import { COLORS, EXTRA_COLORS, ROUTE } from './constants.ts'

const STAGED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const STAGED_MS = 30 * 60_000

const LANGUAGES = {
  zh: 'Chinese (简体中文)',
  'zh-tw': 'Traditional Chinese (繁體中文)',
  'zh-hk': 'Traditional Chinese (繁體中文)',
  'zh-mo': 'Traditional Chinese (繁體中文)',
  'zh-hant': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
}
const RUN_STATS = ['sessionStats', 'tokenUsage', 'contextPressure']

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
const MEMORY_LIMIT_SCOPES = new Set(['group', 'bot', 'team'])
const MEMORY_LIMIT_MIN = 1_000
const MEMORY_LIMIT_MAX = 200_000

export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error.code
  return isInternal(error) ? 'bot/internal' : 'bot/refused'
}

export function install(rt) {
  installBtw(rt)
  installSide(rt)
  const { ctx, state } = rt

  let uiLocale
  rt.uiLanguage = () => {
    if (uiLocale === undefined) return undefined
    const lower = uiLocale.toLowerCase()
    return LANGUAGES[lower] ?? LANGUAGES[lower.split('-')[0]] ?? uiLocale
  }

  const staged = new Map()
  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error') => ({ ok: false, error: { code, message, details: {} } })
  const modelsKey = () => `${rt.cachedCatalog().map(entry => `${entry.ref}${entry.needsKey ? '!' : ''}${entry.reasoning ? `:${JSON.stringify(entry.reasoning)}` : ''}`).join(',')}|${rt.cachedDefault() ?? ''}`
  const view = () => ({
    revision: state.revision,
    workspaceId: state.workspaceId ?? null,
    mainBotId: state.mainBotIds[0] ?? null,
    mainBotIds: state.mainBotIds,
    bots: Object.values(state.bots).map(({ segments, kickoff, openParts, closedCards, ...bot }) => {
      const tail = rt.chatTail(rt.chatOf(bot.id))
      const open = (openParts ?? []).map(part => ({
        sessionId: part.sessionId,
        startedAt: part.startedAt ?? 0,
        parts: (part.segments ?? []).map(segment => segment.sessionId),
        ...(typeof part.card === 'string' ? { card: part.card } : {}),
      }))
      const closed = (closedCards ?? []).map(part => ({
        card: part.card,
        sessionId: part.sessionId,
        closedAt: part.closedAt ?? 0,
        parts: (part.segments ?? []).map(segment => segment.sessionId),
      }))
      return {
        ...bot, sessionId: rt.chatOf(bot.id), parts: (segments ?? []).map(segment => segment.sessionId),
        ...(open.length > 0 ? { openParts: open } : {}), ...(closed.length > 0 ? { closedCards: closed } : {}),
        ...(kickoff ? { waiting: true } : {}),
        ...(rt.localAgentBadge?.(bot.model ?? bot.appliedModel) !== undefined ? { engine: rt.localAgentBadge(bot.model ?? bot.appliedModel) } : {}),
        ...(tail ? { lastAt: tail.lastAt, preview: tail.preview } : {}),
      }
    }),
    rooms: (Object.values(state.rooms) as any[]).map(({ log, seen, paused, sessions, segments, parts: ownParts, ...room }) => {
      const parts = [...Object.values(sessions ?? {}), ...(Object.values(segments ?? {}) as any[]).flat().map(segment => segment.sessionId), ...(ownParts ?? []).map(segment => segment.sessionId)]
      const last = (log ?? []).filter(line => line.kind === undefined).at(-1)
      return { ...room, sessionId: rt.sessionOfRoom(room), ownParts: (ownParts ?? []).map(segment => segment.sessionId), parts, ...(last ? { lastAt: last.time, preview: last.who === 'User' ? last.text : `${last.who}：${last.text}` } : {}) }
    }),
    privateArchives: rt.archivesView(),
    exchangeTurns: state.exchangeTurns,
    questions: state.questions,
    views: state.views ?? {},
    closedCards: state.closedCards ?? {},
    btwCards: rt.btwView?.() ?? {},
    sideChats: rt.sideView?.() ?? {},
    agents: Object.values(state.agents),
    sections: state.sections ?? [],
    secrets: rt.secretsView(),
    secretStore: rt.secretStoreStatus(),
    capabilities: rt.capabilityLibraryView(),
    secretRequests: state.secretRequests ?? {},
    connectorRequests: state.connectorRequests ?? {},
    mailRequests: state.mailRequests ?? {},
    colors: [...COLORS, ...EXTRA_COLORS],
    models: rt.cachedCatalog(),
    defaultModel: rt.cachedDefault() ?? null,
    profileDefaultModel: rt.defaultRef() ?? null,
    permissions: rt.permissionCatalog?.() ?? null,
    modelsKey: modelsKey(),
    prefs: state.prefs,
    browser: rt.browserEnabled,
    memory: rt.memoryEnabled !== false,
    readOnly: rt.readOnly() ?? null,
    im: rt.imView?.() ?? { connections: [], platforms: [] },
    computer: rt.computerView?.() ?? { enabled: false },
  })
  const live = () => ({
    secretStore: rt.secretStoreStatus(),
    secrets: rt.secretsView(),
    activity: rt.activityView(),
    partsRunning: Object.fromEntries((Object.values(state.bots) as any[])
      .flatMap(bot => [rt.chatOf(bot.id), ...(bot.openParts ?? []).map(part => part.sessionId)])
      .filter((sessionId, index, list) => sessionId !== undefined && list.indexOf(sessionId) === index)
      .filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
      .map(sessionId => [sessionId, true])),
    work: { bots: rt.workView(), rooms: rt.roomWorkView(), approvals: rt.approvalsView(), waiting: rt.waitingView?.() ?? {}, turns: rt.turnsView?.() ?? {}, steered: rt.steeredView?.() ?? {} },
    memoryNews: rt.memoryNews(),
    memoryReviews: rt.memoryReviews(),
    learning: rt.learningView(),
    learningSettled: rt.learningSettledView(),
    connectors: rt.connectorsView(),
    capabilityStatuses: rt.capabilityStatusesView(),
    phone: rt.phoneView(),
    imStatus: rt.imStatusView?.() ?? {},
    imVia: rt.replyOrigin?.viaView?.() ?? {},
    readOnly: rt.readOnly() ?? null,
    computerLive: rt.computerLive?.() ?? {},
    browserHolds: rt.browserChannel?.holdSnapshot?.() ?? {},
  })
  const liveRun = randomUUID()
  let liveSeq = 0
  let liveCache = null
  const liveAnswer = () => {
    const value = live()
    const json = JSON.stringify(value)
    if (liveCache?.json === json) return liveCache
    return liveCache = { key: `${liveRun}:${++liveSeq}`, value, json }
  }
  const READS = new Set(['secret-store', 'secret-unlock', 'state', 'models', 'efforts', 'providers', 'provider-models', 'earlier', 'chat', 'run-stats', 'room-progress', 'group-rows', 'exchange', 'exchange-text', 'file-text', 'usage', 'schedules', 'memory-view', 'browser-wait', 'browser-result', 'diagnostics', 'diagnostics-log', 'diagnostics-clear', 'update-check', 'update-install', 'dsh-update-install', 'repo-stars', 'approval-answer', 'thinking', 'avatar-library', 'computer-system-status', 'computer-shot', 'local-agents', 'local-agent-models', 'browser-frame', 'hello', 'notices', 'avatar', 'room-chat', 'usage-summary', 'image', 'markdown-image', 'file-download', 'changes-check', 'changes-summary', 'changes-diff'])

  async function setPrefs(body) {
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid('Unknown theme')
      state.prefs.theme = body.theme
    }
    if (body.accent !== undefined) {
      if (body.accent === null || body.accent === '') delete state.prefs.accent
      else if (/^#[0-9a-f]{6}$/i.test(body.accent)) state.prefs.accent = body.accent
      else throw invalid('Accent must be a #rrggbb color')
    }
    if (body.motion !== undefined) {
      if (body.motion === null || body.motion === 'normal') delete state.prefs.motion
      else if (body.motion === 'quiet' || body.motion === 'lively') state.prefs.motion = body.motion
      else throw invalid('Motion must be quiet, normal or lively')
    }
    if (body.effects !== undefined) {
      if (body.effects === null || body.effects === 'full') delete state.prefs.effects
      else if (body.effects === 'reduced' || body.effects === 'off') state.prefs.effects = body.effects
      else throw invalid('Effects must be full, reduced or off')
    }
    if (body.layout !== undefined) {
      if (body.layout === null || body.layout === 'bubble') delete state.prefs.layout
      else if (body.layout === 'flat') state.prefs.layout = body.layout
      else throw invalid('Layout must be bubble or flat')
    }
    if (body.width !== undefined) {
      if (body.width === null || body.width === 80) delete state.prefs.width
      else if (Number.isInteger(body.width) && body.width >= 50 && body.width <= 100) state.prefs.width = body.width
      else throw invalid('Width must be a whole percent from 50 to 100')
    }
    if (body.flatWidth !== undefined) {
      if (body.flatWidth === null || body.flatWidth === 100) delete state.prefs.flatWidth
      else if (Number.isInteger(body.flatWidth) && body.flatWidth >= 50 && body.flatWidth <= 100) state.prefs.flatWidth = body.flatWidth
      else throw invalid('Flat text width must be a whole percent from 50 to 100')
    }
    if (body.defaultBotModel !== undefined) {
      if (body.defaultBotModel === null || body.defaultBotModel === '') delete state.prefs.defaultBotModel
      else if (rt.isLocalAgentRef?.(body.defaultBotModel) === true) throw invalid('A local agent cannot be the default model: a new Bot chooses to run on one when it is created')
      else state.prefs.defaultBotModel = await rt.resolveModel(body.defaultBotModel)
    }
    if (body.backgroundModel !== undefined) {
      if (body.backgroundModel === null || body.backgroundModel === '') delete state.prefs.backgroundModel
      else if (rt.isLocalAgentRef?.(body.backgroundModel) === true) throw invalid('A local agent cannot be the background model')
      else state.prefs.backgroundModel = await rt.resolveModel(body.backgroundModel)
    }
    if (body.thinking !== undefined) {
      if (body.thinking === true) state.prefs.thinking = true
      else if (body.thinking === false || body.thinking === null) delete state.prefs.thinking
    }
    if (body.enterToSend !== undefined) {
      if (body.enterToSend === false) state.prefs.enterToSend = false
      else if (body.enterToSend === true || body.enterToSend === null) delete state.prefs.enterToSend
    }
    if (body.memoryAutoRecall !== undefined) {
      if (body.memoryAutoRecall === false) state.prefs.memoryAutoRecall = false
      else delete state.prefs.memoryAutoRecall
    }
    if (body.memoryLimits !== undefined) {
      const sizes = (Object.entries(body.memoryLimits ?? {}) as [string, any][]).filter(([scope, size]) => MEMORY_LIMIT_SCOPES.has(scope) && Number.isInteger(size) && size >= MEMORY_LIMIT_MIN && size <= MEMORY_LIMIT_MAX)
      if (sizes.length === 0) delete state.prefs.memoryLimits
      else state.prefs.memoryLimits = { ...state.prefs.memoryLimits, ...Object.fromEntries(sizes) }
    }
    return rt.save()
  }

  const handle = async (endpoint, payload, signal) => {
    try {
      const body = payload ?? {}
      await rt.refresh()
      const readOnly = rt.readOnly()
      if (readOnly !== undefined && !READS.has(endpoint)) return fail(readOnly, 'bot/read-only')
      switch (endpoint) {
        case 'state': {
          if (typeof body.locale === 'string' && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)) uiLocale = body.locale
          if (readOnly === undefined) await rt.bootstrap()
          await rt.catalog()
          await rt.loadSecrets()
          const answer = liveAnswer()
          if (body.since === state.revision && (body.models === undefined || body.models === modelsKey())) {
            if (body.live === answer.key) return ok({ revision: state.revision, unchanged: true, liveKey: answer.key })
            return ok({ revision: state.revision, unchanged: true, liveKey: answer.key, ...answer.value })
          }
          const out = { ...view(), liveKey: answer.key, ...answer.value }
          return ok(body.avatars === 'ref' ? rt.slimAvatars(out) : out)
        }
        case 'models':
          await rt.catalog({ fresh: true })
          return ok({ modelsKey: modelsKey() })
        case 'efforts':
          return ok(await rt.reasoningOf(String(body.ref ?? '')) ?? { efforts: [] })
        case 'thinking': {
          const sessionId = String(body.sessionId ?? '')
          const turn = Number(body.turn)
          if (!Number.isFinite(turn) || rt.selfOf(sessionId) === undefined) return ok(null)
          await rt.load()
          const ms = await rt.thinkingOf(sessionId, turn)
          return ok(ms === undefined ? {} : { ms })
        }
        case 'providers':
          return ok(await rt.providersView())
        case 'provider-key':
          if (body.value === null) await rt.clearProviderKey(String(body.provider ?? ''))
          else await rt.setProviderKey(String(body.provider ?? ''), body.value)
          return ok(await rt.providersView())
        case 'provider-add':
          return ok(await rt.addProvider(body))
        case 'provider-models':
          return ok(await rt.discoverModels(body))
        case 'provider-models-save':
          return ok(await rt.saveProviderModels(body))
        case 'provider-remove':
          return ok(await rt.removeProvider(String(body.provider ?? '')))
        case 'duplicate-bot':
          await rt.load()
          return ok(await rt.duplicateBot(body.id))
        case 'set-prefs':
          await rt.load()
          await setPrefs(body)
          return ok(state.prefs)
        case 'exchange': {
          await rt.load()
          return ok(rt.exchangesOf(body.a, body.b))
        }
        case 'exchange-text': {
          await rt.load()
          const entry = (body.a !== undefined && body.b !== undefined ? rt.exchangeOf(body.id, body.a, body.b) : undefined)
            ?? state.exchanges.find(item => item.id === body.id)
          if (entry === undefined) return fail('This message is no longer kept', 'bot/stale')
          return ok(await rt.exchangeText(entry))
        }
        case 'file-text': {
          if (typeof body.file?.attachmentId !== 'string') return fail('No file named', 'bot/invalid')
          const read = await rt.fileText(body.file)
          return read === undefined ? fail('This file cannot be read here', 'bot/unavailable') : ok(read)
        }
        case 'earlier':
          await rt.load()
          return ok(await rt.earlierPage(String(body.sessionId ?? ''), body.cursor ?? undefined))
        case 'chat':
          await rt.load()
          return ok(await rt.chatPage(String(body.botId ?? ''), body.cursor ?? undefined, body.steps === true))
        case 'run-stats': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          const projections = ctx.get?.('sessionProjections')
          if (projections === undefined) return ok(null)
          const agent = await rt.resolveAgent(rt.chatOf(bot.id))
          return ok(projections.snapshot(agent.session, RUN_STATS).values)
        }
        case 'usage':
          await rt.load()
          return ok(await rt.usageView({ timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined }))
        case 'room-progress': {
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          return ok([...rt.roomProgress.entries()].filter(([, entry]) => entry.roomId === (room?.id ?? body.roomId)).map(([callId, entry]) => ({ callId, replies: rt.groupRows(entry.roomId, entry.from), speaking: entry.slots.filter(slot => slot.status === 'speaking').map(slot => slot.id) })))
        }
        case 'group-search': {
          await rt.load()
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          if (room === undefined) return fail('Unknown group chat', 'bot/not-found')
          return ok(rt.groupSearch(room.id, body.query, { before: body.before, offset: body.offset }))
        }
        case 'changes-summary':
          return ok(rt.changesSummary(String(body.sessionId ?? ''), Number(body.seq)))
        case 'changes-diff':
          return ok(await rt.changesDiff(String(body.sessionId ?? ''), Number(body.seq), body.index, signal))
        case 'changes-check':
          return ok(rt.changesAvailable?.(String(body.sessionId ?? ''), Number(body.seq)) === true)
        case 'group-rows': {
          await rt.load()
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          const from = Number(body.from)
          const to = body.to === undefined ? undefined : Number(body.to)
          if (room === undefined || !Number.isInteger(from) || (to !== undefined && !Number.isInteger(to))) return ok({ rows: [], open: false, speaking: [] })
          const view = rt.groupRowsView(room.id, from, to, typeof body.anchor === 'string' ? body.anchor : undefined)
          const active = view.open && rt.roomActive(room.id)
          const speaking = active ? [...rt.roomProgress.values()].filter(round => round.roomId === room.id).flatMap(round => round.slots.filter(slot => slot.status === 'speaking').map(slot => slot.id)) : []
          return ok({ ...view, active, speaking })
        }
        case 'create-bot': {
          await rt.bootstrap()
          const bot = await rt.createBot({ name: body.name, role: body.role, color: body.color, instructions: body.instructions, brief: body.brief, avatar: body.avatar, model: body.model, effort: body.effort, workDir: body.workDir, section: body.section, sectionId: body.sectionId })
          return ok(bot)
        }
        case 'update-bot':
          await rt.load()
          return ok(await rt.updateBot(body.id, body))
        case 'abandon-work':
          await rt.load()
          if (rt.abandonWork?.(String(body.id ?? '')) !== true) return fail('That wait is no longer open', 'bot/stale')
          return ok(true)
        case 'resume': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          await rt.resumeBot(bot)
          return ok(true)
        }
        case 'avatar-library':
          await rt.load()
          return ok(await rt.avatarLibraryView({ offset: body.offset, limit: body.limit }))
        case 'avatar-import':
          await rt.load()
          return ok(await rt.avatarLibraryImport(Array.isArray(body.items) ? body.items : []))
        case 'avatar-delete':
          await rt.load()
          return ok(await rt.avatarLibraryDelete(String(body.id ?? '')))
        case 'delete-bot':
          await rt.load()
          await rt.deleteBot(body.id)
          return ok(view())
        case 'private-release':
          await rt.load()
          await rt.releaseArchive(String(body.id ?? ''))
          return ok(view())
        case 'set-main':
          await rt.load()
          await rt.setMain(body.id, body.main !== false, {
            primary: body.primary === true,
            replace: typeof body.replace === 'string' ? body.replace : undefined,
          })
          return ok(view())
        case 'create-room': {
          await rt.load()
          const room = await rt.createRoom({ members: Array.isArray(body.members) ? body.members : [], name: body.name, section: body.section, sectionId: body.sectionId, ...(typeof body.admin === 'string' ? { admin: body.admin } : {}) })
          if (body.greet === true) await rt.greetRoom(room.id).catch(error => rt.warn('ds-bot: greeting in %s failed: %s', room.name, error))
          return ok(room)
        }
        case 'update-room': {
          await rt.load()
          const { room, changes } = await rt.updateRoom(body.id, {
            name: body.name,
            notice: body.notice,
            mode: body.mode,
            admin: body.admin,
            members: Array.isArray(body.members) ? body.members : undefined,
            add: Array.isArray(body.add) ? body.add : undefined,
            remove: Array.isArray(body.remove) ? body.remove : undefined,
            workDir: body.workDir,
            permission: body.permission,
            section: body.section,
            sectionId: body.sectionId,
          })
          return ok({ room: view().rooms.find(entry => entry.id === room.id), changes })
        }
        case 'folders':
        case 'folder-pick':
        case 'folder-list':
          await rt.load()
          return ok(await rt.folderEndpoint(endpoint, body, signal))
        case 'team-workspace':
          await rt.load()
          return ok({ team: await rt.setTeamWorkspace(String(body.path ?? '')) })
        case 'add-agent':
          await rt.load()
          return ok(await rt.addAgent())
        case 'agent-session':
          await rt.load()
          return ok({ sessionId: await rt.createAgentSession(body.agentId, body.workspaceId) })
        case 'agent-adopt':
          await rt.load()
          return ok({ sessionId: await rt.adoptAgentSession(body.agentId, body.sessionId) })
        case 'agent-archive':
          await rt.load()
          await rt.archiveAgentSession(body.agentId, body.sessionId)
          return ok(true)
        case 'agent-rename':
          await rt.load()
          await rt.renameAgentSession(body.agentId, body.sessionId, body.title)
          return ok(true)
        case 'remove-agent':
          await rt.load()
          await rt.removeAgent(body.agentId)
          return ok(view())
        case 'set-flags':
          await rt.load()
          return ok(await rt.setFlags(body.id, body))
        case 'section-save':
          await rt.load()
          return ok(await rt.saveSection(body))
        case 'section-order':
          await rt.load()
          await rt.reorderSections(body.ids)
          return ok(view())
        case 'section-delete':
          await rt.load()
          await rt.deleteSection(body.id)
          return ok(view())
        case 'delete-room':
          await rt.load()
          await rt.deleteRoom(body.id)
          return ok(view())
        case 'approval-answer':
          rt.answerApproval(body.id, body.choice)
          return ok(true)
        case 'stop-member-work':
          return ok(await rt.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
        case 'stop-room-work':
          return ok(await rt.stopRoomWork(String(body.roomId ?? '')))

        case 'stop-chat':
          return ok(await rt.stopChat(String(body.botId ?? '')))
        case 'dismiss-question':
          await rt.load()
          if (rt.own(state.questions, body.sessionId) !== undefined) {
            rt.closeCard(body.sessionId, state.questions[body.sessionId], 'dismissed')
            delete state.questions[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'dismiss-view':
          await rt.load()
          if (rt.own(state.views, body.sessionId) !== undefined) {
            rt.closeCard(body.sessionId, state.views[body.sessionId], 'dismissed')
            delete state.views[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'secret-set':
        case 'secret-allow':
        case 'secret-cancel':
        case 'secret-update':
        case 'secret-delete':
        case 'secret-store':
        case 'secret-unlock':
        case 'secret-encrypt':
        case 'secret-decrypt':
          await rt.load()
          return ok(await rt.secretEndpoint(endpoint, body))
        case 'connector-connect':
        case 'connector-disconnect':
        case 'connector-retry':
        case 'connector-sign-in-code':
        case 'connector-cancel':
        case 'connector-client':
        case 'connector-set':
        case 'connector-add':
        case 'connector-remove':
        case 'connector-import-scan':
        case 'connector-import':
        case 'connector-request-cancel':
        case 'mail-account-add':
        case 'mail-account-remove':
        case 'mail-rule-set':
        case 'mail-send-answer':
        case 'mail-sign-in-code':
          await rt.load()
          return ok(await rt.connectorEndpoint(endpoint, body))
        case 'phone-set':
        case 'phone-pair':
        case 'phone-pair-cancel':
        case 'phone-remove':
          return ok(await rt.phoneEndpoint(endpoint, body))
        case 'capability-save':
        case 'capability-delete':
        case 'capability-approve':
        case 'bot-capability':
          await rt.load()
          return ok(await rt.capabilityEndpoint(endpoint, body))
        case 'schedules':
        case 'schedule-create':
        case 'schedule-delete':
          await rt.load()
          return ok(await rt.scheduleEndpoint(endpoint, body))
        case 'memory-view':
        case 'memory-ask':
        case 'memory-pin':
        case 'memory-tidy-undo':
        case 'memory-layer':
        case 'memory-move':
        case 'memory-forget':
        case 'memory-history':
        case 'memory-restore':
          await rt.load()
          return ok(await rt.memoryEndpoint(endpoint, body))
        case 'learning-answer':
        case 'learning-revise':
          await rt.load()
          return ok(await rt.learningEndpoint(endpoint, body))
        case 'hello':
        case 'notices':
        case 'avatar':
        case 'room-chat':
        case 'image':
        case 'file-download':
        case 'markdown-image':
        case 'usage-summary':
        case 'memory-edit':
        case 'memory-add':
          await rt.load()
          return ok(await rt.mobileEndpoint(endpoint, body))
        case 'answer-question': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          return ok(await rt.answerQuestion(body.sessionId, body.questionId, body.answer))
        }
        case 'view-reply': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const sessionId = rt.dispatch.resolveOwnThread(body.sessionId) ?? body.sessionId
          const pending = rt.own(state.views, sessionId)
          if (pending === undefined || pending.id !== body.viewId) return fail('This view is no longer open', 'bot/stale')
          const checked = validateViewAnswer(pending.view, body.action, body.values)
          if (checked.error !== undefined) return fail(checked.error, 'bot/invalid')
          const reply = viewReply(pending, body.action, body.values)
          if (reply === undefined) return fail('Nothing to send', 'bot/invalid')
          delete state.views[sessionId]
          try {
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            state.views[sessionId] ??= pending
            throw error
          }
          await rt.save()
          return ok(true)
        }
        case 'stage-image': {
          const mediaType = String(body.mediaType ?? '')
          const data = typeof body.data === 'string' ? body.data : ''
          if (!STAGED_TYPES.has(mediaType) || data === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail('This is not a photo DS Bot can send', 'bot/invalid')
          const now = Date.now()
          for (const [id, entry] of staged) if (entry.at < now - STAGED_MS) staged.delete(id)
          const id = randomUUID()
          staged.set(id, { mediaType, data, at: now })
          return ok({ id })
        }
        case 'send': {
          const text = String(body.text ?? '').trim()
          const ids = Array.isArray(body.images) ? body.images.map(String) : []
          if ((text === '' && ids.length === 0) || typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          const images = ids.map(id => staged.get(id))
          if (images.some(entry => entry === undefined)) return fail('A photo did not arrive. Send it again.', 'bot/stale')
          await rt.load()
          await rt.dispatch.sendUser({
            sessionId: body.sessionId,
            content: [
              ...(text === '' ? [] : [{ type: 'text', text }]),
              ...images.map(({ mediaType, data }) => ({ type: 'image', mediaType, data })),
            ],
          })
          for (const id of ids) staged.delete(id)
          return ok(true)
        }
        case 'btw-delete': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.cardId !== 'string' || body.cardId === '') return fail('Nothing to delete', 'bot/invalid')
          await rt.load()
          return ok(await rt.btwDelete({ sessionId: body.sessionId, cardId: body.cardId }))
        }
        case 'side-new': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to open', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideNew({ sessionId: body.sessionId }))
        }
        case 'side-ask': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to ask', 'bot/invalid')
          if (body.chatId !== undefined && typeof body.chatId !== 'string') return fail('Nothing to ask', 'bot/invalid')
          if (String(body.text ?? '').trim() === '') return fail('Write a question.', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideAsk({ sessionId: body.sessionId, chatId: body.chatId, recent: body.recent === true, text: String(body.text) }))
        }
        case 'side-cancel': {
          if (typeof body.chatId !== 'string' || body.chatId === '' || typeof body.entryId !== 'string' || body.entryId === '') return fail('Nothing to cancel', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideCancel({ chatId: body.chatId, entryId: body.entryId }))
        }
        case 'side-close': {
          if (typeof body.chatId !== 'string' || body.chatId === '') return fail('Nothing to close', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideClose({ chatId: body.chatId }))
        }
        case 'update-check': {
          const fresh = body.fresh === true
          return ok({ ...(await rt.updateCheck({ fresh })), dsh: (await rt.dshUpdateCheck?.({ fresh })) ?? null })
        }
        case 'update-install':
          return ok(rt.updateStart())
        case 'dsh-update-install':
          return ok(rt.dshUpdateStart?.())
        case 'repo-stars':
          return ok(await rt.repoStars())
        case 'browser-frame': {
          if (rt.browserFrame === undefined && rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const frame = typeof rt.browserFrame === 'function' ? await rt.browserFrame(String(body.botId ?? '')) : undefined
          if (frame === undefined) return fail('This Bot has no open browser', 'bot/not-found')
          return ok(frame)
        }
        case 'browser-wait': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : ''
          if (clientId === '') return fail('A browser poll needs a clientId', 'bot/invalid')
          await rt.load()
          const requests = await rt.browserChannel.wait(clientId, rt.browserOpen(body.open))
          return ok({ requests, holds: rt.browserChannel.holdSnapshot() })
        }
        case 'browser-result':
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          return ok(rt.browserChannel.result(body))
        case 'browser-takeover': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          const asked = rt.browserChannel.holdOf(botId)
          rt.browserChannel.setHold(botId, asked?.callId !== undefined
            ? { by: 'user', reason: asked.reason, note: asked.note, callId: asked.callId, ...(asked.sessionId !== undefined ? { sessionId: asked.sessionId } : {}) }
            : { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        case 'browser-give-back': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          if (body.outcome !== undefined && !['done', 'skip', 'returned'].includes(body.outcome)) return fail('Nothing to send', 'bot/invalid')
          const hold = rt.browserChannel.holdOf(botId)
          if (hold === null) return fail('This browser is not held', 'bot/forbidden')
          if (body.callId !== undefined && body.callId !== hold.callId) return fail('This handoff is no longer open', 'bot/stale')
          rt.browserChannel.setHold(botId, null)
          if (hold.callId === undefined) return ok(true)
          try {
            const sessionId = threadCurrentOfPart(rt.botOf(botId), hold.sessionId) ?? rt.chatOf(botId)
            const reply = handoffReply(hold, body.outcome)
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            if (rt.browserChannel.holdOf(botId) === null) rt.browserChannel.setHold(botId, hold)
            throw error
          }
          return ok(true)
        }
        case 'browser-stop': {
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          const sessionId = rt.chatOf(botId)
          if (sessionId && rt.live.get(sessionId)?.turn !== undefined) {
            const agent = await rt.resolveAgent(sessionId)
            agent.cancel({ kind: 'user' })
          }
          for (const room of Object.values(rt.state.rooms ?? {}) as any[]) {
            if (room.members?.includes(botId)) await rt.stopMemberWork?.(room.id, botId)
          }
          rt.browserChannel?.setHold(botId, { by: 'user', reason: 'stopped', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        case 'im-add':
        case 'im-update':
        case 'im-remove':
        case 'im-pair':
        case 'im-unpair':
        case 'im-chat':
        case 'im-retry':
        case 'im-login-start':
        case 'im-login-wait':
          await rt.load()
          return ok(await rt.imEndpoint(endpoint, body))
        case 'local-agents':
        case 'local-agent-models':
        case 'local-agent-refresh':
        case 'local-agent-add':
        case 'local-agent-update':
        case 'local-agent-remove':
          await rt.load()
          return ok(await rt.localAgentsEndpoint(endpoint, body))
        case 'bot-new-part': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          return ok(await rt.newPart(rt.chatOf(bot.id)))
        }
        case 'bot-open-part': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          return ok(await rt.switchPart(bot.id, String(body.sessionId ?? '')))
        }
        case 'diagnostics':
          await rt.load()
          return ok(await rt.diagnostics.report(body))
        case 'diagnostics-log':
          return ok(await rt.diagnostics.logText())
        case 'diagnostics-clear':
          await rt.diagnostics.clear()
          return ok(true)
        default:
          if (endpoint.startsWith('computer-')) {
            await rt.load()
            return ok(await rt.computerEndpoint(endpoint.slice('computer-'.length), body))
          }
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = errorCode(error)
      const message = error?.message ?? String(error)
      if (code === 'bot/internal') rt.noteFailure({ source: 'api', text: `${endpoint}: ${message}`, code: error?.code ?? error?.name, stack: error?.stack })
      return fail(message, code)
    }
  }

  rt.channelCall = handle
  rt.phoneServe(handle)

  async function answerQuestion(sessionRef, questionId, answer, requestId) {
    const sessionId = rt.dispatch.resolveOwnThread(sessionRef) ?? sessionRef
    const question = rt.own(state.questions, sessionId)
    if (question === undefined || question.id !== questionId) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
    const reply = questionReply(question, answer)
    if (reply === undefined) throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
    delete state.questions[sessionId]
    try {
      await rt.ensureCapabilities(sessionId)
      const agent = await rt.resolveAgent(sessionId)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: { ...reply.source, ...(requestId === undefined ? {} : { rpcId: requestId }) } }))
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      state.questions[sessionId] ??= question
      throw error
    }
    await rt.save()
    return true
  }

  Object.assign(rt, { answerQuestion })

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      const result = await handle(String(body?.endpoint ?? ''), body?.payload, request.signal)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'ds-bot: api route')

  ctx.effect(() => {
    void rt.load()
    return () => Promise.all([rt.btwDispose?.(), rt.sideDispose?.()])
  }, 'ds-bot: load state')
}
