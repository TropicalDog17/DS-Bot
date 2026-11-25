const IDLE_MS = 60_000

export function createLeases({ idleMs = IDLE_MS, now = Date.now, onChange = () => {} } = {}) {
  const leases = new Map()

  const drop = (key) => {
    const lease = leases.get(key)
    if (lease === undefined) return
    clearTimeout(lease.timer)
    leases.delete(key)
    onChange()
  }
  const arm = (key, lease) => {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(() => drop(key), idleMs)
    lease.timer.unref?.()
  }
  const take = (key, botId, sessionId) => {
    const held = leases.get(key)
    if (held !== undefined && held.botId !== botId) return held
    if (held !== undefined) {
      held.sessionId = sessionId
      held.last = now()
      arm(key, held)
      return undefined
    }
    const lease = { botId, sessionId, since: now(), last: now() }
    leases.set(key, lease)
    arm(key, lease)
    onChange()
    return undefined
  }

  return {
    takeApp: (appKey, botId, sessionId) => take(`app:${appKey}`, botId, sessionId),
    takeForeground: (botId, sessionId) => take('foreground', botId, sessionId),
    holderOfApp: appKey => leases.get(`app:${appKey}`),
    holderOfForeground: () => leases.get('foreground'),
    ofBot: botId => [...leases.entries()].filter(([, lease]) => lease.botId === botId),
    entries: () => [...leases.entries()].map(([key, lease]) => ({
      kind: key === 'foreground' ? 'foreground' : 'app',
      appKey: key === 'foreground' ? null : key.slice(4),
      botId: lease.botId,
      since: lease.since,
      last: lease.last,
    })),
    endSession: (sessionId) => {
      for (const [key, lease] of [...leases]) if (lease.sessionId === sessionId) drop(key)
    },
    releaseBot: (botId) => {
      for (const [key, lease] of [...leases]) if (lease.botId === botId) drop(key)
    },
    releaseAll: () => {
      for (const key of [...leases.keys()]) drop(key)
    },
    dispose: () => {
      for (const lease of leases.values()) clearTimeout(lease.timer)
      leases.clear()
    },
  }
}
