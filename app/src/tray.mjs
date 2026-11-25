export function createTray({ Tray, Menu, platform, image, tooltip, open, quit, computer, log = console }) {
  const tray = new Tray(image)
  let disposed = false
  let entries = []
  const relabel = () => {
    tray.setToolTip(tooltip)
    const rows = entries.map(entry => ({
      label: entry.label,
      click: () => { computer?.onAction('stop', entry.botId ?? null) },
    }))
    if (entries.length > 1) rows.push({
      label: computer?.stopAll?.() ?? 'Stop all', click: () => { computer?.onAction('stopall', null) },
    })
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: open.label, click: () => { open.run() } },
      ...(rows.length > 0 ? [{ type: 'separator' }, ...rows] : []),
      { type: 'separator' },
      { label: quit.label, click: () => { quit.run() } },
    ]))
  }
  if (platform !== 'darwin') tray.on('click', () => { open.run() })
  relabel()
  return {
    tray,
    relabel,
    setComputer(next) {
      entries = Array.isArray(next) ? next.filter(entry => entry && typeof entry.label === 'string') : []
      if (!disposed) relabel()
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { tray.destroy() } catch (error) { log.warn(`DS Bot: the tray icon did not go away: ${error instanceof Error ? error.message : String(error)}`) }
    },
  }
}
