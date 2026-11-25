import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, session, shell as electronShell, systemPreferences, Tray, WebContentsView } from 'electron'
import { createComputerIndicator, indicatorHtml } from './computer-indicator.mjs'
import { createComputerCursor } from './computer-cursor.mjs'
import { badgeCount, createNotifications } from './notifications.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { canonicalExecPath } from './canonical-path.mjs'
import { disk } from './copy-tree.mjs'
import { configureIdentity } from './legacy.mjs'
import { hostPort } from './host-port.mjs'
import { captureStdio, LogFile } from './logs.mjs'
import { Pickers } from './picker-host.mjs'
import { currentRootOf, driveOf, formatBytes, freeSpace, isEmptyTree, pickFrom, placeOf, rootOf, runningLow } from './place.mjs'
import { createShell, SHELL_TEXT } from './shell.mjs'
import { readStartFrame, writeStartFrame } from './start-frame.mjs'
import { explainOf, StartWindow } from './start-window.mjs'
import { createDeferredPrompt } from './update-prompt.mjs'
import { CAPTION_HEIGHT, cssColor, frameOptions, framelessOn, keepVibrancy, materialOf, nativeThemeSource } from './window-frame.mjs'

const { rm } = disk.promises

const IPC = {
  caption: 'ds-bot:caption-colors', nativeTheme: 'ds-bot:native-theme', fullscreen: 'ds-bot:fullscreen',
  dataLocation: 'ds-bot:data-location', moveData: 'ds-bot:move-data', teamWorkspace: 'ds-bot:team-workspace',
  ready: 'ds-bot:ready', handoffReady: 'ds-bot:handoff-ready', motion: 'ds-bot:motion', effects: 'ds-bot:effects',
  card: 'ds-bot:app-card', cardShown: 'ds-bot:app-card-shown', cardAnswer: 'ds-bot:app-card-answer',
  browserAcquire: 'ds-bot:browser-acquire', browserRelease: 'ds-bot:browser-release', browserForget: 'ds-bot:browser-forget',
  browserViewChanged: 'ds-bot:browser-view-changed', browserViewCreate: 'ds-bot:browser-view-create',
  browserViewSync: 'ds-bot:browser-view-sync', browserViewPlace: 'ds-bot:browser-view-place',
  browserViewNavigate: 'ds-bot:browser-view-navigate', browserViewCommand: 'ds-bot:browser-view-command',
  browserViewFocus: 'ds-bot:browser-view-focus', browserViewRead: 'ds-bot:browser-view-read',
  browserViewClose: 'ds-bot:browser-view-close', browserViewHold: 'ds-bot:browser-view-hold',
  browserImportSources: 'ds-bot:browser-import-sources', browserImportPick: 'ds-bot:browser-import-pick',
  browserImportLive: 'ds-bot:browser-import-live', browserImportApply: 'ds-bot:browser-import-apply',
  browserImportCancel: 'ds-bot:browser-import-cancel',
  appUpdateState: 'ds-bot:app-update-state', appUpdateCheck: 'ds-bot:app-update-check',
  appUpdateInstall: 'ds-bot:app-update-install', appUpdateOpen: 'ds-bot:app-update-open',
  appUpdateChanged: 'ds-bot:app-update-changed',
  idleSeconds: 'ds-bot:idle-seconds', computer: 'ds-bot:computer', computerAction: 'ds-bot:computer-action', computerCursor: 'ds-bot:computer-cursor',
  notify: 'ds-bot:notify', notifyStatus: 'ds-bot:notify-status', badge: 'ds-bot:badge', openSession: 'ds-bot:open-session',
}
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const MOVE_PROBLEMS = { drive: 'dialog.move.drive', nested: 'dialog.move.nested', workspace: 'dialog.move.workspace', program: 'dialog.move.inProgram', notEmpty: 'dialog.move.notEmpty' }
const MOVE_REASONS = { drive: 'drive', nested: 'nested', workspace: 'workspace', dsh: 'dsh', program: 'program', notEmpty: 'foreign' }
const CARD_SHOWN_MS = 2000
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000
const SHORT_DRIVE_BYTES = 5e9

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
const iconFile = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
const trayIconFile = () => join(assets, process.platform === 'win32' ? 'tray.ico' : process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
const material = materialOf(process.platform, release())
configureIdentity(app)
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)
const frameFile = join(app.getPath('userData'), 'start-frame.json')

let BotBrowserGuests, partitionOf, BotViews, isBotId, importFromBrowser, listSources, applyCookies, CookieImports, parseCookieFile
let downloadSaver, chooseLocations, defaultPlaces, pickerLabels, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx, HostProcess
let copySessions, findTeam, importTeam, restoreSessions, teamInUse, teamSizes, userDshHome, copyData, copyReason, moveProblem, BUNDLES, CHECK_PROFILE, PROFILE, ImportFlow
let watchReleases, watchUpdates, RELEASE_PAGE, getDshRuntimeVersion, electronUpdater

let mainWindow
let mainCreated
let startWindow
let logs
let rawOutput
let host
let origin
let port
let hostStop
let updates
let updatesStarted = false
let stopping = false
let stopped = false
let failed = false
let places
let made = { dataDir: false, workspace: false, root: false }
let shadowedAsked = false
let picking = false
let proposed
let moveTo
let answering
let asked
let offered
let restarting = false
let importOffer
let importFlow
let attempt = 0
let bootAbort = new AbortController()
let hostReady = false
let launchUrl
let bootstrap
let tokenSpent = false
let downloadsBound = false
let copying
const copyAbort = new AbortController()
let browserGuests
let botViews
let cookieImports
const pickers = new Pickers({ ipcMain, getPath: name => app.getPath(name) })

const shell = createShell({
  electron: { app, Menu, Tray, powerMonitor },
  platform: process.platform,
  messages: () => shellText(),
  trayImage: () => trayImage(),
  window: () => mainWindow,
  build: () => rebuildWindow(),
  reveal: (target) => {
    if (startWindow?.focus() || failed) return
    // macOS: the application menu's Hide hides the app itself, so it comes back first.
    if (process.platform === 'darwin') app.show()
    target.show()
    target.focus()
  },
  quit: () => { app.quit() },
  computer: (kind, botId) => { mainWindow?.webContents.send(IPC.computerAction, { kind, botId }) },
  busy: () => copying !== undefined,
  ready: () => places !== undefined && origin !== undefined && bootstrap !== undefined,
  notice: { marker: () => join(app.getPath('userData'), 'tray-close-acknowledged'), show: options => boxInWindow(options, 0), focus: () => { toFront(mainWindow) } },
  fallback: { show: options => boxInWindow(options, options.cancelId) },
})
app.once('will-quit', () => { shell.dispose(); botViews?.dispose(); updates?.stop() })

const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  logs = new LogFile({ dir: join(app.getPath('userData'), 'logs') })
  rawOutput = captureStdio(logs)
  app.once('will-quit', () => { logs.flush() })
  console.log(`DS Bot ${app.getVersion()} (${process.platform} ${process.arch}), Electron ${process.versions.electron}`)
  startWindow = new StartWindow({
    electron: { BrowserWindow, ipcMain, screen, shell: electronShell, clipboard, nativeTheme, systemPreferences },
    saveAs: (win, name) => askPicker(win, { mode: 'save', title: tx('dialog.saveLog'), start: knownFolder('desktop'), name }),
    page: join(here, 'start', 'start.html'), preload: join(here, 'preload.cjs'), icon: iconFile, material, devTools: !app.isPackaged,
    css: readFileSync(join(here, 'page-card.css'), 'utf8'),
    motion: readStartFrame(frameFile).motion, effects: readStartFrame(frameFile).effects,
    version: app.getVersion(), program: [dirname(process.execPath), process.resourcesPath, app.getAppPath()], log: logs, mainWindow: () => mainWindow,
    onRetry: () => { retry().catch(fail) },
    onReload: () => { mainWindow?.webContents.reload() },
    onClose: () => { app.quit() },
    onPick: () => {
      if (asked === 'shadowed') return
      if (answering !== undefined && ['import', 'importSpace', 'rejected', 'picked'].includes(asked)) { answering('pick'); return }
      (startWindow.kind === 'later' ? moveFromStart() : changePlace()).catch(fail)
    },
    onAnswer: (value) => {
      if (answering !== undefined) { answering(value); return }
      (startWindow.kind === 'later' ? moveAnswer(value) : placeAnswer(value)).catch(fail)
    },
    onUpdate: (name) => { updateAct(name) },
    onImport: (name, value) => { importFlow?.act(name, value) },
  })
  app.on('second-instance', () => { if (!startWindow.focus()) shell.open() })
  process.on('uncaughtException', (error) => {
    if (startWindow.revealed) console.error(error)
    else void fail(error)
  })
  app.on('before-quit', (event) => {
    if (copying !== undefined) {
      event.preventDefault()
      shell.cancelQuit()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    shell.beginQuit()
    if (stopped || host === undefined) return
    event.preventDefault()
    if (stopping) { void (hostStop ?? Promise.resolve()).then(() => { app.quit() }); return }
    void stopHost().then(() => { app.quit() })
  })
  app.whenReady().then(async () => { shell.install(); await start() }).catch(fail)
}

function stopHost() {
  stopping = true
  hostStop ??= (host?.stop() ?? Promise.resolve()).catch((error) => { console.error(error) }).finally(() => { stopped = true })
  return hostStop
}

const startKind = () => (process.env.DS_BOT_HOME || existsSync(join(app.getPath('userData'), 'locations.json')) ? 'later' : 'first')

async function start() {
  setMenu()
  nativeTheme.themeSource = readStartFrame(frameFile).themeSource
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  await prepare()
  run()
}

async function prepare() {
  if (port === undefined) {
    port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
    origin = `http://127.0.0.1:${String(port)}`
  }
  startWindow.open(startKind())
  if (browserGuests === undefined) {
    await loadModules()
    handleIpc()
  }
  if (mainCreated === undefined || (await mainCreated, mainWindow === undefined)) mainCreated = startWindow.painted.then(createWindow)
}

async function loadModules() {
  const [browser, views, sources, cookies, cookieFiles, downloads, firstRun, hostProcess, imports, flows, moves, profile, updatesModule, boot, updater] = await Promise.all([
    import('./bot-browser.mjs'), import('./bot-views.mjs'), import('./browser-sources.mjs'), import('./cookie-import.mjs'),
    import('./cookie-parse.mjs'), import('./downloads.mjs'), import('./first-run.mjs'), import('./host-process.mjs'),
    import('./import.mjs'), import('./import-flow.mjs'), import('./move-data.mjs'), import('./profile.mjs'), import('./updates.mjs'),
    import('@deepseek-ai/dsh-app-boot'), import('electron-updater'),
  ])
  ;({ BotBrowserGuests, partitionOf } = browser)
  ;({ BotViews, isBotId } = views)
  ;({ importFromBrowser, listSources } = sources)
  ;({ applyCookies, CookieImports } = cookies)
  ;({ parseCookieFile } = cookieFiles)
  ;({ downloadSaver } = downloads)
  ;({ chooseLocations, defaultPlaces, pickerLabels, pickRoot, programFolder, saveLocations, teamIn, teamsAt, tx } = firstRun)
  ;({ HostProcess } = hostProcess)
  ;({ copySessions, findTeam, importTeam, restoreSessions, teamInUse, teamSizes, userDshHome } = imports)
  ;({ ImportFlow } = flows)
  ;({ copyData, copyReason, moveProblem } = moves)
  ;({ BUNDLES, CHECK_PROFILE, PROFILE } = profile)
  ;({ watchReleases, watchUpdates, RELEASE_PAGE } = updatesModule)
  ;({ getDshRuntimeVersion } = boot)
  electronUpdater = updater.default
  browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
  botViews = new BotViews({
    window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
    statePath: join(app.getPath('userData'), 'bot-views.json'),
    onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
  })
  cookieImports = new CookieImports()
}

function run() {
  bootAbort = new AbortController()
  const mine = (attempt += 1)
  boot(mine).catch((error) => { if (mine === attempt) void fail(error) })
}

async function retry() {
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    await copying?.catch(() => {})
    if (copyAbort.signal.aborted || stopping || mine !== attempt) return
    await stopOld()
    if (stopping || mine !== attempt) return
    await prepare()
  } finally {
    restarting = false
  }
  if (!stopping && mine === attempt) run()
}

function forgetHost() {
  hostReady = false
  bootstrap = undefined
}

async function stopOld(options) {
  const old = host
  if (old === undefined) return
  await old.stop(options).catch((error) => { console.error(error) })
  if (host === old) host = undefined
}

const ui = () => ({ owner: () => startWindow.owner(), asking: answer => startWindow.asking(answer), pick: request => askPicker(startWindow.owner(), request) })

function askCard(card, { signal, settle } = {}) {
  answering?.(undefined)
  return new Promise((resolve) => {
    const done = (value) => {
      if (answering !== done) return
      answering = undefined
      asked = undefined
      signal?.removeEventListener('abort', gone)
      resolve(value)
    }
    const gone = () => { done(undefined) }
    answering = done
    asked = card.kind
    if (signal?.aborted || !startWindow.card(card)) { gone(); return }
    signal?.addEventListener('abort', gone, { once: true })
    void settle?.then(() => { done('settled') }, gone)
  })
}

async function until(check, signal) {
  while (!signal.aborted && !check()) await sleep(2000, undefined, { signal }).catch(() => {})
  if (signal.aborted) await new Promise(() => {})
}

async function boot(mine) {
  if (places === undefined) {
    const first = startWindow.kind === 'first'
    if (first) {
      const teams = teamsAt()
      startWindow.explain(explainOf(teams))
      if (teams.team === undefined) tellPlace(defaultPlaces().dataDir)
    }
    const where = chooseLocations()
    setPlaces({ dataDir: where.dataDir, workspace: where.workspace })
    importOffer = where.offer
    if (first) startWindow.explain(explainOf({ offered: importOffer !== undefined, team: teamIn(where.dataDir) }))
    else tellLowSpace(where.freeAtStart)
  }
  mkdirSync(profileDir(), { recursive: true })
  startWindow.done('data')
  const engine = await startEngine(mine)
  if (engine === undefined || mine !== attempt) return
  startWindow.done('engine')
  await mainCreated
  if (mine !== attempt || mainWindow === undefined) return
  startWindow.teamLoading()
  const win = mainWindow
  launchUrl = engine.url
  tokenSpent = true
  hostReady = false
  bootstrap = win.loadURL(engine.url).then(() => {
    if (mine === attempt) hostReady = true
    return true
  }).catch(() => false)
}

function setPlaces(next) {
  places = next
  const root = currentRootOf(places.dataDir, places.workspace)
  made = { dataDir: !existsSync(places.dataDir), workspace: places.workspace !== undefined && !existsSync(places.workspace), root: root !== undefined && !existsSync(root) }
}

function tellPlace(dataDir) {
  const free = freeSpace(dataDir)
  const drive = driveOf(dataDir)
  const short = drive !== undefined && free !== undefined && free < SHORT_DRIVE_BYTES
  startWindow.place(short ? placeOf(dataDir, { free }) : undefined)
  startWindow.hint(short ? { drive, free: formatBytes(free) } : undefined)
}

function tellLowSpace(freeAtStart) {
  if (process.env.DS_BOT_HOME) return
  if (freeAtStart === undefined) {
    try {
      saveLocations(places)
    } catch (error) {
      console.error(error)
    }
    return
  }
  const free = freeSpace(places.dataDir)
  if (runningLow(free, freeAtStart)) startWindow.place(placeOf(places.dataDir, { free }))
}

async function changePlace() {
  if (startWindow.kind !== 'first' || places === undefined || copying !== undefined || picking || restarting || stopping || failed) return
  picking = true
  try {
    await startWindow.asking(pickAndPlace())
  } finally {
    picking = false
  }
}

async function pickAndPlace() {
  const picked = await pickRoot(pickFrom(places.dataDir), copyAbort.signal, ui())
  if (stopping || startWindow.owner() === undefined) return
  const root = picked === undefined ? { same: true } : rootOf(picked, { dshHome: userDshHome(), program: app.isPackaged ? programFolder() : undefined, current: places })
  if (root.same) {
    proposed = undefined
    startWindow.card(undefined)
    return
  }
  if (root.reason !== undefined) {
    console.log(`DS Bot: the place ${root.at} cannot be used (${root.reason})`)
    proposed = undefined
    startWindow.card({ kind: 'rejected', reason: root.reason, path: root.at })
    return
  }
  if (root.added) {
    proposed = root
    startWindow.card({ kind: 'picked', path: root.root })
    return
  }
  await startOver(root)
}

async function placeAnswer(value) {
  if (value !== 'use' || proposed === undefined || picking || restarting) return
  const root = proposed
  proposed = undefined
  await startOver(root)
}

async function startOver(root) {
  bootAbort.abort()
  const mine = (attempt += 1)
  forgetHost()
  failed = false
  proposed = undefined
  restarting = true
  try {
    startWindow.restart()
    tellPlace(root.dataDir)
    await stopOld({ now: true })
    if (stopping || mine !== attempt) return
    await removeMade()
    if (stopping || mine !== attempt) return
    setPlaces({ dataDir: root.dataDir, workspace: root.workspace })
    saveLocations(places)
    console.log(`DS Bot: the data goes to ${places.dataDir}`)
  } finally {
    restarting = false
  }
  run()
}

async function removeMade() {
  const gone = []
  if (made.dataDir && existsSync(places.dataDir)) gone.push(places.dataDir)
  if (made.workspace && existsSync(places.workspace) && isEmptyTree(places.workspace)) gone.push(places.workspace)
  for (const folder of gone) await rm(folder, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  const root = currentRootOf(places.dataDir, places.workspace)
  if (made.root && root !== undefined && existsSync(root) && isEmptyTree(root)) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
}

const profileDir = () => join(places.dataDir, 'profiles', PROFILE)
const pnpmEntry = () => join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const runtimeDir = () => app.isPackaged ? process.resourcesPath : join(here, '..', 'build', 'runtime')
const hostOutput = (stream, chunk) => {
  logs.write('engine', chunk)
  rawOutput[stream](chunk)
}

function newHost() {
  const mine = attempt
  return new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir(),
    env: { ...process.env, DSH_HOME: places.dataDir, DS_BOT_PORT: String(port), DS_BOT_APP: '1', DS_BOT_USER_DSH_HOME: userDshHome(), DS_BOT_RUNTIME_DIR: runtimeDir(), ...(app.isPackaged && process.platform === 'darwin' ? { DS_BOT_COMPUTER_HELPER_HOME: join(app.getPath('userData'), 'computer-use') } : {}), ...(places.workspace ? { DS_BOT_WORKSPACE: places.workspace } : {}) },
    pnpm: pnpmEntry(),
    onFailure: (error) => { if (mine === attempt) void fail(error) },
    output: hostOutput,
  })
}

function newCheck(home, list) {
  const cwd = join(home, 'profiles', CHECK_PROFILE)
  mkdirSync(cwd, { recursive: true })
  return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list, DS_BOT_RUNTIME_DIR: runtimeDir() }, pnpm: pnpmEntry(), onFailure: () => {}, output: hostOutput })
}

async function startEngine(mine) {
  let warm
  if (importOffer !== undefined) {
    const imported = await importStep(mine)
    if (imported === undefined || mine !== attempt) return undefined
    warm = imported.warm
  }
  if (!updatesStarted) {
    updatesStarted = true
    updates = startUpdates()
    updates?.subscribe((state) => { mainWindow?.webContents.send(IPC.appUpdateChanged, state) })

  }
  if (warm === undefined) {
    await restoreSessions(places.dataDir).then(({ copied, newer }) => {
      if (copied.length > 0) console.log(`DS Bot: copied ${copied.join(', ')}, which the import left out`)
      if (newer.length > 0) console.warn(`DS Bot: this DSH cannot read ${newer.join(', ')}, which the import left out`)
    }, (error) => { console.error('DS Bot: the Sessions the import left out were not copied:', error) })
  }
  if (!shadowedAsked) {
    const { shadowedBundles, removeShadowed } = await import('./profile-shadow.mjs')
    const shadowed = shadowedBundles(profileDir(), BUNDLES)
    if (shadowed.length > 0 && mine === attempt) {
      const names = shadowed.map(({ name, version }) => `${name} ${version}`).join(', ')
      console.warn(`DS Bot: the profile carries its own ${names}, which shadows the bundled copy`)
      if (await askCard({ kind: 'shadowed', names }) === 'remove' && mine === attempt) {
        await removeShadowed(profileDir(), shadowed.map(entry => entry.name)).catch((error) => {
          throw new Error(`Could not remove ${names} from the profile: ${error?.message ?? error}`, { cause: error })
        })
      }
    }
    shadowedAsked = true
  }
  host = warm?.host ?? newHost()
  host.onMessage(message => {
    if (message?.type !== 'ds-bot:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
    const downloadRoots = message.downloadRoots
    if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
      return
    }
    void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, url })
    }).catch(() => host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
  })
  const engine = await (warm?.up ?? host.start())
  if (mine === attempt) startWindow.card(undefined)
  return engine
}

async function importStep(mine) {
  const offer = importOffer
  const where = { ...places }
  const signal = AbortSignal.any([copyAbort.signal, bootAbort.signal])
  const warm = newHost()
  host = warm
  let warmStopped = false
  const up = warm.start()
  up.then(() => { if (mine === attempt && !warmStopped) startWindow.done('engine') }, () => {})
  const sizes = await teamSizes(offer.from, offer.team).catch((error) => { console.error(error); return { sessions: 0 } })
  let result
  for (;;) {
    if (signal.aborted || mine !== attempt) return undefined
    const flow = new ImportFlow({
      offer: { from: offer.from, bots: offer.bots, rooms: offer.rooms, names: botNames(offer.team), sessions: sizes.sessions, sizes, profiles: offer.profiles },
      ask: (card, options) => askCard(card, { signal, ...options }),
      show: (card) => { startWindow.card(card) },
      room: () => ({ free: freeSpace(where.dataDir), drive: driveOf(where.dataDir) }),
      inUse: () => teamInUse(offer.from),
      until,
      check: (checkSignal, onProgress) => checkTeam(where, checkSignal, onProgress),
      warmed: async () => {
        await up
        warmStopped = true
        await warm.stop()
        if (host === warm) host = undefined
        if (mine === attempt) startWindow.engineDown()
      },
      copy: options => importTeam({ from: offer.from, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), ...options }),
      reasonOf: copyReason,
      progress: setProgress,
      signal,
    })
    importFlow = flow
    copying = startWindow.asking(flow.run())
    try {
      result = await copying
    } finally {
      copying = undefined
      importFlow = undefined
    }
    if (result.outcome !== 'pick') break
    if (await importElsewhere(signal)) return undefined
  }
  if (result.outcome === 'gone' || signal.aborted || mine !== attempt) return undefined
  importOffer = undefined
  saveLocations(where)
  if (result.outcome === 'copied') {
    startWindow.done('import')
    const { summary } = result
    console.log(`DS Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
    startWindow.place(undefined)
    return {}
  }
  startWindow.card(undefined)
  return { warm: warmStopped ? undefined : { host: warm, up } }
}

const botNames = team => Object.values(team.bots ?? {}).map(bot => bot?.name).filter(name => typeof name === 'string' && name !== '')

async function importElsewhere(signal) {
  for (;;) {
    const picked = await pickRoot(pickFrom(places.dataDir), signal, ui())
    if (signal.aborted || picked === undefined) return false
    const root = rootOf(picked, { dshHome: userDshHome(), program: app.isPackaged ? programFolder() : undefined, current: places })
    if (root.same) return false
    if (root.reason !== undefined) {
      console.log(`DS Bot: the place ${root.at} cannot be used (${root.reason})`)
      if (await askCard({ kind: 'rejected', reason: root.reason, path: root.at }, { signal }) === 'pick') continue
      return false
    }
    if (root.added) {
      const answer = await askCard({ kind: 'picked', path: root.root }, { signal })
      if (answer === 'pick') continue
      if (answer !== 'use') return false
    }
    await startOver(root)
    return true
  }
}

function handleIpc() {

  const fixed = Boolean(process.env.DS_BOT_HOME)
  const computerIndicator = createComputerIndicator({
    BrowserWindow, screen, html: indicatorHtml, ipcMain,
    preload: join(here, 'computer-indicator-preload.cjs'),
    onAction: (kind, botId) => { mainWindow?.webContents.send(IPC.computerAction, { kind, botId }) },
    log: logs,
  })
  ipcMain.on(IPC.computer, (event, entries) => {
    if (!fromWindow(event)) return
    const list = Array.isArray(entries?.rows) ? entries.rows.filter(entry => entry && typeof entry.label === 'string').slice(0, 12) : []
    const labels = entries?.labels ?? {}
    computerIndicator.update({ rows: list, labels })
    shell.setComputer(list)
  })
  ipcMain.handle(IPC.idleSeconds, (event) => (fromWindow(event) ? powerMonitor.getSystemIdleTime() : 0))
  const notifications = createNotifications({ Notification, systemPreferences, platform: process.platform, log: logs })
  ipcMain.handle(IPC.notifyStatus, (event) => (fromWindow(event) ? notifications.status() : 'unsupported'))
  ipcMain.handle(IPC.notify, (event, notice) => {
    if (!fromWindow(event)) return false
    const sessionId = typeof notice?.sessionId === 'string' ? notice.sessionId : undefined
    return notifications.show({ title: String(notice?.title ?? ''), body: String(notice?.body ?? '') }, {
      open: () => {
        toFront(mainWindow)
        mainWindow?.webContents.send(IPC.openSession, sessionId)
      },
    })
  })
  ipcMain.on(IPC.badge, (event, count) => {
    if (!fromWindow(event)) return
    try { app.setBadgeCount(process.platform === 'darwin' || process.platform === 'linux' ? badgeCount(count) : 0) } catch { /* no dock here */ }
  })
  app.on('browser-window-focus', () => notifications.clear())
  const computerCursor = createComputerCursor({ BrowserWindow, screen, platform: process.platform, log: logs })
  ipcMain.on(IPC.computerCursor, (event, entry) => {
    if (!fromWindow(event)) return
    void computerCursor.update(entry)
  })
  app.on('before-quit', () => { computerIndicator.dispose(); computerCursor.dispose() })
  ipcMain.on(IPC.ready, (event, report) => { if (fromWindow(event)) startWindow.ready(report) })
  ipcMain.on(IPC.handoffReady, (event) => { if (fromWindow(event)) startWindow.teamReady() })
  ipcMain.on(IPC.cardShown, (event, id) => { if (fromWindow(event)) cards.get(id)?.shown() })
  ipcMain.on(IPC.cardAnswer, (event, id, index) => { if (fromWindow(event)) cards.get(id)?.settle(Number.isInteger(index) ? index : -1) })
  ipcMain.on(IPC.nativeTheme, (event, source) => {
    const value = nativeThemeSource(source)
    if (!fromWindow(event) || value === undefined) return
    nativeTheme.themeSource = value
    writeStartFrame(frameFile, { themeSource: value })
  })
  ipcMain.on(IPC.motion, (event, tier) => { if (fromWindow(event)) writeStartFrame(frameFile, { motion: tier }) })
  ipcMain.on(IPC.effects, (event, tier) => { if (fromWindow(event)) writeStartFrame(frameFile, { effects: tier }) })
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    const picked = await askPicker(mainWindow, { mode: 'file', title: tx('dialog.pickCookies'), start: knownFolder('downloads') })
    if (picked === undefined) return { canceled: true }
    const buffer = await readFile(picked)
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(picked) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('DS Bot: an unknown browser profile')
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error('DS Bot: a Bot storage key is required')
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error('DS Bot: this import is no longer pending')
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await updates.install()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
    const state = updates?.state()
    if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
      void electronShell.openExternal(state.page)
    }
  })
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
  })
  if (process.platform === 'win32') {
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }
}

const owner = () => startWindow.owner() ?? mainWindow
const setProgress = (value) => { owner()?.setProgressBar(value) }

async function checkTeam(where, signal, onProgress) {
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(importOffer?.from ?? userDshHome())
    const ids = found === undefined ? [] : await copySessions(found.from, found.team, home, signal, onProgress)
    if (ids.length === 0) return 0
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(ids))
    const check = newCheck(home, list)
    const stop = () => { void check.stop() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const { unreadable } = await check.start()
      if (unreadable.length > 0) console.warn(`DS Bot: this DSH cannot read ${unreadable.join(', ')}`)
      return unreadable.length
    } finally {
      signal.removeEventListener('abort', stop)
      await check.stop()
    }
  } catch (error) {
    if (!signal.aborted) console.error('DS Bot: the chats were not checked before the copy:', error)
    return 0
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

async function moveData(workspace) {
  if (copying !== undefined || stopping || mainWindow === undefined) return false
  const to = await askMove(workspace)
  if (to === undefined) return false
  await runMove(to, workspace)
  return true
}

async function moveFromStart() {
  if (startWindow.kind !== 'later' || places === undefined || copying !== undefined || picking || restarting || stopping || failed) return
  picking = true
  try {
    await startWindow.asking(pickMove())
  } finally {
    picking = false
  }
}

async function pickMove() {
  const picked = await askPicker(owner(), { mode: 'folder', title: tx('dialog.pickMove'), start: dirname(places.dataDir) })
  if (stopping || startWindow.owner() === undefined) return
  moveTo = undefined
  if (picked === undefined) {
    startWindow.card(undefined)
    return
  }
  moveCard(resolve(picked))
}

function moveCard(to) {
  const reason = moveReason(to)
  if (reason !== undefined) {
    console.log(`DS Bot: the data cannot move to ${to} (${reason})`)
    startWindow.card({ kind: 'rejected', reason, path: to })
    return
  }
  moveTo = to
  startWindow.card({ kind: 'move', path: to, dataDir: places.dataDir })
}

function moveReason(to, workspace = places.workspace) {
  try {
    const problem = moveProblemOf(to, workspace)
    return problem === undefined ? undefined : MOVE_REASONS[problem]
  } catch (error) {
    console.error(error)
    return 'permission'
  }
}

async function moveAnswer(value) {
  if (startWindow.kind !== 'later' || moveTo === undefined || picking || copying !== undefined || stopping || failed) return
  const to = moveTo
  moveTo = undefined
  if (value !== 'move') {
    startWindow.card(undefined)
    return
  }
  if (moveReason(to) !== undefined) {
    moveCard(to)
    return
  }
  attempt += 1
  forgetHost()
  startWindow.moving()
  await runMove(to, places.workspace)
}

async function askMove(workspace) {
  const picked = await askPicker(owner(), { mode: 'folder', title: tx('dialog.pickMove'), start: dirname(places.dataDir) })
  if (picked === undefined) return undefined
  const to = resolve(picked)
  if (await moveRefused(to, workspace)) return undefined
  const answer = await askInWindow({ message: tx('dialog.move.confirm', { to }), detail: tx('dialog.move.detail', { from: places.dataDir }), buttons: [{ label: tx('btn.move'), primary: true }, { label: tx('btn.cancel') }], cancel: 1 })
  if (answer !== 0 || stopping || await moveRefused(to, workspace)) return undefined
  return to
}

function moveProblemOf(to, workspace) {
  const dshHome = userDshHome()
  for (const current of new Set([workspace, places.workspace])) {
    const problem = moveProblem({ from: places.dataDir, to, workspace: current, dshHome, program: app.isPackaged ? programFolder() : undefined })
    if (problem !== undefined) return problem
  }
  return undefined
}

async function moveRefused(to, workspace) {
  const problem = moveProblemOf(to, workspace)
  if (problem === undefined) return false
  await askInWindow({ message: problem === 'dsh' ? tx('dialog.move.inDsh', { home: userDshHome() }) : tx(MOVE_PROBLEMS[problem]), buttons: [{ label: tx('btn.ok'), primary: true }], cancel: 0 })
  return true
}

async function runMove(to, workspace) {
  const signal = copyAbort.signal
  copying = (async () => {
    void mainWindow?.loadURL('about:blank').catch(() => {})
    mainWindow?.hide()
    startWindow.open('moving')
    await stopHost()
    const from = places.dataDir
    const stay = { kind: 'moveFailed', dataDir: from }
    const reason = moveReason(to, workspace)
    if (reason !== undefined) {
      await askCard({ ...stay, why: 'place', place: reason, path: to }, { signal })
      if (!signal.aborted) app.relaunch()
      return
    }
    if (teamInUse(from)) {
      const free = new AbortController()
      const answer = await askCard({ ...stay, why: 'inUse' }, { signal, settle: until(() => !teamInUse(from), free.signal) })
      free.abort()
      if (answer !== 'settled') {
        if (!signal.aborted) app.relaunch()
        return
      }
      startWindow.card(undefined)
    }
    for (;;) {
      setProgress(2)
      try {
        await copyData(from, to, signal)
        try {
          saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
        } catch (error) {
          await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
          throw error
        }
        break
      } catch (error) {
        if (signal.aborted) return
        console.error(error)
        setProgress(-1)
        const message = error instanceof Error ? error.message : String(error)
        const answer = await askCard({ ...stay, why: 'copy', reason: copyReason(error), log: message.split('\n') }, { signal })
        if (signal.aborted) return
        if (answer !== 'retry') break
        startWindow.card(undefined)
      } finally {
        setProgress(-1)
      }
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
}

function startUpdates() {
  const feed = process.env.DS_BOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : (version) => downloadPrompt.prompt(version), open: url => electronShell.openExternal(url),
      asset: version => `DS-Bot-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    return watchUpdates({
      updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : (version) => restartPrompt.prompt(version),
      beforeInstall: () => { shell.beginQuit(); return stopHost() },
    })
  }
  return undefined
}

function windowShown() {
  return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}

const afterHandoff = async () => { await startWindow.teamShown; return !failed }

async function askRestartNow(version) {
  if (failed || !await afterHandoff()) return false
  return await askInWindow({ message: tx('dialog.update.ready', { version }), detail: tx('dialog.update.readyDetail'), buttons: [{ label: tx('btn.restart'), primary: true }, { label: tx('btn.notNowRestart') }], cancel: 1 }) === 0
}

async function askDownloadNow(version) {
  if (failed || !await afterHandoff()) return false
  return await askInWindow({ message: tx('dialog.update.available', { version }), detail: tx('dialog.update.availableDetail'), buttons: [{ label: tx('btn.download'), primary: true }, { label: tx('btn.notNowDownload') }], cancel: 1 }) === 0
}

const cards = new Map()
let cardCount = 0
let pickerCount = 0

function askInWindow(card, { front = false } = {}) {
  const win = mainWindow
  const contents = win?.webContents
  if (win === undefined || win.isDestroyed() || contents.isLoading() || !contents.getURL().startsWith(`${origin}/`)) return Promise.resolve(undefined)
  if (front) toFront(win)
  const id = (cardCount += 1)
  return new Promise((resolve) => {
    let seen = false
    const settle = (value) => {
      if (!cards.has(id)) return
      cards.delete(id)
      clearTimeout(timer)
      contents.off('did-start-loading', away)
      contents.off('destroyed', away)
      if (cards.size === 0 && pickerCount === 0) botViews?.cover(false)
      resolve(value)
    }
    const away = () => { settle(undefined) }
    const timer = setTimeout(() => { if (!seen) away() }, CARD_SHOWN_MS)
    cards.set(id, { settle, shown: () => { seen = true } })
    botViews?.cover(true)
    contents.once('did-start-loading', away)
    contents.once('destroyed', away)
    contents.send(IPC.card, { id, ...card })
  })
}

async function boxInWindow(options, unasked) {
  const buttons = options.buttons.map((label, index) => ({ label, primary: index === options.defaultId }))
  const cancel = options.cancelId >= 0 ? options.cancelId : undefined
  const answer = await askInWindow({ message: options.message, detail: options.detail, buttons, cancel }, { front: true })
  return answer === undefined ? { response: unasked, unasked: true } : { response: answer }
}

async function pickOn(win, request) {
  if (win === undefined || win === null || win.isDestroyed()) return undefined
  const covers = win === mainWindow
  if (covers) { pickerCount += 1; botViews?.cover(true) }
  try {
    return await pickers.ask(win.webContents, { ...request, labels: pickerLabels() })
  } finally {
    if (covers && (pickerCount -= 1) === 0 && cards.size === 0) botViews?.cover(false)
  }
}

// app.getPath throws for a known folder that does not resolve; the picker then starts at home.
function knownFolder(name) {
  try { return app.getPath(name) } catch { return undefined }
}

const askPicker = async (win, request) => (await pickOn(win, request)) ?? undefined

function toFront(win) {
  if (win === undefined || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

async function installUpdate() { await updates?.install() }

async function openUpdatePage() {
  const state = updates?.state()
  if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
    await electronShell.openExternal(state.page)
  }
}

const restartPrompt = createDeferredPrompt({ ask: askRestartNow, shown: windowShown, onYes: installUpdate })
const downloadPrompt = createDeferredPrompt({ ask: askDownloadNow, shown: windowShown, onYes: openUpdatePage })

async function flushDeferredUpdate() {
  await restartPrompt.flush()
  await downloadPrompt.flush()
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const frameless = framelessOn(process.platform)
  const sidebarFill = () => (nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb')
  const win = new BrowserWindow({
    ...startWindow.mainBounds(), minWidth: 508, minHeight: 480,
    title: 'DS Bot', show: false, icon: iconFile,
    backgroundColor: material ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    ...frameOptions(process.platform, material, { color: sidebarFill(), symbolColor: dark ? '#f9fafb' : '#0f1115' }),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-bot-origin=${origin}`, ...(frameless ? [`--ds-bot-caption=${String(CAPTION_HEIGHT)}`, ...(material ? [`--ds-bot-material=${material}`] : [])] : [])],
    },
  })
  if (material === 'vibrancy') keepVibrancy(win, sidebarFill)
  mainWindow = win
  startWindow.placeMain(win)
  win.on('page-title-updated', (event) => { event.preventDefault() })
  win.on('closed', () => {
    if (mainWindow !== win) return
    mainWindow = undefined
    botViews.release()
  })
  shell.watch(win)
  browserGuests.bind(win)
  botViews.attach(win)
  const contents = win.webContents
  if (!downloadsBound) {
    downloadsBound = true
    contents.session.on('will-download', downloadSaver({
      window: () => mainWindow,
      ask: (name, folder) => pickOn(mainWindow, { mode: 'save', title: tx('dialog.saveAs'), start: folder, name }),
      staging: () => join(app.getPath('userData'), 'downloading'),
      getPath: name => app.getPath(name),
    }))
  }
  if (frameless) {
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, win.isFullScreen()) }
    win.on('enter-full-screen', sendFullscreen)
    win.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  for (const [on, file] of [[material !== undefined, 'material.css'], [process.platform === 'darwin', 'macos.css']]) {
    if (!on) continue
    const css = readFileSync(join(here, file), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(fonts) })
  const card = readFileSync(join(here, 'page-card.css'), 'utf8')
  contents.on('dom-ready', () => { void contents.insertCSS(card) })
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  win.on('show', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  win.on('restore', () => { void flushDeferredUpdate().catch((error) => { console.error(error) }) })
  return win
}

function rebuildWindow() {
  const win = createWindow()
  void connectHost(win).catch((error) => { console.error(error) })
  return win
}

async function connectHost(win) {
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  if (bootstrap !== undefined) await bootstrap
  if (hostReady) { await win.loadURL(`${origin}/`); return }
  if (await hostCookie()) {
    hostReady = true
    await win.loadURL(`${origin}/`)
    return
  }
  if (launchUrl !== undefined && !tokenSpent) {
    tokenSpent = true
    await win.loadURL(launchUrl)
    hostReady = true
    return
  }
  await win.loadURL(`${origin}/`)
}

async function hostCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: `${origin}/` })
    return cookies.length > 0
  } catch (error) {
    console.error(error)
    return false
  }
}

function trayImage() {
  const file = trayIconFile()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`the tray icon ${file} could not be read`)
  if (process.platform === 'darwin') {
    const retina = nativeImage.createFromPath(join(assets, 'trayTemplate@2x.png'))
    const size = retina.getSize()
    if (!retina.isEmpty() && size.width > image.getSize().width) {
      image.addRepresentation({ scaleFactor: 2, buffer: retina.toPNG(), width: size.width, height: size.height })
    }
    image.setTemplateImage(true)
  }
  return image
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const t = shellText()
  const items = [
    { role: 'about' },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
  ]
  if (!shell.hasTray()) {
    items.push({ type: 'separator' }, { label: t.quit, click: () => { shell.quit() } })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: items },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
}

function shellText() {
  return SHELL_TEXT
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error('DS Bot: rejected IPC from an unknown page')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void electronShell.openExternal(url)
}

async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const mine = attempt
  startWindow.fail(error, startKind())
  answering?.(undefined)
  await offerUpdate(mine).catch((failure) => { console.error(failure) })
}

async function offerUpdate(mine) {
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  const still = () => failed && mine === attempt
  offered = found ?? undefined
  if (!found || !still()) return
  const { version } = found
  if (found.page) { startWindow.update({ state: 'available', version, page: true }); return }
  const progress = (state) => {
    if (still() && state.phase === 'downloading') startWindow.update({ state: 'downloading', version, percent: state.percent ?? 0, received: state.received ?? 0, total: state.total ?? 0 })
  }
  progress(updates.state())
  const unsubscribe = updates.subscribe(progress)
  const downloaded = await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS, undefined, { ref: false }).then(() => false)]).finally(unsubscribe)
  if (!still()) return
  if (!downloaded) { startWindow.update({ state: 'failed', version }); return }
  startWindow.update({ state: 'installing', version })
  await updates.install()
}

function updateAct(name) {
  if (!failed) return
  if (name === 'manualDownload' || offered?.page) {
    const page = offered?.page ?? RELEASE_PAGE
    if (!process.env.DS_BOT_HOME) void electronShell.openExternal(page)
    return
  }
  if (updates === undefined || updates.state().phase !== 'failed') return
  updates.check()
  void offerUpdate(attempt).catch((error) => { console.error(error) })
}
