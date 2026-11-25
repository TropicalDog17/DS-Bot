export function createNotifications({ Notification, systemPreferences, platform = process.platform, isSupported, log = console }) {
  const live = new Set()
  const supported = () => (typeof isSupported === 'function' ? isSupported() : Notification.isSupported?.() !== false)

  function status() {
    if (!supported()) return 'unsupported'
    let authorizationStatus
    try { authorizationStatus = systemPreferences?.getNotificationSettings?.()?.authorizationStatus } catch { authorizationStatus = undefined }
    if (authorizationStatus === 'denied') return 'denied'
    if (authorizationStatus === 'restricted') return 'denied'
    return 'unknown'
  }

  function show(notice, { open, focused } = {}) {
    if (!supported()) return false
    if (typeof focused === 'function' && focused() === true) return false
    if (status() === 'denied') return false
    const title = String(notice?.title ?? '').slice(0, 120)
    const body = String(notice?.body ?? '').slice(0, 200)
    if (title === '' && body === '') return false
    let notification
    try {
      notification = new Notification({ title, body, silent: false })
    } catch (error) {
      log.warn?.('ds-bot: notification failed: %s', error?.message ?? error)
      return false
    }
    live.add(notification)
    let settled = false
    const done = () => { live.delete(notification) }
    notification.on('close', done)
    notification.on('click', () => {
      if (settled) return
      settled = true
      done()
      try { open?.() } catch (error) { log.warn?.('ds-bot: notification open failed: %s', error?.message ?? error) }
    })
    notification.show()
    return true
  }

  function clear() {
    for (const notification of live) {
      try { notification.close?.() } catch { /* already gone */ }
    }
    live.clear()
  }

  return { status, show, clear, supported }
}

/**
 * The badge a dock or taskbar shows: the number of conversations with something new.
 * macOS and Linux read `setBadgeCount`; Windows has none and keeps the tray tooltip.
 * @param {number} count
 * @returns {number} the count actually set
 */
export function badgeCount(count) {
  const value = Math.max(0, Math.trunc(Number(count) || 0))
  return value > 99 ? 99 : value
}
