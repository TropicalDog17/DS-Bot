import { BackgroundNotice } from './background-notice.mjs'
import { createTray } from './tray.mjs'

export const SHELL_TEXT = {
  tooltip: 'DS Bot',
  open: 'Open DS Bot',
  quit: 'Quit DS Bot',
  notice: 'DS Bot keeps running in the system tray. Its Bots go on working while the window is closed.',
  noticeConfirm: 'OK',
  fallback: 'The system tray is not available, so DS Bot cannot stay in the background. Do you want to end it?',
  cancel: 'Cancel',
  stopAll: 'Stop all',
}

export function createShell(options) {
  const { electron, platform, log = console } = options
  const { app, powerMonitor } = electron
  let tray
  let notice
  let quitting = false
  let quitAsked = false
  let sessionEnding = false
  const hidden = new WeakSet()
  const pending = new WeakMap()

  const text = () => options.messages()
  const current = () => options.window()

  const hide = (target = current()) => {
    if (quitting || sessionEnding || target === undefined || target.isDestroyed()) return
    hidden.add(target)
    if (platform === 'darwin' && target.isFullScreen()) {
      const onLeave = () => {
        pending.delete(target)
        if (quitting || sessionEnding || target.isDestroyed()) return
        if (!hidden.has(target)) return
        target.hide()
      }
      pending.set(target, onLeave)
      target.once('leave-full-screen', onLeave)
      target.setFullScreen(false)
      return
    }
    target.hide()
  }

  const open = () => {
    if (quitting) return
    const target = current()
    if (target !== undefined && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore()
      const waiting = pending.get(target)
      if (waiting !== undefined) {
        pending.delete(target)
        target.removeListener?.('leave-full-screen', waiting)
      }
      hidden.delete(target)
      options.reveal(target)
      return
    }
    if (!options.ready()) return
    const built = options.build()
    if (built !== undefined && !built.isDestroyed()) {
      hidden.delete(built)
      options.reveal(built)
    }
  }

  const quit = () => {
    if (quitAsked) return
    quitAsked = true
    options.quit()
  }

  function beginQuit() { quitting = true; quitAsked = true }

  function cancelQuit() { quitting = false; quitAsked = false }

  const buildTray = () => {
    try {
      const image = options.trayImage()
      tray = createTray({
        Tray: electron.Tray, Menu: electron.Menu, platform,
        image, tooltip: text().tooltip,
        open: { label: text().open, run: () => { open() } },
        quit: { label: text().quit, run: () => { quit() } },
        computer: { onAction: (kind, botId) => { options.computer?.(kind, botId) }, stopAll: () => text().stopAll },
        log,
      })
    } catch (error) {
      tray = undefined
      log.warn(`DS Bot: the system tray is not available: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const askFallback = async (target) => {
    const t = text()
    try {
      const { response } = await options.fallback.show({
        type: 'question', title: 'DS Bot', message: t.fallback,
        buttons: [t.quit, t.cancel], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (response === 0) { quit(); return }
    } catch (error) {
      log.warn(`DS Bot: the fallback quit could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
    target.minimize()
  }

  const close = (event) => {
    if (quitting || sessionEnding) return
    event.preventDefault()
    const target = current()
    if (target === undefined) return
    if (options.busy()) { quit(); return }
    if (tray === undefined) { void askFallback(target); return }
    if (notice === undefined) { hide(target); return }
    notice.close(() => { hide(target) })
  }

  const watch = (target) => {
    target.on('close', (event) => { close(event) })
    if (platform === 'win32') {
      target.on('session-end', () => { sessionEnding = true })
    } else {
      target.on('focus', () => { sessionEnding = false })
      target.on('show', () => { sessionEnding = false })
    }
  }

  const install = () => {
    app.on('window-all-closed', () => {})
    app.on('activate', () => { sessionEnding = false; open() })
    if (platform !== 'win32') {
      powerMonitor.on('shutdown', () => { sessionEnding = true })
    }
    notice = new BackgroundNotice({
      marker: options.notice.marker(), show: options.notice.show, focus: options.notice.focus, message: text().notice, confirm: text().noticeConfirm, log,
    })
    buildTray()
  }

  const dispose = () => {
    notice?.dispose()
    notice = undefined
    tray?.dispose()
    tray = undefined
  }

  return {
    install,
    watch,
    close,
    open,
    quit,
    beginQuit,
    cancelQuit,
    dispose,
    setComputer: entries => { tray?.setComputer(entries) },
    hasTray: () => tray !== undefined,
    isQuitting: () => quitting,
    isHidden: (target) => hidden.has(target),
    isSessionEnding: () => sessionEnding,
  }
}
