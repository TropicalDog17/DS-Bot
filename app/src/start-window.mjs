import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { within } from './copy-tree.mjs'
import { frameOptions, framelessOn, keepVibrancy } from './window-frame.mjs'

export const START_STATE = 'ds-bot:start-state'
export const START_ACT = 'ds-bot:start-act'

export const START_SIZE = { width: 720, height: 540 }
export const SHORT_START_SIZE = { width: 720, height: 500 }
const SHORT_WORK_AREA = 588
export const MAIN_SIZE = { width: 1320, height: 860 }
export const PHASES = ['data', 'engine', 'team']
export const IMPORT_PHASES = ['data', 'import', 'engine', 'team']
const COPY_CARDS = ['copying', 'importFailed']
export const phasesOf = state => (state.done.includes('import') || COPY_CARDS.includes(state.card?.kind) ? IMPORT_PHASES : PHASES)
export const START_KINDS = ['first', 'later', 'moving']
export const WATCHDOG_MS = 180_000
export const TEAM_VIEW_MS = 20_000
export const DESTROY_AFTER_MS = 300
export const CROSSFADE = { duration: 220, step: 16 }
export const HOLD_MS = CROSSFADE.duration + 40
export const TEAM_WAIT_MS = 150
export const TEAM_HANDOFF = 'ds-bot:handoff'
export const FAILURE_LINES = 200
export const SAVED_LINES = 5000
const COLORS = { light: { main: '#fcfcfc', ink: '#141414' }, dark: { main: '#141414', ink: '#f2f2f2' } }
export const PAINT_WAIT_MS = 3000
export const OPEN_MS = 200
const sinceLaunch = () => String(Math.round(process.uptime() * 1000))

const ACT_VIEWS = {
  handoffShow: ['handoff'],
  handoffDone: ['handoff'],
  retry: ['failed', 'watchdog'],
  wait: ['watchdog'],
  reloadView: ['viewFailed'],
  pick: ['boot', 'card', 'watchdog'],
  answer: ['card'],
  importModel: ['card'],
  importOption: ['card'],
  installUpdate: ['failed'],
  manualDownload: ['failed'],
  copyDetails: null,
  saveLog: null,
  painted: null,
}
export const START_ACTS = Object.freeze(Object.keys(ACT_VIEWS))

export function acceptsAct(name, view) {
  if (typeof name !== 'string' || !Object.hasOwn(ACT_VIEWS, name)) return false
  const views = ACT_VIEWS[name]
  return views === null || views.includes(view)
}

export function isStartPage(frameUrl, loadedUrl) {
  try {
    const frame = new URL(frameUrl)
    return frame.protocol === 'file:' && frame.href === new URL(loadedUrl).href
  } catch {
    return false
  }
}

export const startUrl = (page, kind) => `${pathToFileURL(page).href}?start=${kind}`

export const startSize = workArea => ({ ...(workArea.height < SHORT_WORK_AREA ? SHORT_START_SIZE : START_SIZE) })

export function centred(size, area) {
  return {
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y + Math.round((area.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}

export function clampInto(rect, area) {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

export function mainRect(start, area, size = MAIN_SIZE) {
  const x = Math.round(start.x + start.width / 2 - size.width / 2)
  const y = Math.round(start.y + start.height / 2 - size.height / 2)
  return clampInto({ x, y, width: size.width, height: size.height }, area)
}

export function cubicBezier(x1, y1, x2, y2) {
  const curve = (p1, p2) => {
    const c = 3 * p1
    const b = 3 * (p2 - p1) - c
    const a = 1 - c - b
    return s => ((a * s + b) * s + c) * s
  }
  const x = curve(x1, x2)
  const y = curve(y1, y2)
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let low = 0
    let high = 1
    for (let step = 0; step < 40; step += 1) {
      const mid = (low + high) / 2
      if (x(mid) < t) low = mid
      else high = mid
    }
    return y((low + high) / 2)
  }
}
export function landingOf(report, { team, start }) {
  if (report === null || typeof report !== 'object') return undefined
  const [x, y, width, height, viewportWidth, viewportHeight] = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'].map(key => Number(report[key]))
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || viewportWidth <= 0 || viewportHeight <= 0) return undefined
  if (width < 16 || height < 16 || x < 0 || y < 0 || x + width > viewportWidth || y + height > viewportHeight) return undefined
  const scale = team.width / viewportWidth
  const round = value => Math.round(value * 2) / 2
  return { x: round(team.x + x * scale - start.x), y: round(team.y + y * scale - start.y), size: round(((width + height) / 2) * scale) }
}

export function handoffBox(whale, { start, team, viewportWidth }) {
  if (whale === null || typeof whale !== 'object') return undefined
  const [x, y, size] = ['x', 'y', 'size'].map(key => Number(whale[key]))
  if (![x, y, size, viewportWidth].every(Number.isFinite) || size < 16 || viewportWidth <= 0) return undefined
  const zoom = team.width / viewportWidth
  const round = value => Math.round(value * 2) / 2
  return { x: round((start.x + x - team.x) / zoom), y: round((start.y + y - team.y) / zoom), size: round(size / zoom) }
}

export const fallbackMs = ({ start, celebrate }) => (start === 'first' || celebrate ? 2500 : 800)

const MISSING = /ENOENT: no such file or directory, (?:mkdir|open|access|stat|lstat|scandir|opendir|rename|copyfile) /u
const REASONS = [
  ['permission', /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted|access is denied/iu],
  ['space', /\b(?:ENOSPC|EDQUOT)\b|no space left|not enough space|disk (?:is )?full/iu],
  ['files', /\b(?:MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b|cannot find (?:module|package)|could not load its own bundles|not a valid Win32 application|0xC0000135|3221225781/iu],
  ['engine', /DSH Host stopped|engine's web server/iu],
]

function missingOwnFile(error, text, program) {
  if (!/\bENOENT\b/u.test(text)) return false
  const paths = [error?.path, ...[...text.matchAll(/ENOENT: [^,\n]*, \w+ '([^'\n]+)'/gu)].map(match => match[1])]
  return paths.some(path => typeof path === 'string' && program.some(folder => within(path, folder)))
}

export function failureReason(error, { program = [] } = {}) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = `${code} ${message}`
  for (const [reason, pattern] of REASONS) {
    if (pattern.test(text) || (reason === 'files' && missingOwnFile(error, text, program))) return reason
  }
  return MISSING.test(text) ? 'missing' : 'other'
}

export function mainBotName(state) {
  const id = Array.isArray(state?.mainBotIds) ? state.mainBotIds[0] : state?.mainBotId
  const name = typeof id === 'string' ? state.bots?.[id]?.name : undefined
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined
}

export function explainOf({ offered = false, team } = {}) {
  if (offered) return { mode: 'import', nextStep: false, previewNotice: false }
  if (team !== undefined) {
    const name = mainBotName(team.team)
    return { mode: 'reinstall', bots: team.bots, groups: team.rooms, ...(name === undefined ? {} : { name }), nextStep: false, previewNotice: false }
  }
  return { mode: 'new', nextStep: true, previewNotice: true }
}

export const clockMs = (clock, now) => clock.base + (clock.running ? Math.max(0, now - clock.from) : 0)

export function startSnapshot(state, now) {
  const snapshot = {
    v: 1,
    start: state.start,
    motion: state.motion,
    effects: state.effects ?? 'full',
    frame: state.frame,
    view: state.view,
    phases: [...phasesOf(state)],
    phase: phasesOf(state).find(phase => !state.done.includes(phase)) ?? 'team',
    done: phasesOf(state).filter(phase => state.done.includes(phase)),
    clock: { ms: Math.round(clockMs(state.clock, now)), at: now, running: state.clock.running, rate: 1 },
    explain: { ...state.explain },
    celebrate: state.celebrate,
    shown: state.shown === true,
  }
  if (state.hint !== undefined) snapshot.hint = { ...state.hint }
  if (state.place !== undefined) snapshot.place = { ...state.place }
  if (state.card !== undefined) snapshot.card = { ...state.card }
  if (state.failure !== undefined) snapshot.failure = { reason: state.failure.reason, log: [...state.failure.log] }
  if (state.landing !== undefined) snapshot.landing = { ...state.landing }
  if (state.update !== undefined) snapshot.update = { ...state.update }
  return snapshot
}

export const detailsText = ({ version, platform, arch, reason, lines }) => [`DS Bot ${version} (${platform} ${arch})`, `reason: ${reason}`, '', ...lines].join('\n')

const note = message => { console.log(`DS Bot: start window: ${message}`) }
const valueOf = payload => (payload !== null && typeof payload === 'object' && typeof payload.value === 'string' ? payload.value.slice(0, 40) : undefined)
const optionOf = payload => (payload !== null && typeof payload === 'object' && typeof payload.option === 'string' ? { option: payload.option.slice(0, 40), value: payload.value === true } : undefined)

export class StartWindow {
  #o
  #window
  #url
  #painted = Promise.resolve()
  #state
  #explain = explainOf()
  #asks = 0
  #watchAt = WATCHDOG_MS
  #timers = {}
  #phaseAt = 0
  #readyAt = 0
  #showAt = 0
  #handing = false
  #under = false
  #revealed = false
  #engineUp = false
  #readyHeld = false
  #readyReport
  #heldAt = 0
  #viewLate = false
  #teamShown
  #showTeam

  constructor(options) {
    this.#o = options
    this.#teamShown = new Promise((resolve) => { this.#showTeam = resolve })
    options.electron.ipcMain.handle(START_ACT, (event, name, payload) => this.#act(event, name, payload))
  }

  get kind() { return this.#state?.start }

  get painted() { return this.#painted }

  get teamShown() { return this.#teamShown }

  get revealed() { return this.#revealed }

  open(kind) {
    if (this.#open()) return
    const { BrowserWindow, screen, nativeTheme } = this.#o.electron
    const start = START_KINDS.includes(kind) ? kind : 'later'
    this.#reset(start)
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const win32 = process.platform === 'win32'
    const { material } = this.#o
    const colors = this.#colors()
    const rect = centred(startSize(area), area)
    const win = new BrowserWindow({
      ...rect,
      useContentSize: true, resizable: false, maximizable: false, fullscreenable: false, minimizable: true,
      show: false, title: 'DS Bot', icon: this.#o.icon,
      backgroundColor: material ? '#00000000' : colors.main,
      ...frameOptions(process.platform, material, { color: material ? '#00000000' : colors.main, symbolColor: colors.ink }),
      webPreferences: {
        preload: this.#o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: [`--ds-bot-start=${pathToFileURL(this.#o.page).href}`],
      },
    })
    win.setContentBounds(rect)
    if (material === 'vibrancy') keepVibrancy(win, () => this.#colors().main)
    this.#window = win
    this.#url = startUrl(this.#o.page, start)
    const contents = win.webContents
    win.once('ready-to-show', () => { note(`the start page painted ${sinceLaunch()} ms after launch`) })
    this.#later('show', PAINT_WAIT_MS, () => { this.#showStart('the page did not say it painted', { now: true }) })
    this.#painted = new Promise((resolve) => {
      win.once('ready-to-show', resolve)
      contents.once('did-finish-load', resolve)
      setTimeout(resolve, PAINT_WAIT_MS)
    })
    win.on('page-title-updated', (event) => { event.preventDefault() })
    contents.on('will-navigate', (event) => { event.preventDefault() })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('dom-ready', () => {
      if (this.#o.css) void contents.insertCSS(this.#o.css)
      this.#send()
    })
    contents.on('render-process-gone', (_event, details) => { note(`the page's renderer stopped (${String(details?.reason)})`) })
    if (this.#o.devTools) {
      contents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
      })
    }
    const recolor = () => {
      if (win.isDestroyed()) return
      const next = this.#colors()
      if (win32) win.setTitleBarOverlay({ color: material ? '#00000000' : next.main, symbolColor: next.ink })
      if (!material) win.setBackgroundColor(next.main)
    }
    nativeTheme.on('updated', recolor)
    win.once('closed', () => {
      nativeTheme.off('updated', recolor)
      if (this.#window !== win) return
      this.#window = undefined
      this.#clearTimers()
      if (!this.#revealed) this.#o.onClose()
    })
    void win.loadURL(this.#url).catch((error) => { note(`the start page did not load: ${error instanceof Error ? error.message : String(error)}`) })
  }

  owner() {
    if (!this.#open() || this.#revealed) return undefined
    this.#showStart('a dialog', { now: true })
    return this.#window
  }

  #showStart(why, { now = false } = {}) {
    this.#clear('show')
    const win = this.#window
    if (!this.#open()) return
    if (!win.isVisible()) {
      if (!now) win.setOpacity(0)
      win.show()
      note(`${this.#state.start} start window shown (${why}) ${sinceLaunch()} ms after launch`)
      if (!now) { this.#later('opaque', OPEN_MS, () => { this.#opaque() }); return }
    }
    if (now) this.#opaque()
  }

  #opaque() {
    this.#clear('opaque')
    if (!this.#open() || this.#state.shown) return
    this.#window.setOpacity(1)
    this.#update({ shown: true })
  }

  focus() {
    if (!this.#open() || this.#revealed) return false
    this.#showStart('focus', { now: true })
    const win = this.#window
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  explain(explain) {
    this.#explain = { ...explain }
    if (this.#open()) this.#update({ explain: this.#explain })
  }

  place(place) {
    if (this.#open()) this.#update({ place: place === undefined ? undefined : { ...place } })
  }

  hint(hint) {
    if (this.#open()) this.#update({ hint: hint === undefined ? undefined : { ...hint } })
  }

  card(card) {
    if (!this.#open() || !['boot', 'card', 'watchdog', 'moving'].includes(this.#state.view)) return false
    if (card === undefined && this.#state.view !== 'card') return false
    const back = this.#state.start === 'moving' ? 'moving' : 'boot'
    this.#update(card === undefined ? { view: back, card: undefined } : { view: 'card', card: { ...card } })
    if (card === undefined) this.#resume()
    return true
  }

  restart() {
    if (!this.#open()) return
    note('starting over in another folder')
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#clear('teamView')
    this.#update({ view: 'boot', done: [], card: undefined, failure: undefined, update: undefined, celebrate: true, clock: { base: 0, from: Date.now(), running: true } })
  }

  moving() {
    if (!this.#open()) return
    note('the data moves: the start window becomes the move\'s')
    this.#url = startUrl(this.#o.page, 'moving')
    this.#reset('moving')
    void this.#window.loadURL(this.#url).catch((error) => { note(`the start page did not load: ${error instanceof Error ? error.message : String(error)}`) })
  }

  async asking(promise) {
    this.#asks += 1
    this.#refresh()
    try {
      return await promise
    } finally {
      this.#asks -= 1
      this.#refresh()
      this.#resume()
    }
  }

  #resume() {
    if (this.#asks > 0 || !this.#open() || this.#state.view !== 'boot') return
    if (this.#readyHeld) {
      this.#readyHeld = false
      note(`the hand-off waited ${String(Date.now() - this.#heldAt)} ms for the answer`)
      this.ready(this.#readyReport)
    } else if (this.#viewLate) {
      this.#viewLate = false
      this.#teamViewLate()
    }
  }

  #holdsOff() {
    if (this.#readyHeld) note(`the held hand-off is dropped after ${String(Date.now() - this.#heldAt)} ms: the start goes on elsewhere`)
    this.#readyHeld = false
    this.#readyReport = undefined
    this.#viewLate = false
  }

  done(phase) {
    if (!this.#open() || !['data', 'import', 'engine'].includes(phase)) return
    const again = this.#state.done.includes(phase)
    if (again && (phase !== 'engine' || this.#engineUp)) return
    if (phase === 'engine') this.#engineUp = true
    note(`${phase} took ${String(Date.now() - this.#phaseAt)} ms`)
    this.#phaseAt = Date.now()
    this.#update({ ...(again ? {} : { done: [...this.#state.done, phase] }), ...(this.#state.view === 'watchdog' ? { view: 'boot' } : {}) })
  }

  engineDown() {
    if (!this.#open() || !this.#state.done.includes('engine')) return
    this.#engineUp = false
    this.#update({ done: this.#state.done.filter(phase => phase !== 'engine') })
  }

  teamLoading() {
    if (!this.#open()) return
    this.#later('teamView', TEAM_VIEW_MS, () => { this.#teamViewLate() })
  }

  #teamViewLate() {
    if (!['boot', 'card'].includes(this.#state.view)) return
    if (this.#asks > 0 || this.#state.view === 'card') { this.#viewLate = true; return }
    note(`the team view did not call ready() within ${String(TEAM_VIEW_MS / 1000)} s`)
    this.#update({ view: 'viewFailed', failure: { reason: 'other', log: this.#o.log.tail(FAILURE_LINES) } })
  }

  ready(report) {
    if (!this.#open() || !['boot', 'card', 'viewFailed'].includes(this.#state.view) || !this.#engineUp) return
    this.#clear('teamView')
    this.#readyReport = report
    if (this.#asks > 0 || this.#state.view === 'card') {
      if (!this.#readyHeld) {
        note('the team view is ready; the hand-off waits for the answer')
        this.#heldAt = Date.now()
      }
      this.#readyHeld = true
      return
    }
    this.#readyHeld = false
    const now = Date.now()
    note(`team took ${String(now - this.#phaseAt)} ms`)
    this.#readyAt = now
    const celebrate = this.#state.celebrate && this.#state.view !== 'viewFailed'
    this.#update({ view: 'handoff', done: [...phasesOf(this.#state)], celebrate, failure: undefined, landing: this.#landing(report) })
    const main = this.#o.mainWindow()
    if (main !== undefined && !main.isDestroyed() && !this.#window.isMinimized()) this.#underlay(main)
    this.#later('fallback', fallbackMs(this.#state), () => {
      note('the page did not send handoffShow')
      this.#handoffShow({ grow: false })
    })
  }

  fail(error, kind = 'later') {
    const showing = this.#revealed
    const emptied = !showing && this.#open() && this.#state.view === 'handoff'
    if (showing) {
      this.#destroy()
      const main = this.#o.mainWindow()
      if (main !== undefined && !main.isDestroyed()) main.hide()
    }
    if (!this.#open()) this.open(showing || this.#state === undefined ? kind : this.#state.start)
    this.#cancelHandoff()
    this.#holdsOff()
    this.#clear('teamView')
    this.#clear('fallback')
    this.#update({ view: 'failed', failure: { reason: failureReason(error, { program: this.#o.program }), log: this.#o.log.tail(FAILURE_LINES) } })
    if (emptied) this.#window.webContents.reload()
  }

  update(update) {
    if (!this.#open() || this.#state.view !== 'failed') return
    this.#update({ update: update === undefined ? undefined : { ...update } })
  }

  mainBounds() {
    const { screen } = this.#o.electron
    if (!this.#open()) return centred(clampInto({ x: 0, y: 0, ...MAIN_SIZE }, screen.getPrimaryDisplay().workArea), screen.getPrimaryDisplay().workArea)
    const start = this.#window.getNormalBounds()
    return mainRect(start, screen.getDisplayMatching(start).workArea)
  }

  #landing(report) {
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed() || this.#window.isMinimized()) return undefined
    if (report === undefined) { note('no place to land: the whale dives'); return undefined }
    try {
      const measured = main.getContentBounds()
      const rect = this.placeMain(main)
      const team = main.getContentBounds()
      const outer = this.#window.getBounds()
      const inner = this.#window.getContentBounds()
      const landing = landingOf(report, { team: { x: team.x, y: team.y, width: measured.width }, start: { x: rect.x + inner.x - outer.x, y: rect.y + inner.y - outer.y } })
      const inside = landing !== undefined && landing.x >= 0 && landing.y >= 0 && landing.x + landing.size <= rect.width && landing.y + landing.size <= rect.height
      note(inside ? `the whale lands at ${String(landing.x)}, ${String(landing.y)} (${String(landing.size)} px)` : 'no place to land: the whale dives')
      return inside ? landing : undefined
    } catch (error) {
      note(`no place to land (${error instanceof Error ? error.message : String(error)}): the whale dives`)
      return undefined
    }
  }

  placeMain(main = this.#o.mainWindow()) {
    const rect = this.mainBounds()
    if (main !== undefined && !main.isDestroyed()) main.setBounds(rect)
    return rect
  }

  #open() { return this.#window !== undefined && !this.#window.isDestroyed() }

  #colors() { return COLORS[this.#o.electron.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'] }

  #reset(start) {
    this.#clearTimers()
    this.#handing = false
    this.#under = false
    this.#revealed = false
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    const now = Date.now()
    this.#phaseAt = now
    this.#state = {
      start, motion: this.#o.motion, effects: this.#o.effects ?? 'full', frame: framelessOn(process.platform) ? 'band' : 'system',
      view: start === 'moving' ? 'moving' : 'boot',
      done: [], explain: this.#explain, celebrate: start === 'first', shown: false,
      clock: { base: 0, from: now, running: true },
      hint: undefined, place: undefined, card: undefined, failure: undefined, update: undefined,
    }
    this.#refresh()
  }

  #update(change) {
    const now = Date.now()
    const next = { ...this.#state, ...change }
    const running = this.#asks === 0 && (next.view === 'boot' || next.view === 'moving')
    const clock = next.clock
    if (running !== clock.running) next.clock = { base: clockMs(clock, now), from: now, running }
    this.#state = next
    this.#armWatchdog()
    this.#send()
  }

  #refresh() { if (this.#state !== undefined) this.#update({}) }

  #send() {
    if (this.#open() && this.#state !== undefined) this.#window.webContents.send(START_STATE, startSnapshot(this.#state, Date.now()))
  }

  #armWatchdog() {
    this.#clear('watchdog')
    const { start, view, clock } = this.#state
    if (start === 'moving' || view !== 'boot' || !clock.running || this.#engineUp) return
    this.#later('watchdog', this.#watchAt - clockMs(clock, Date.now()), () => {
      note(`no engine after ${String(Math.round(this.#watchAt / 1000))} s`)
      this.#update({ view: 'watchdog' })
    })
  }

  #act(event, name, payload) {
    const win = this.#window
    if (!this.#open() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || !isStartPage(event.senderFrame?.url, this.#url)) return false
    if (!acceptsAct(name, this.#state.view)) {
      note(`refused the act ${typeof name === 'string' ? name.slice(0, 40) : typeof name} in ${this.#state.view}`)
      return false
    }
    if (name === 'handoffShow') this.#handoffShow(payload)
    else if (name === 'handoffDone') note(`handoffDone at handoffShow + ${String(Date.now() - this.#showAt)} ms`)
    else if (name === 'retry') this.#retry()
    else if (name === 'wait') this.#wait()
    else if (name === 'reloadView') this.#reload()
    else if (name === 'copyDetails') this.#copyDetails()
    else if (name === 'saveLog') void this.#saveLog()
    else if (name === 'painted') this.#showStart('painted')
    else if (name === 'pick') this.#o.onPick?.(valueOf(payload))
    else if (name === 'answer') this.#o.onAnswer?.(valueOf(payload))
    else if (name === 'installUpdate' || name === 'manualDownload') this.#o.onUpdate?.(name)
    else if (name === 'importOption') this.#o.onImport?.(name, optionOf(payload))
    else if (name === 'importModel') this.#o.onImport?.(name, valueOf(payload))
    return true
  }

  #retry() {
    note(`retry from ${this.#state.view}`)
    this.#engineUp = false
    this.#holdsOff()
    this.#watchAt = WATCHDOG_MS
    this.#phaseAt = Date.now()
    this.#update({ view: 'boot', failure: undefined, update: undefined, celebrate: true, done: this.#state.done.filter(phase => phase !== 'team'), clock: { base: 0, from: Date.now(), running: true } })
    this.#o.onRetry()
  }

  #wait() {
    this.#watchAt = clockMs(this.#state.clock, Date.now()) + WATCHDOG_MS
    this.#update({ view: 'boot' })
  }

  #reload() {
    note('reloading the team view')
    this.#update({ view: 'boot', failure: undefined })
    this.#o.onReload()
    this.teamLoading()
  }

  #copyDetails() {
    const { version } = this.#o
    const reason = this.#state.failure?.reason ?? 'other'
    const text = detailsText({ version, platform: process.platform, arch: process.arch, reason, lines: this.#o.log.tail(FAILURE_LINES) })
    void Promise.resolve(this.#o.electron.clipboard.writeText(text)).catch((error) => { note(`the details were not copied: ${error instanceof Error ? error.message : String(error)}`) })
  }

  async #saveLog() {
    const { version, saveAs } = this.#o
    if (saveAs === undefined) return
    const reason = this.#state.failure?.reason ?? 'other'
    const text = detailsText({ version, platform: process.platform, arch: process.arch, reason, lines: this.#o.log.tail(SAVED_LINES) })
    try {
      const filePath = await saveAs(this.#window, 'DS-Bot-log.txt')
      if (!filePath) return
      await writeFile(filePath, text, 'utf8')
      note(`the log was saved to ${filePath}`)
    } catch (error) {
      note(`the log was not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #handoffShow(payload) {
    if (this.#handing || this.#state.view !== 'handoff') return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#handing = true
    this.#clear('fallback')
    this.#showAt = Date.now()
    note(`handoffShow at ready + ${String(this.#showAt - this.#readyAt)} ms`)
    this.placeMain(main)
    const box = this.#state.landing === undefined || this.#readyReport === undefined ? undefined : this.#teamBox(main, payload)
    if (box === undefined || !this.#under) { this.#reveal(); return }
    main.webContents.send(TEAM_HANDOFF, { ...box, hold: HOLD_MS })
    this.#later('teamWait', TEAM_WAIT_MS, () => { note('the team page did not say it drew the whale'); this.#reveal() })
  }

  teamReady() {
    if (!this.#handing || this.#revealed || this.#timers.teamWait === undefined) return
    note(`the team page drew the whale at handoffShow + ${String(Date.now() - this.#showAt)} ms`)
    this.#reveal()
  }

  #teamBox(main, payload) {
    try {
      const whale = payload !== null && typeof payload === 'object' ? payload.whale : undefined
      const start = this.#window.getContentBounds()
      const team = main.getContentBounds()
      return handoffBox(whale, { start, team, viewportWidth: Number(this.#readyReport.viewportWidth) })
    } catch (error) {
      note(`no whale to hand over (${error instanceof Error ? error.message : String(error)})`)
      return undefined
    }
  }

  #underlay(main) {
    try {
      main.setSkipTaskbar(true)
      main.setOpacity(0)
      main.showInactive()
      this.#window.moveTop()
      this.#under = true
    } catch (error) {
      note(`the team window did not go under the start window: ${error instanceof Error ? error.message : String(error)}`)
      this.#unlay(main)
    }
  }

  #unlay(main) {
    this.#under = false
    if (main.isDestroyed()) return
    main.hide()
    main.setOpacity(1)
    main.setSkipTaskbar(false)
  }

  #reveal() {
    if (this.#revealed || !this.#open()) return
    const main = this.#o.mainWindow()
    if (main === undefined || main.isDestroyed()) return
    this.#revealed = true
    this.#showTeam()
    this.#clear('fallback')
    this.#clear('teamWait')
    const win = this.#window
    const how = win.isMinimized() ? 'minimized' : win.isFocused() ? 'focused' : 'behind'
    if (this.#under && how !== 'minimized') { this.#crossfade(main, win, how); return }
    if (this.#under) this.#unlay(main)
    if (how === 'focused') {
      main.show()
      main.focus()
    } else if (how === 'minimized') {
      main.minimize()
    } else {
      main.showInactive()
      try { main.moveAbove(win.getMediaSourceId()) } catch { /* the order stays the system's */ }
    }
    if (how !== 'focused') {
      main.flashFrame(true)
      main.once('focus', () => { main.flashFrame(false) })
    }
    win.setSkipTaskbar(true)
    note(`team window shown (${how}) at ready + ${String(Date.now() - this.#readyAt)} ms`)
    this.#later('destroy', DESTROY_AFTER_MS, () => { this.#destroy() })
  }

  #crossfade(main, win, how) {
    if (!main.isVisible()) main.showInactive()
    main.setSkipTaskbar(false)
    win.setSkipTaskbar(true)
    note(`cross-fade at ready + ${String(Date.now() - this.#readyAt)} ms`)
    const began = Date.now()
    const step = () => {
      if (!this.#open() || main.isDestroyed()) return
      const time = this.#o.effects === 'off' ? 1 : Math.min(1, (Date.now() - began) / CROSSFADE.duration)
      const eased = time * time * (3 - 2 * time)
      main.setOpacity(eased)
      win.setOpacity(1 - eased)
      if (time < 1) { this.#later('fade', CROSSFADE.step, step); return }
      this.#destroy()
      if (how === 'focused') {
        main.focus()
        main.webContents?.focus?.()
      } else {
        main.flashFrame(true)
        main.once('focus', () => { main.flashFrame(false) })
      }
      note(`team window shown (${how}) at ready + ${String(Date.now() - this.#readyAt)} ms`)
    }
    step()
  }

  #cancelHandoff() {
    const main = this.#o.mainWindow()
    if (this.#under && !this.#revealed && main !== undefined) this.#unlay(main)
    if (!this.#handing || this.#revealed) return
    this.#clear('teamWait')
    this.#handing = false
  }

  #destroy() {
    const win = this.#window
    if (win !== undefined && !win.isDestroyed()) win.destroy()
  }

  #later(name, ms, run) {
    this.#clear(name)
    this.#timers[name] = setTimeout(() => {
      delete this.#timers[name]
      run()
    }, Math.max(0, ms))
  }

  #clear(name) {
    clearTimeout(this.#timers[name])
    delete this.#timers[name]
  }

  #clearTimers() { for (const name of Object.keys(this.#timers)) this.#clear(name) }
}
