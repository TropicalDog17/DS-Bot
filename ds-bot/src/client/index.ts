import { call } from './api.ts'
import { isHex, inkText, paintCss } from './inks.ts'
import { DEFAULT_MASK, SHAPES, markupCache, maskOf } from './characters.ts'
import { createSource, EMPTY_ROSTER, indexRoster, isAgentSession } from './sources.ts'
import { clearFront, teamActions } from './team-actions.ts'
import { themeCss, shellTokens, registry, registerShape, registerTheme, allThemes, layoutOf, effectsOf, widthOf, flatWidthOf } from './themes.ts'
import { readSkinSurfaceVars, writeSkinSurfaceVars } from './skin.ts'
import { MENTION_ORIGIN, currentPart } from './text.ts'
import { SHELL_CSS, CONVERSATION_CSS, botOwnCss, installStyles, installCompiledStyles, RETURN_TOKENS } from './styles.ts'
import { lookOf } from './mark.ts'
import { TeamSidebar, YouAvatar, AccountLauncher, FooterAccount, BrandMark, BrandName, BotReturn, SIDEBAR_CSS, RETURN_CSS, holdShellShortcuts } from './sidebar.ts'
import { installSettingsShell, SETTINGS_SHELL_CSS } from './settings-shell.ts'
import { frameLayout, readSidebar, writeSidebar, toggledPref, DSH_NARROW } from './frame-layout.ts'
import { installFrameWatch } from './frame-watch.ts'
import { HeaderPill } from './header.ts'
import { ComposerPlus, ComposerVoice, menuIcons } from './composer.ts'
import { CHATS_SOURCE, atSources } from './at-menu.ts'
import { BtwDock, BtwTurnTail } from './btw.ts'
import { SIDE_CSS, sideSource } from './side-chat.ts'
import { VOICE_BUNDLE, closingReplyText, requestPreparation } from './speech.ts'
import { sameVersion } from './dsh-offer.ts'
import { QuestionCard, QuestionDock } from './questions.ts'
import { AnsweredReply, WidgetDock, WIDGET_CSS } from './widget-cell.ts'
import { CHANGES_CSS } from './changes-card.ts'
import { HandoffDock, HANDOFF_CSS } from './handoff-card.ts'
import { AppAccessDock, ComputerHandoffDock, ComputerIndicator, COMPUTER_CSS } from './computer.ts'
import { installHeaderNavigation } from './header-navigation.ts'
import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, CellEmpty, TurnTailCell, ToolCell } from './cells.ts'
import { SaveFileAction } from './file-save.ts'
import { fileMentionSource } from './mention-source.ts'
import { FailureCell, TURN_ERROR_CSS } from './turn-error.ts'
import { Overlays } from './overlays.ts'
import { createPages } from './pages.ts'
import { installBoardPage } from '../board/client/index.ts'
import { BOARD_CSS } from '../board/client/board.ts'
import { CARD_TAG_CSS } from '../board/client/card-tag.ts'
import { textLinks } from './text-links.ts'
import { createBotBrowsers, serveBrowserReads } from './bot-browsers.ts'
import { BROWSER_CSS } from './browser-pane.ts'
import { SECRET_CSS, SecretDock } from './secret-card.ts'
import { ConnectorDock, MailDock, CONNECTOR_CSS } from './connectors.ts'
import { CONNECTORS_PAGE_CSS } from './connectors-page.ts'
import { LearningDock, LearningTurnTail, LEARNING_CSS } from './learning-card.ts'
import { MODEL_CSS, ModelChoiceDock, DeepSeekSignIn } from './model-menu.ts'
import { ReadOnlyDock, READ_ONLY_CSS } from './read-only-dock.ts'
import { BOT_SETTINGS_CSS } from './bot-settings.ts'
import { BOT_MODELS_CSS } from './bot-models-page.ts'
import { AGENT_CARDS_CSS } from './agent-cards.ts'
import { AVATAR_LIBRARY_CSS } from './avatar-library.ts'
import { GROUP_SETTINGS_CSS } from './group-settings.ts'
import { FOLDER_CSS } from './folder-menu.ts'
import { USAGE_CSS } from './usage-page.ts'
import { SCHEDULE_CSS } from './schedules.ts'
import { STORAGE, migrateStorage } from './storage.ts'
import { noteLeft, setUnread, sharedMap, toggleReaction } from './shared-map.ts'
import { freePriority, groupsFor, readMode, surfaceGroups, writeMode } from './surface.ts'
import { language, t } from './i18n.ts'
import { noteClientError, quietly } from './diagnostics.ts'
import { steerQueued } from './enter-steer.ts'
import { installCommandActions } from './command-actions.ts'
import { RIGHTBAR_ATTRIBUTES, columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from './right-panel.ts'
import { ErrorToast, FEEDBACK_CSS } from './feedback.ts'
import { ABOUT_CSS } from './about.ts'
import { MEMBER_CSS, MemberDock } from './member-status.ts'
import { IM_CSS } from './im-page.ts'
import { BotMention, USER_MESSAGE_CSS, UserMessageCell, canDrawUserMessages, installUserBubble } from './user-message.ts'
import { BOT_MENTION_ID, installBotMentionRule } from './user-text-rule.ts'
import { QueueDock, QUEUE_CSS } from './queue-dock.ts'
import { PASTE_CSS, PasteDock, PasteGuard } from './paste-card.ts'
import { OPENING_CSS, bindOpeningWait } from './opening.ts'
import { noticeApprovals } from './approval-notices.ts'
import { listedOpener } from './open-listed.ts'
import { needsIdleSample, pollDelay } from './polling.ts'
import { installMotionRest } from './motion-rest.ts'
import { agentSessionToReuse, singleFlight } from './agent-new.ts'
import { TextSelectionAction, ANNOTATION_CSS } from './text-annotation.ts'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout']

export function apply(ctx) {
  migrateStorage()
  const PREFS_KEY = STORAGE.prefs
  let savedPrefs = {}
  try { savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {} } catch { savedPrefs = {} }
  const roster = createSource({ ...EMPTY_ROSTER, prefs: savedPrefs })
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  const ui = createSource({ details: null, view: 'details', readOnlyPart: null, renaming: false, tab: null, side: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, paste: {}, pendingOpen: null, settings: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {}, panelYield: false, leftDrawer: false, bootFailed: false, page: null })
  const pages = createPages({
    alert: ({ page, text, onOpen }) => ui.set(state => ({ ...state, toast: { text, token: Date.now(), page, onOpen } })),
  })
  if (typeof ctx.provide === 'function') ctx.provide('dsBotPages', pages.service)
  let sidebarSaved = readSidebar()
  const sidebarPref = createSource(sidebarSaved.pref)
  const frame = createSource({ viewport: typeof window === 'undefined' ? 0 : window.innerWidth, sidebarWidth: sidebarSaved.width, collapsedWidth: 0, collapsed: false })
  const surface = createSource({ mode: readMode(), plain: false })
  const settingsShellHeld = createSource(false)
  let settingsShell = null
  let agentSessionCache = new Set()
  try { agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? '[]')) } catch { agentSessionCache = new Set() }
  const pendingAdopt = new Map()
  // A create can finish before the DSH list publishes its Session (#1225).
  const pendingAgentSession = new Map()
  const agentNewInFlight = new Map()
  const isAgentSessionId = id => isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id)
  const agentOfSession = id => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id)
  const workspaces = ctx.get('workspaces')
  const workspaceOf = (sessionId) => {
    const items = workspaces?.list?.getSnapshot()?.items ?? []
    return items.find(item => item.sessionIds?.includes(sessionId))?.workspaceId
  }
  let expected = null
  const setPlain = (plain) => surface.set(state => (state.plain === plain ? state : { ...state, plain }))
  const dropPanels = () => ui.set(state => (state.details || state.renaming ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state))
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? roster.getSnapshot().roomsById?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }
  ctx.effect(() => {
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, 'ds-bot: remember visits on page hide')
  ctx.effect(() => {
    const onStorage = (event) => {
      if (event.storageArea !== localStorage) return
      if (event.key === null || event.key === unreadStore.key) ui.set(state => ({ ...state, unread: unreadStore.read(state.unread) }))
      if (event.key === null || event.key === reactionStore.key) ui.set(state => ({ ...state, reactions: reactionStore.read(state.reactions) }))
      if (event.key === null || event.key === seenStore.key) seenAt = seenStore.read(seenAt)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, 'ds-bot: follow other windows')
  const activity = createSource({})
  const work = createSource({ bots: {}, approvals: [] })
  let workKey = ''
  let liveKey
  const live = createSource({})
  const computer = createSource({})
  let computerKey = '{}'
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  let activityKey = '{}'
  const memoryNews = createSource({})
  let memoryNewsKey
  const noteMemoryNews = (next) => {
    const key = JSON.stringify(next)
    if (key === memoryNewsKey) return
    const opening = memoryNewsKey === undefined
    memoryNewsKey = key
    memoryNews.set(state => Object.fromEntries((Object.entries(next) as [string, any][]).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }
  const refreshed = new Set()
  let pulls = 0
  let applied = 0
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', live: liveKey, locale: language() })
    if (order < applied) return
    applied = order
    const prevLiveKey = liveKey
    if (value.liveKey !== undefined) liveKey = value.liveKey
    if (value.activity !== undefined) {
      const nextActivity = JSON.stringify(value.activity)
      if (nextActivity !== activityKey) { activityKey = nextActivity; activity.set(value.activity) }
    }
    if (value.work !== undefined) {
      const nextWork = JSON.stringify(value.work)
      if (nextWork !== workKey) { workKey = nextWork; work.set(value.work) }
    }
    if (value.computerLive !== undefined) {
      const nextComputer = JSON.stringify(value.computerLive)
      if (nextComputer !== computerKey) { computerKey = nextComputer; computer.set(value.computerLive) }
    }
    if (value.memoryNews !== undefined) noteMemoryNews(value.memoryNews)
    const current = roster.getSnapshot()
    const live: Record<string, any> = {}
    if (value.partsRunning !== undefined && JSON.stringify(value.partsRunning) !== JSON.stringify(current.partsRunning ?? {})) live.partsRunning = value.partsRunning
    if (value.secretStore !== undefined && JSON.stringify(value.secretStore) !== JSON.stringify(current.secretStore ?? {})) live.secretStore = value.secretStore
    if (value.secrets !== undefined && JSON.stringify(value.secrets) !== JSON.stringify(current.secrets ?? [])) live.secrets = value.secrets
    if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) live.connectors = value.connectors
    if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})) live.capabilityStatuses = value.capabilityStatuses
    if (value.phone !== undefined && JSON.stringify(value.phone) !== JSON.stringify(current.phone ?? null)) live.phone = value.phone
    if (value.learning !== undefined && JSON.stringify(value.learning) !== JSON.stringify(current.learning ?? {})) live.learning = value.learning
    if (value.learningSettled !== undefined && JSON.stringify(value.learningSettled) !== JSON.stringify(current.learningSettled ?? {})) live.learningSettled = value.learningSettled
    if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(current.btwCards ?? {})) live.btwCards = value.btwCards
    if (value.sideChats !== undefined && JSON.stringify(value.sideChats) !== JSON.stringify(current.sideChats ?? {})) live.sideChats = value.sideChats
    if (value.imStatus !== undefined && JSON.stringify(value.imStatus) !== JSON.stringify(current.imStatus ?? {})) live.imStatus = value.imStatus
    if (value.imVia !== undefined && JSON.stringify(value.imVia) !== JSON.stringify(current.imVia ?? {})) live.imVia = value.imVia
    if (value.readOnly !== undefined && (value.readOnly ?? null) !== (current.readOnly ?? null)) live.readOnly = value.readOnly
    if (Object.keys(live).length > 0 && current.ready) roster.set({ ...current, ...live })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) {
      return value.liveKey !== undefined && value.liveKey !== prevLiveKey
    }
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    roster.set(indexRoster(value))
    try {
      const ids = (value.agents ?? []).flatMap(agent => agent.sessions ?? [])
      localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids))
      agentSessionCache = new Set(ids)
    } catch {}
    const listed = ctx.sessions.list.getSnapshot().byId ?? {}
    for (const id of pendingAdopt.keys()) {
      if (roster.getSnapshot().agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id)
    }
    for (const [agentId, sessionId] of pendingAgentSession) {
      if (listed[sessionId] !== undefined || roster.getSnapshot().agentOf[sessionId] !== agentId) pendingAgentSession.delete(agentId)
    }
    for (const id of [...value.bots.map(currentPart), ...value.rooms.map(room => room.sessionId ?? room.id)]) {
      if (refreshed.has(id)) continue
      refreshed.add(id)
      void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly('refresh projections'))
    }
    return true
  }

  ctx.effect(() => {
    let stopped = false
    let running = false
    let timer
    let misses = 0
    // While the host keeps answering that nothing changed, asking every 1.5 s only makes
    // the renderer serialise requests and compare answers (#1462). The wait stretches to
    // POLL_MAX_MS and snaps back on the first change, a wake, or any action's own pull.
    let unchanged = 0
    const loop = async () => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      try {
        unchanged = await pull() ? 0 : unchanged + 1
        misses = 0
        ui.set(state => (state.bootFailed ? { ...state, bootFailed: false } : state))
      } catch (error) {
        if (!stopped) {
          console.warn('[ds-bot] state', error)
          // Only a missing Bot API counts toward a failed start: while the
          // host plugin stays unmounted the route answers 404. A network miss
          // is the host reconnecting, not a start-up failure (#516).
          if (error?.code === 'HTTP_404') {
            misses += 1
            if (misses >= 10 && !roster.getSnapshot().ready) ui.set(state => (state.bootFailed ? state : { ...state, bootFailed: true }))
          }
        }
      } finally { running = false }
      if (!stopped) timer = setTimeout(loop, pollDelay(document.hidden ? 10000 : 1500, unchanged))
    }
    const wake = () => { if (!document.hidden) { unchanged = 0; void loop() } }
    document.addEventListener('visibilitychange', wake)
    void loop()
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, 'ds-bot: roster poll')

  const update = createSource({ available: false, phase: 'idle' })
  let wakeUpdate = () => {}
  ctx.effect(() => {
    let stopped = false
    let timer
    const loop = async () => {
      clearTimeout(timer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      if (value) update.set(previous => ({ ...value, app: previous.app, ownApp: previous.ownApp }))
      timer = setTimeout(loop, value?.phase === 'installing' || value?.dsh?.phase === 'installing' ? 2000 : 60 * 60_000)
    }
    wakeUpdate = loop
    void loop()
    return () => { stopped = true; clearTimeout(timer); wakeUpdate = () => {} }
  }, 'ds-bot: update check')

  const appUpdates = (window as any).dshDesktop?.protocolVersion === 1 ? (window as any).dshDesktop.updates ?? null : null
  if (appUpdates?.status && appUpdates.subscribe) {
    ctx.effect(() => {
      let stopped = false
      const take = (app) => { if (!stopped && app) update.set(previous => ({ ...previous, app })) }
      void appUpdates.status().then(take, () => {})
      const unsubscribe = appUpdates.subscribe(take)
      return () => { stopped = true; unsubscribe?.() }
    }, 'ds-bot: app update status')
  }

  const ownAppUpdates = globalThis.dsBotApp?.updates ?? null
  if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
    ctx.effect(() => {
      let stopped = false
      const take = (ownApp) => { if (!stopped && ownApp) update.set(previous => ({ ...previous, ownApp })) }
      void ownAppUpdates.state().then(take, () => {})
      const unsubscribe = ownAppUpdates.subscribe(take)
      return () => { stopped = true; unsubscribe?.() }
    }, 'ds-bot: own app update state')
  }

  const bridge = ((window as any).dshDesktop?.protocolVersion === 1 ? (window as any).dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null
  const browsers = bridge ? createBotBrowsers({ bridge, createSource }) : null
  if (browsers) {
    ctx.effect(() => {
      let stopReads = null
      const sync = () => {
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready) return
        const on = snapshot.browser === true
        if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
        if (!on && stopReads) { stopReads(); stopReads = null }
        void browsers.retain(snapshot.bots.map(bot => bot.id))
        ui.set(state => (state.details && state.view === 'browser' && (!on || !snapshot.byId[state.details]) ? { ...state, view: 'details' } : state))
      }
      sync()
      const offRoster = roster.subscribe(sync)
      return () => { offRoster(); stopReads?.(); browsers.dispose() }
    }, 'ds-bot: Bot browsers')
  }

  ctx.effect(() => () => { markupCache.clear() }, 'ds-bot: character markup')
  ctx.effect(() => installMotionRest(), 'ds-bot: motion rest')

  // Mentions wear each Bot's color and character silhouette (or its photo). User text
  // DSH draws (a message waiting to be sent or to join a running turn, and since DSH
  // 0.2.1-alpha.3 the contents of DS Bot's own user bubble, .bt-uhost) shows "@Name" as
  // a file reference; one whose label is a whole Bot name wears the Bot's mark there too
  // (a name with a space is cut by DSH, so it stays as DSH draws it).
  const installMentions = () => {
    const style = installStyles('', 'mentions')
    let last = ''
    const render = () => {
      const next = roster.getSnapshot().bots.map((bot) => {
        const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
        const chip = /\s/.test(bot.name) ? '' : `:is([class*="_userRow"],.bt-uhost) [data-ref-chip="file"][title="@${bot.name.replace(/["\\]/g, '\\$&')}" i]`
        const look = lookOf(bot)
        const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`
        const mark = look.image
          ? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
          : `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
        const chipBase = chip ? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}` : ''
        return `${anchor}{color:${inkText(look.color)}}${chipBase}${mark}`
      }).join('\n')
      if (next !== last) style.textContent = last = next
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); style.remove() }
  }

  const installTheme = () => {
    const style = installStyles('', 'theme')
    let key = ''
    let releaseTokens = null
    let activeTheme = null
    const skin = writeSkinSurfaceVars(document, () => (activeTheme === null ? {} : readSkinSurfaceVars(document, activeTheme)))
    const offTheme = ctx.on('theme/change', () => skin.apply())
    // A skin may write the tokens itself (some set them straight on the document); the
    // composed value is what counts, so re-read whenever the tokens may have moved.
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => skin.apply()) : null
    if (observer !== null) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
      observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    }
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = allThemes()
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      const accent = isHex(prefs.accent) ? prefs.accent : undefined
      const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : 'normal'
      const layout = layoutOf(prefs)
      const effects = effectsOf(prefs)
      const width = widthOf(prefs)
      const flatWidth = flatWidthOf(prefs)
      document.body.dataset.btMotion = motion
      document.body.dataset.btLayout = layout
      document.body.dataset.btEffects = effects
      document.body.style.setProperty('--bt-msg-w', String(width / 100))
      document.body.style.setProperty('--bt-flat-w', String(flatWidth / 100))
      const next = `${id}|${accent ?? ''}|${motion}|${layout}|${effects}|${width}|${flatWidth}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      style.textContent = themeCss(themes[id], accent)
      activeTheme = themes[id]
      skin.apply()
      const release = releaseTokens
      releaseTokens = ctx.theme.overrideTokens('ds-bot', shellTokens(themes[id]))
      if (typeof release === 'function') release()
      if (snapshot.ready) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: prefs.theme, accent: prefs.accent, motion: prefs.motion, layout: prefs.layout, effects: prefs.effects, width: prefs.width, flatWidth: prefs.flatWidth, thinking: prefs.thinking, defaultBotModel: prefs.defaultBotModel, backgroundModel: prefs.backgroundModel, enterToSend: prefs.enterToSend })) } catch {}
      }
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => {
      offRoster()
      offRegistry()
      offTheme()
      observer?.disconnect()
      skin.clear()
      try {
        if (typeof releaseTokens === 'function') releaseTokens()
      } finally {
        delete document.body.dataset.btMotion
        delete document.body.dataset.btLayout
        delete document.body.dataset.btEffects
        document.body.style.removeProperty('--bt-msg-w')
        document.body.style.removeProperty('--bt-flat-w')
        style.remove()
      }
    }
  }

  ctx.effect(() => {
    const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
    const win = window as any
    const queued = Array.isArray(win.dshBotQueue) ? win.dshBotQueue : []
    win.dshBot = hub
    win.dshBotQueue = { push: (task) => { try { task(hub) } catch (error) { console.warn('[ds-bot] registration', error); noteClientError('registration', error) } } }
    for (const task of queued) win.dshBotQueue.push(task)
    return () => {
      if (win.dshBot === hub) delete win.dshBot
      delete win.dshBotQueue
    }
  }, 'ds-bot: registry')

  ctx.inject(['shortcuts'], scope => { scope.effect(() => holdShellShortcuts(scope.shortcuts), 'ds-bot: settings shortcut') })

  // DSH's own changes-review tab opens by resource address in the right column. A window
  // without that column never provides the service; the change row then says it cannot
  // open the review instead of doing nothing.
  let openReview
  ctx.inject(['sidebarRight'], (scope) => {
    openReview = changes => scope.sidebarRight.openResource(`dsh-resource://changes-review/session/${encodeURIComponent(changes.sessionId)}/${changes.seq}/${changes.turn}`)
    scope.effect(() => () => { openReview = undefined }, 'ds-bot: change review opener')
  })
  const openChangesReview = (changes, tries = 60) => {
    actions.openSession(changes.sessionId)
    let left = tries
    const timer = setInterval(() => {
      if (mainView() === changes.sessionId) {
        try {
          openReview(changes)
          clearInterval(timer)
          return
        } catch {}
      }
      if ((left -= 1) <= 0) {
        clearInterval(timer)
        actions.notice(t('This window cannot open the change review'))
      }
    }, 100)
  }

  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  const partFor = (id) => {
    const snapshot = roster.getSnapshot()
    const bot = snapshot.byId[id]
    if (bot !== undefined) return currentPart(bot)
    const room = snapshot.roomsById[id]
    return room === undefined ? id : (room.sessionId ?? room.id)
  }
  const agentSessions = (agentId) => {
    const ids = [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])]
    for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id)
    return ids
  }
  const latestAgentSession = (agentId, list) => agentSessions(agentId)
    .sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))[0]
  const mainView = () => (Object.values(ctx.sessions.list.getSnapshot().byId ?? {}) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  // A Session the Host made a moment ago is not in the shell's list yet, so the main view
  // would keep showing the chat that was there before — for a Bot the user just opened,
  // that reads as "the new Bot loaded someone else's conversation" (#1196). The asked-for
  // Bot stays over that chat until its Session is the one on screen, or the user opens
  // something else. A long wait changes the note and asks for the list again; it does
  // not uncover the previous conversation.
  const ownerOfSession = (sessionId) => {
    const snapshot = roster.getSnapshot()
    if (snapshot.byId[sessionId] !== undefined) return snapshot.byId[sessionId]
    if (snapshot.roomsById[sessionId] !== undefined) return snapshot.roomsById[sessionId]
    return (Object.values(snapshot.byId) as any[]).find(bot => currentPart(bot) === sessionId)
      ?? (Object.values(snapshot.roomsById) as any[]).find(room => (room.sessionId ?? room.id) === sessionId)
  }
  const openingWait = bindOpeningWait(ui, {
    onSlow: () => { void Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')) },
  })
  const beginOpening = (target) => {
    const owner = ownerOfSession(target)
    openingWait.begin({ target, id: owner?.id ?? target, name: owner?.name ?? '' })
  }
  const endOpening = () => { openingWait.end() }
  const show = listedOpener({ list: ctx.sessions.list, refresh: () => Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')), open: (target) => { expected = target; ctx.uiWorkspace.openSession(target) }, current: mainView, begin: beginOpening, done: endOpening })
  const panelFolded = (view) => {
    const state = ui.getSnapshot()
    if (state.details === null) return false
    const f = frame.getSnapshot()
    return frameLayout({ viewport: f.viewport, sidebarWidth: f.sidebarWidth, pref: sidebarPref.getSnapshot(), drawer: state.leftDrawer, panel: { view: view ?? state.view, yielded: state.panelYield === true } }).panel === 'folded'
  }
  const yieldBrowser = state => state.panelYield === true || panelFolded('browser')
  const homeToMainBot = () => {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready || !snapshot.mainBotId) return
    const main = mainView()
    if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
      actions.openSession(snapshot.mainBotId)
    }
  }
  const ensureBotHome = () => {
    if (roster.getSnapshot().ready) homeToMainBot()
    else {
      const off = roster.subscribe(() => {
        if (!roster.getSnapshot().ready) return
        off()
        homeToMainBot()
      })
    }
  }
  const actions: Record<string, any> = {
    ...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, panelFolded }),
    openChanges: async (changes) => {
      if (changes === null || typeof changes !== 'object' || typeof changes.sessionId !== 'string'
        || !Number.isInteger(changes.seq) || !Number.isInteger(changes.turn)) return
      let available = false
      try { available = (await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })) === true } catch { available = false }
      if (!available) { actions.notice(t('These changes are no longer available')); return }
      if (openReview === undefined) { actions.notice(t('This window cannot open the change review')); return }
      openChangesReview(changes)
    },
    learningAnswer: (id, approve) => after(call('learning-answer', { id, approve })),
    learningRevise: (id, note) => after(call('learning-revise', { id, note })),
    isAgentSession: id => isAgentSessionId(id),
    openSession: (id) => {
      if (isAgentSessionId(id)) return actions.openAgentSession(id)
      ui.set(clearFront)
      setPlain(false)
      const target = partFor(id)
      show(target)
    },
    openAgentSession: (sessionId) => {
      ui.set(state => ({ ...clearFront(state), details: null, view: 'details', renaming: false, tab: null }))
      setPlain(true)
      show(sessionId)
    },
    addAgent: async () => {
      const agent = await after(call('add-agent'))
      if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const latest = latestAgentSession(agentId, list)
      if (latest === undefined) return actions.newAgentSession(agentId)
      actions.openAgentSession(latest)
    },
    newAgentSession: async (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      return singleFlight(agentNewInFlight, agentId, async () => {
        const list = ctx.sessions.list.getSnapshot()
        const latest = latestAgentSession(agentId, list)
        const pending = pendingAgentSession.get(agentId)
        if (pending !== undefined && list.byId[pending] !== undefined) pendingAgentSession.delete(agentId)
        const reuse = agentSessionToReuse(list, latest, pending)
        if (reuse !== undefined) {
          actions.openAgentSession(reuse)
          return reuse
        }
        const { sessionId } = await after(call('agent-session', { agentId, workspaceId: workspaceOf(latest) }))
        if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) pendingAgentSession.set(agentId, sessionId)
        actions.openAgentSession(sessionId)
        return sessionId
      })
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = (Object.values(list.byId ?? {}) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== sessionId) return
      const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? []
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = (Object.values(list.byId ?? {}) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    landOn: async (id, last) => {
      if (last) await pull().catch(() => {})
      const bot = last ? roster.getSnapshot().byId[last.botId] : undefined
      setPlain(false)
      const target = bot && currentPart(bot) !== last.sessionId ? currentPart(bot) : partFor(id)
      show(target)
    },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    setSidebarPref: (pref) => {
      const next = pref === 'rail' || pref === 'hidden' ? pref : 'open'
      sidebarSaved = { ...sidebarSaved, pref: next, ...(next === 'hidden' ? {} : { shown: next }) }
      writeSidebar(sidebarSaved)
      sidebarPref.set(next)
    },
    toggleLeftHidden: () => {
      ui.set(state => (state.leftDrawer || state.panelYield ? { ...state, leftDrawer: false, panelYield: false } : state))
      actions.setSidebarPref(toggledPref(sidebarPref.getSnapshot(), sidebarSaved.shown))
    },
    setSidebarWidth: (width) => {
      sidebarSaved = { ...sidebarSaved, width }
      writeSidebar(sidebarSaved)
      frame.set(state => (state.sidebarWidth === width ? state : { ...state, sidebarWidth: width }))
    },
    setLeftDrawer: (on) => ui.set(state => (state.leftDrawer === on ? state : { ...state, leftDrawer: on })),
    setPanelYield: (on) => ui.set(state => (state.panelYield === on ? state : { ...state, panelYield: on })),
    surfaceMode: () => surface.getSnapshot().mode,
    setSurface: (mode) => {
      if (mode !== 'bot' && mode !== 'agent') return
      if (surface.getSnapshot().mode === mode) {
        if (mode === 'bot') ensureBotHome()
        return
      }
      if (mode === 'agent') {
        ui.set(state => ({ ...state, details: null, view: 'details', settings: null, palette: null, groupSearch: null, newChat: null, menu: null, voice: null, exchange: null, memory: null, toast: null }))
      }
      writeMode(mode)
      surface.set(state => ({ ...state, mode }))
      // The Bot view kept the shell's sidebar collapsed under its own column; the
      // shell's own view gets it back (below DSH_NARROW the shell decides itself).
      if (mode === 'agent' && window.innerWidth >= DSH_NARROW && frame.getSnapshot().collapsed) ctx.layout.toggleSidebar()
      if (mode !== 'bot') return
      ensureBotHome()
    },
    markUnread: id => writeUnread(id, true),
    beginVisit: (id) => {
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => {
      const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
      ui.set(state => ({ ...state, reactions }))
    },
    clearUnread: id => writeUnread(id, false),
  }
  if (browsers) {
    Object.assign(actions, {
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null, panelYield: yieldBrowser(state) }))
      },
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null, panelYield: yieldBrowser(state) }))
        return tabId
      },
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser', panelYield: yieldBrowser(state) }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: (botId, tabId) => browsers.closeTab(botId, tabId),
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: (tabId) => browsers.focus(tabId),
      browserTakeover: bridge.views ? async botId => {
        const result = await call('browser-takeover', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      browserStop: bridge.views ? async botId => {
        const result = await call('browser-stop', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      browserGiveBack: bridge.views ? async (botId, answer = {}) => {
        const result = await call('browser-give-back', { botId, ...answer })
        await bridge.views.hold(botId, false)
        return result
      } : undefined,
      browserImport: typeof bridge.importSources === 'function' ? {
        sources: () => bridge.importSources(),
        pick: () => bridge.importPick(),
        live: (source, close) => bridge.importLive(source, close),
        apply: (botId, pending) => bridge.importApply(`bot:${botId}`, pending),
        cancel: (pending) => bridge.importCancel(pending),
      } : null,
    })
  }
  actions.signInEntry = () => ctx.slots.entries?.('settings.models.sign-in')?.[0] ?? null
  actions.canSignIn = () => Boolean(actions.signInEntry())
  actions.signIn = () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 }))
  actions.closeSignIn = () => ui.set(state => ({ ...state, signIn: null }))
  actions.accountT = () => ctx.get('locale').bind('settings.account')
  // DSH's Plugins page (bundle install and management): its navigation face is
  // absent where the peer may not list bundles, such as the app's own profile.
  actions.hasPlugins = () => ctx.get('pluginNavigation') !== undefined
  actions.openPlugins = () => ctx.get('pluginNavigation')?.openList()
  actions.speech = () => ctx.get('remote.speech') ?? undefined
  actions.openHarnessOnboarding = id => settingsShell?.openOnboarding(id)
  // With the plugin manager mounted, setup is its bundle page (the model's size
  // and download notes live there). Where it is not mounted — the desktop app's
  // profile has no plugin manager — the speech Remote prepares the provider
  // itself, and the voice pane follows its progress.
  actions.voiceSetup = (providerId) => {
    const navigation = ctx.get('pluginNavigation')
    if (navigation !== undefined) return { navigate: () => navigation.openBundle(VOICE_BUNDLE) }
    const speech = ctx.get('remote.speech')
    return speech === undefined || providerId === undefined ? null : { prepare: () => requestPreparation(speech, providerId) }
  }
  actions.closingReply = (sessionId, turn) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return null
      return closingReplyText(ctx.uiConversation.binding(binding).target('chat').getSnapshot(), turn)
    } catch {
      return null
    }
  }
  actions.seatAccount = on => ui.set(state => (state.accountSeated === on ? state : { ...state, accountSeated: on }))
  actions.installUpdate = async () => {
    const value = await call('update-install')
    update.set(previous => ({ ...previous, ...value }))
    wakeUpdate()
  }
  actions.installDshUpdate = async () => {
    const dsh = await call('dsh-update-install')
    update.set(previous => ({ ...previous, dsh }))
    wakeUpdate()
  }
  actions.openAppUpdates = async (verified) => {
    const app = await appUpdates?.status?.()
    if (app) update.set(previous => ({ ...previous, app }))
    if (sameVersion(app?.version, verified)) await appUpdates.open()
  }
  actions.checkUpdate = async () => {
    const value = await call('update-check', { fresh: true })
    update.set(previous => ({ ...value, app: previous.app, ownApp: previous.ownApp }))
    wakeUpdate()
  }
  actions.checkOwnApp = async () => { await ownAppUpdates?.check?.() }
  actions.installOwnApp = async () => { await ownAppUpdates?.install?.() }
  actions.openOwnApp = async () => { await ownAppUpdates?.open?.() }
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const browserHolds = browsers?.holds ?? createSource({})

  const appComputer = globalThis.dsBotApp
  if (typeof appComputer?.computer === 'function') {
    ctx.effect(() => {
      const nameOf = id => roster.getSnapshot().byId[id]?.name ?? 'a Bot'
      const sync = () => {
        const live = computer.getSnapshot()
        const name = id => nameOf(id)
        const look = id => lookOf(roster.getSnapshot().byId[id])
        const rows = (live.leases ?? []).map(entry => ({
          botId: entry.botId,
          name: name(entry.botId),
          app: entry.kind === 'foreground' ? t('In the foreground') : entry.appName,
          label: entry.kind === 'foreground' ? t('{name} · foreground', { name: name(entry.botId) }) : `${name(entry.botId)} · ${entry.appName}`,
          color: look(entry.botId).color,
          avatar: look(entry.botId).image,
        }))
        for (const [botId, entry] of Object.entries(live.bots ?? {}) as [string, any][]) {
          if (entry.waitingFor === 'user-idle') rows.push({ botId, waiting: true, name: name(botId), app: t('waits for the computer'), label: t('{name} waits for the computer', { name: name(botId) }), color: look(botId).color, avatar: look(botId).image })
        }
        appComputer.computer({
          rows,
          labels: { stop: t('Stop'), stopAll: t('Stop all'), letGo: t('Let it continue') },
        })
      }
      sync()
      return computer.subscribe(sync)
    }, 'ds-bot: computer indicator')
  }
  if (typeof appComputer?.computerCursor === 'function') {
    ctx.effect(() => {
      let dead = false
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
      const run = async () => {
        let after = 0
        while (!dead) {
          if (roster.getSnapshot().computer?.enabled !== true) { await pause(2000); continue }
          try {
            const reply = await call('computer-cursor-wait', { after })
            for (const event of reply?.events ?? []) {
              if (Number.isFinite(event.seq) && event.seq > after) after = event.seq
              if (Number.isFinite(event.t) && Number.isFinite(reply?.now) && reply.now - event.t > 3000) continue
              appComputer.computerCursor({ ...event, color: lookOf(roster.getSnapshot().byId[event.botId]).color, avatar: lookOf(roster.getSnapshot().byId[event.botId]).image })
            }
          } catch {
            await pause(2000)
          }
        }
      }
      void run()
      return () => { dead = true }
    }, 'ds-bot: computer cursor')
  }
  if (typeof appComputer?.idleSeconds === 'function') {
    ctx.effect(() => {
      const push = () => {
        const current = roster.getSnapshot()
        if (current.computer?.enabled !== true) return
        if (!needsIdleSample(computer.getSnapshot(), current.computer)) return
        void Promise.resolve(appComputer.idleSeconds()).then((idle) => {
          if (Number.isFinite(idle)) call('computer-user-active', { idleSeconds: idle }).catch(() => {})
        }).catch(() => {})
      }
      const timer = setInterval(push, 2000)
      return () => { clearInterval(timer) }
    }, 'ds-bot: computer user active')
  }
  if (typeof appComputer?.onComputerAction === 'function') {
    appComputer.onComputerAction(({ kind, botId }) => {
      if (kind === 'stop') void actions.computerStop(botId)
      else if (kind === 'stopall') void actions.computerStop(null, true)
      else if (kind === 'letgo') void actions.computerAllowForeground(botId)
    })
  }
  const face = () => ({ actions, hooks: { roster, ui, activity, work, memoryNews, registry, turnClock, live, computer, cards, heldCards, browserPages, browserTabs, browserHolds, surface, update, frame, sidebarPref, settingsShellHeld, pages: pages.source } })
  // Since DSH 0.2.1-alpha.3 user text is drawn by rules and a content factory, not the
  // primitives' text projection; the user's bubble draws with either (user-message.js).
  const hostDrawsUserText = typeof ctx.uiConversation.userText?.register === 'function'
  ctx.effect(() => installCommandActions(ctx, { roster, actions }), 'ds-bot: bot command actions')
  // DS Bot holds the settings seat in every mode, Agent mode included: the bundle patch
  // turns DSH's own shell off, and this one draws DSH's settings pages in DS Bot's dialog.
  ctx.effect(() => {
    const offStyles = installCompiledStyles(SETTINGS_SHELL_CSS, 'settings-shell')
    settingsShell = installSettingsShell(ctx, { face, actions, ui, held: settingsShellHeld })
    return () => { settingsShell?.dispose(); settingsShell = null; offStyles() }
  }, 'ds-bot: settings shell')
  const queueFace = (sessionId) => ({
    ...face(),
    updateQueue: async (itemId, action) => (await ctx.sessions.binding(sessionId)?.session?.updateQueue(itemId, action)) ?? { ok: false },
    loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment),
  })
  ctx.effect(() => noticeApprovals({
    work,
    roster,
    shownSession: () => (Object.values(ctx.sessions.list.getSnapshot().byId ?? {}) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id,
    openSession: id => actions.openSession(id),
  }), 'ds-bot: approval notifications')
  const assistantFace = (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ds-bot: unknown session "${sessionId}"`)
    const chat = ctx.uiConversation.binding(binding).target('chat')
    return { ...face(), fileMentions: fileMentionSource(ctx, sessionId), keyedHooks: {
      turnSteps: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'assistant-step')
      },
      turnContext: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'context')
      },
    } }
  }

  actions.turnFacts = (sessionId) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return { turns: undefined, openTurn: undefined }
      const conversation = ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat').getSnapshot()
      return { turns: chat?.timeline?.turns, openTurn: conversation.openTurn.getSnapshot() }
    } catch {
      return { turns: undefined, openTurn: undefined }
    }
  }
  actions.watchTurns = (sessionId, listener) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return () => {}
      const conversation = ctx.uiConversation.binding(binding)
      const offChat = conversation.target('chat').subscribe(listener)
      const offOpen = conversation.openTurn.subscribe(listener)
      return () => { offChat(); offOpen() }
    } catch {
      return () => {}
    }
  }
  actions.steerQueued = async (sessionId) => {
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) return
    if (await steerQueued(session) === 'failed') {
      actions.reportError(new Error(t('Couldn’t steer the queued messages. Try again.')), 'steer-queue')
    }
  }
  actions.canOpenTerminal = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('terminal') !== undefined
  actions.newTerminal = () => {
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('terminal')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }
  actions.canOpenFiles = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('files') !== undefined
  actions.openFiles = () => {
    actions.closePanel()
    try {
      ctx.get('sidebarRight')?.openTab('files')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }

  // The drawer and DSH's right column never share the window: whichever the
  // user asked for last wins. The column's state is read off the frame's
  // attributes through a MutationObserver. `mounted` moves before the DOM of a
  // Session switch does, so a switch opens a timed window (createSwitchWindow):
  // an attribute batch inside it is the switch revealing that Session's own
  // column — the drawer wins and folds it back — while one outside it is the
  // user's own opening and takes the space.
  ctx.effect(() => {
    const sidebar = ctx.get('sidebarRight')
    if (!sidebar) return undefined
    let open = rightColumnOpen(document)
    // Long enough for a fullscreen panel's slide, which reports only once it ends.
    const switchWindow = createSwitchWindow(done => setTimeout(done, 400))
    const collapseColumn = () => {
      try {
        if (sidebar.isExpanded()) sidebar.toggleExpanded()
      } catch (error) {
        actions.reportError(error, 'right-sidebar')
      }
    }
    const observer = new MutationObserver(() => {
      const next = rightColumnOpen(document)
      const opening = next && !open
      open = next
      const verdict = opening ? columnOpened(ui.getSnapshot().details !== null, switchWindow.pending) : null
      if (verdict === 'close-drawer') actions.closePanel()
      else if (verdict === 'collapse-column') collapseColumn()
    })
    observer.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: RIGHTBAR_ATTRIBUTES,
    })
    const offMounted = sidebar.mounted.subscribe(() => switchWindow.moved())
    let drawer = ui.getSnapshot().details !== null
    const offUi = ui.subscribe(() => {
      const next = ui.getSnapshot().details !== null
      if (next && !drawer && drawerOpened(rightColumnOpen(document)) === 'collapse-column') collapseColumn()
      drawer = next
    })
    return () => { observer.disconnect(); offMounted(); offUi() }
  }, 'ds-bot: one right panel')

  // A Bot surface owns the cells it shadows. It starts far below the -10 that plugins
  // commonly use and goes below whatever already holds the cell, so a plugin that
  // shadows the same cell neither breaks the install nor shows through.
  const BOT_PRIORITY = -100
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name, ...options, ...(options.priority === undefined ? {} : { priority: freePriority(ctx.slots.entries(name), options) }),
  }, component))
  // ds-bot/board's page rides in this bundle (DSH loads one per package) and shows
  // only when that plugin's route answers. A card's note line in a chat shows as a tag
  // of the card (on releases that draw user text by rules), and so does a card a Bot names.
  ctx.effect(() => installBoardPage(pages.service, {
    cardTags: ({ rule, Node, botText }) => {
      const offLinks = textLinks.add(botText)
      if (!hostDrawsUserText) return offLinks
      const offRule = ctx.uiConversation.userText.register(rule)
      const offNode = shadow('conversation.user.text.node', { key: rule.id, inject: face }, Node)
      return () => { offNode(); offRule(); offLinks() }
    },
  } as any), 'ds-bot: board page')
  const installHeader = () => ctx.slots.inject('conversation.session.header', () => installHeaderNavigation(ctx.slots, face, HeaderPill, BOT_PRIORITY))

  let atMenu = null
  const installAtMenu = () => {
    const fiber = ctx.inject(['inputTriggers'], (scope) => {
      scope.effect(() => {
        const triggers = scope.inputTriggers
        const controllerOf = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          return binding === undefined ? undefined : triggers.sessionOf(binding.ctx)
        }
        const launched = sessionId => controllerOf(sessionId)?.launcher.getSnapshot() === CHATS_SOURCE
        const offs = [
          ...atSources({ roster, sessions: ctx.sessions, launched, iconFor: menuIcons(roster) }).map(source => triggers.registerSource(source)),
          triggers.registerSource(sideSource({ roster, actions })),
        ]
        atMenu = { controllerOf }
        return () => {
          atMenu = null
          for (const off of offs) off()
        }
      }, 'ds-bot: @ menu')
    })
    return () => fiber.dispose()
  }
  actions.canReferenceChat = () => atMenu !== null
  actions.referenceChat = (sessionId, span) => {
    const controller = atMenu?.controllerOf(sessionId)
    if (controller === undefined || span === undefined) return
    controller.toggleSource(CHATS_SOURCE, { trigger: '@', query: '', quoted: false, position: 'inline', span })
  }

  const installFrameSync = () => {
    let lastDetails = ui.getSnapshot().details
    const sync = () => {
      const s = ui.getSnapshot()
      const f = frame.getSnapshot()
      const opened = s.details !== null && lastDetails === null
      lastDetails = s.details
      const layout = frameLayout({ viewport: f.viewport, sidebarWidth: f.sidebarWidth, pref: sidebarPref.getSnapshot(), drawer: s.leftDrawer === true, panel: s.details === null ? null : { view: s.view, yielded: false } })
      if (s.details === null) {
        if (s.panelYield) actions.setPanelYield(false)
      } else if (!s.panelYield && opened && layout.panel === 'folded') actions.setPanelYield(true)
      else if (s.panelYield && layout.panel === 'shown') actions.setPanelYield(false)
      if (s.leftDrawer === true && layout.left !== 'drawer') actions.setLeftDrawer(false)
    }
    const offs = [ui.subscribe(sync), frame.subscribe(sync), sidebarPref.subscribe(sync)]
    return () => { for (const off of offs) off() }
  }

  const SHELL_SHEETS = [
    [SHELL_CSS, 'shell'],
    [SIDEBAR_CSS, 'sidebar'],
    [SECRET_CSS + CONNECTOR_CSS + CONNECTORS_PAGE_CSS, 'secrets'],
    [LEARNING_CSS, 'learning'],
    [MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + BOT_MODELS_CSS + AGENT_CARDS_CSS + GROUP_SETTINGS_CSS + AVATAR_LIBRARY_CSS, 'models'],
    [USAGE_CSS, 'usage'],
    [SCHEDULE_CSS, 'schedules'],
    [FEEDBACK_CSS, 'feedback'],
    [ABOUT_CSS, 'about'],
    [MEMBER_CSS, 'members'],
    [BOARD_CSS, 'board'],
    [CARD_TAG_CSS, 'board-card-tag'],
    [PASTE_CSS, 'paste'],
    [OPENING_CSS, 'opening'],
    [IM_CSS, 'im'],
    [USER_MESSAGE_CSS, 'user-messages'],
    [WIDGET_CSS, 'widgets'],
    [CHANGES_CSS, 'changes'],
    [HANDOFF_CSS, 'handoff'],
    [SIDE_CSS, 'side'],
    [BROWSER_CSS, 'browser'],
  ]
  let shellSheets = 0
  actions.holdSettingsLook = () => {
    if (shellSheets > 0) return () => {}
    const syncEffects = () => {
      const current = roster.getSnapshot()
      document.body.dataset.btEffects = effectsOf(current.ready ? current.prefs ?? {} : savedPrefs)
    }
    syncEffects()
    const snapshot = roster.getSnapshot()
    const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
    const themes = allThemes()
    const theme = themes[prefs.theme] ?? themes.deepseek
    const offs = [
      roster.subscribe(syncEffects),
      ...SHELL_SHEETS.map(([text, tag]) => installCompiledStyles(botOwnCss(text), `settings-${tag}`)),
      installCompiledStyles(botOwnCss(themeCss(theme, isHex(prefs.accent) ? prefs.accent : undefined)), 'settings-theme'),
    ]
    return () => {
      delete document.body.dataset.btEffects
      for (const off of offs) off()
    }
  }
  const installShell = () => [
    () => { shellSheets += 1; return () => { shellSheets -= 1 } },
    ...SHELL_SHEETS.map(([text, tag]) => () => installCompiledStyles(text, tag)),
    () => installFrameWatch(frame),
    () => installFrameSync(),
    () => installTheme(),
    () => shadow('sidebar.workspaces', { priority: BOT_PRIORITY, inject: face }, TeamSidebar),
    () => shadow('sidebar.brand.mark', { priority: BOT_PRIORITY }, BrandMark),
    () => shadow('sidebar.brand.name', { priority: BOT_PRIORITY }, BrandName),
    () => shadow('sidebar.footer.action', { id: 'bot-account', order: -200, inject: face }, FooterAccount),
    () => shadow('settings.trigger', { priority: BOT_PRIORITY }, YouAvatar),
    () => shadow('settings.launcher', { priority: BOT_PRIORITY, inject: face }, AccountLauncher),
    () => shadow('shell.overlay', { id: 'bot-computer', order: 40, inject: face }, ComputerIndicator),
    () => shadow('shell.overlay', { id: 'bot', order: 50, inject: face }, Overlays),
    () => shadow('shell.overlay', { id: 'bot-signin', order: 55, inject: face }, DeepSeekSignIn),
    () => shadow('shell.overlay', { id: 'bot-toast', order: 60, inject: face }, ErrorToast),
  ]
  const installConversation = () => [
    () => installCompiledStyles(CONVERSATION_CSS + READ_ONLY_CSS, 'conversation'),
    () => installCompiledStyles(TURN_ERROR_CSS, 'turn-errors'),
    () => installCompiledStyles(QUEUE_CSS, 'queue'),
    () => installCompiledStyles(ANNOTATION_CSS, 'text-annotation'),
    () => installMentions(),
    () => installAtMenu(),
    installHeader,
    () => shadow('conversation.chat.text-interaction', { key: 'quote', priority: BOT_PRIORITY, locale: 'messageQuotes', inject: face }, TextSelectionAction),
    () => shadow('conversation.chat.node', { key: 'assistant-step', priority: BOT_PRIORITY, locale: 'chat', inject: assistantFace }, AssistantCell),
    () => shadow('conversation.chat.node', { key: 'turn-trigger', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TriggerCell),
    () => shadow('conversation.chat.node', { key: 'tool-call', priority: BOT_PRIORITY, locale: 'chat', inject: face }, ToolCell),
    () => shadow('conversation.chat.node', { key: 'turn-process', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TurnProcessCell),
    () => shadow('conversation.chat.node', { key: 'turn-error', priority: BOT_PRIORITY, locale: 'chat', inject: face }, FailureCell),
    () => shadow('conversation.chat.turnTail', { id: 'bot-turn-separators', order: 1000, inject: face }, TurnTailCell),
    () => shadow('conversation.chat.turnTail', { id: 'bot-btw', order: 800, priority: BOT_PRIORITY, inject: face }, BtwTurnTail),
    () => shadow('conversation.chat.turnTail', { id: 'bot-learning', order: 850, priority: BOT_PRIORITY, inject: face }, LearningTurnTail),
    () => ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({ name: 'deliverables.file.actions', id: 'bot-file-save', locale: 'chat' }, SaveFileAction)),
    () => shadow('conversation.chat.node', { key: 'question-reply', priority: BOT_PRIORITY, locale: 'chat' }, AnsweredReply),
    () => shadow('conversation.chat.node', { key: 'compaction', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty),
    () => shadow('conversation.chat.node', { key: 'context', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty),
    ...(canDrawUserMessages(hostDrawsUserText) ? [() => installUserBubble(ctx.slots, () => {
      const offs = ['user', 'steering'].map(key => shadow('conversation.chat.node', { key, priority: BOT_PRIORITY, locale: 'chat', inject: face }, UserMessageCell))
      return () => { for (const off of offs) off() }
    })] : []),
    // DSH 0.2.2-rc.1 draws user text by rules, and its file rule cuts "@新 Bot" at the
    // space. A rule of ours claims a whole Bot name first; releases that still have the
    // text projection (above) have no such registry.
    ...(typeof ctx.uiConversation.userText?.register === 'function' ? [
      () => installBotMentionRule(ctx.uiConversation.userText, roster),
      () => shadow('conversation.user.text.node', { key: BOT_MENTION_ID, inject: face }, BotMention),
    ] : []),
    () => shadow('conversation.input.permission', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.input.plan', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.input.model', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'activity', order: 0, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'usage', order: 1, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'btw', order: 2, priority: BOT_PRIORITY, inject: face }, BtwDock),
    () => shadow('conversation.input.left', { id: 'bot-paste', order: -110, inject: face }, PasteGuard),
    () => shadow('conversation.input.left', { id: 'bot-plus', order: -100, inject: face }, ComposerPlus),
    () => shadow('conversation.input.right', { id: 'bot-voice', order: 100, inject: face }, ComposerVoice),
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY,
      select: owner => (owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null),
    }, QuestionCard),
    () => shadow('conversation.input.dock', { id: 'bot-paste', order: -130, inject: face }, PasteDock),
    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),
    () => shadow('conversation.input.dock', { id: 'bot-model', order: -110, inject: face }, ModelChoiceDock),
    () => shadow('conversation.input.dock', { id: 'bot-readonly', order: -105, inject: face }, ReadOnlyDock),
    () => shadow('conversation.input.dock', { id: 'bot-question', order: -100, inject: face }, QuestionDock),
    () => shadow('conversation.input.dock', { id: 'bot-view', order: -95, inject: face }, WidgetDock),
    () => shadow('conversation.input.dock', { id: 'bot-secret', order: -90, inject: face }, SecretDock),
    () => shadow('conversation.input.dock', { id: 'bot-connector', order: -89, inject: face }, ConnectorDock),
    () => shadow('conversation.input.dock', { id: 'bot-mail', order: -88, inject: face }, MailDock),
    () => shadow('conversation.input.dock', { id: 'bot-handoff', order: -85, inject: face }, HandoffDock),
    () => shadow('conversation.input.dock', { id: 'bot-computer-handoff', order: -84, inject: face }, ComputerHandoffDock),
    () => shadow('conversation.input.dock', { id: 'bot-computer-app', order: -83, inject: face }, AppAccessDock),
    () => shadow('conversation.input.dock', { id: 'bot-learning', order: 850, priority: BOT_PRIORITY, inject: face }, LearningDock),
    // The shell's own queue dock lists every queued inbox row as the user's
    // drafts — including the team's relayed mail. Reusing its id puts ours in
    // its cell; it lists only the sends the user authored (#663).
    () => shadow('conversation.input.dock', { id: 'queue', order: 20, priority: BOT_PRIORITY, inject: queueFace }, QueueDock),
  ]
  ctx.effect(() => installCompiledStyles(RETURN_TOKENS + RETURN_CSS, 'return'), 'ds-bot: return styles')
  ctx.effect(() => installCompiledStyles(COMPUTER_CSS, 'computer'), 'ds-bot: computer styles')
  shadow('sidebar.footer.action', { id: 'bot-return', order: -300, inject: face }, BotReturn)

  ctx.effect(() => {
    let previous
    const sync = () => {
      const list = ctx.sessions.list.getSnapshot()
      const main = (Object.values(list.byId ?? {}) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      const plain = isAgentSessionId(main)
      setPlain(plain)
      if (plain) dropPanels()
      if (main === previous) return
      const before = previous
      previous = main
      const ours = expected !== null && main === expected
      expected = null
      if (ours || main === undefined) return
      if (surface.getSnapshot().mode !== 'bot') return
      const agentId = before !== undefined ? agentOfSession(before) : undefined
      if (agentId === undefined) return
      const snapshot = roster.getSnapshot()
      if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined || agentOfSession(main) !== undefined) return
      const row = list.byId[main]
      // A subagent child reports the Agent Session as its parent, but adopting it
      // would steal it from subagent routing — the Host refuses anyway, so skip.
      if (row?.origin === 'subagent') return
      // The client list maps the fork's parent to `parentId`; the raw field is
      // the fallback for shapes that skip the mapping.
      const parent = row?.parentId ?? row?.parentSessionId
      const forkedFromAgent = parent !== undefined && agentOfSession(parent) === agentId
      if (row?.blank !== true && !forkedFromAgent) return
      pendingAdopt.set(main, agentId)
      setPlain(true)
      void call('agent-adopt', { agentId, sessionId: main }).then(() => pull()).catch((error) => {
        pendingAdopt.delete(main)
        console.warn('[ds-bot] agent-adopt', error)
        sync()
        actions.reportError(error, 'agent-adopt')
      })
      const next = workspaceOf(main)
      if (list.byId[before]?.blank === true && next !== undefined && workspaceOf(before) !== next) {
        void call('agent-archive', { agentId, sessionId: before }).then(() => pull()).catch(() => {})
      }
    }
    const offList = ctx.sessions.list.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    sync()
    return () => { offList(); offRoster() }
  }, 'ds-bot: agent surface')

  ctx.effect(() => {
    const groups = surfaceGroups({ shell: installShell, conversation: installConversation }, {
      onError: (_group, error) => actions.reportError(new Error(t('Bot mode could not be set up here: {error}', { error: error?.message ?? String(error) })), 'surface'),
    })
    // A shadow step can mount "successfully" with nothing registered: when a
    // slot's inject callback throws inside the host, the host cancels the
    // declaration's subscription but the step's disposer still counts the group
    // as mounted. After the shell goes on, check that its sidebar entry really
    // landed; remount a few times when it did not (cold start race).
    let verifyTimer: ReturnType<typeof setTimeout> | number = 0
    let verifyAttempts = 0
    const verifySidebar = () => {
      if (!groupsFor(surface.getSnapshot()).shell) return
      let landed = false
      let declared = true
      try {
        landed = ctx.slots.entries('sidebar.workspaces').some(entry => entry.component === TeamSidebar)
        declared = ctx.slots.spec?.('sidebar.workspaces') !== undefined
      } catch {
        declared = false
      }
      if (landed) return
      if (!declared) {
        if (verifyAttempts < 20) {
          verifyAttempts += 1
          verifyTimer = setTimeout(verifySidebar, 250)
        }
        return
      }
      if (verifyAttempts >= 3) return
      verifyAttempts += 1
      console.warn('[ds-bot] sidebar entry missing after shell mount; remounting')
      groups.remount('shell')
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    const reconcile = () => {
      groups.reconcile(groupsFor(surface.getSnapshot()))
      clearTimeout(verifyTimer)
      verifyAttempts = 0
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    reconcile()
    if (surface.getSnapshot().mode === 'bot') ensureBotHome()
    const unsub = surface.subscribe(reconcile)
    return () => {
      unsub()
      clearTimeout(verifyTimer)
      groups.dispose()
    }
  }, 'ds-bot: surface')
}
