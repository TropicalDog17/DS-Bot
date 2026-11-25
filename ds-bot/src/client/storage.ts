export const STORAGE = {
  unread: 'ds-bot:unread',
  reactions: 'ds-bot:reactions',
  seen: 'ds-bot:seen',
  prefs: 'ds-bot:prefs',
  surface: 'ds-bot:surface',
  agentSessions: 'ds-bot:agent-sessions',
  browserWidth: 'ds-bot:browser-width',
  sidebar: 'ds-bot:sidebar',
  browsers: 'ds-bot.browser.v2',
}

const LEGACY_PREFIXES = ['dsh-bot:', 'dsh-bot-team:']
const LEGACY_BROWSER_KEYS = ['ds-bot.browser.v1', 'dsh-bot.browser.v1']
const LEGACY_THEMES = { grok: 'mono' }

export function legacyKeys(key) {
  if (key === STORAGE.browsers) return LEGACY_BROWSER_KEYS
  const name = key.slice(key.indexOf(':') + 1)
  return LEGACY_PREFIXES.map(prefix => `${prefix}${name}`)
}

const migrateBrowsers = (storage) => {
  if (storage.getItem(STORAGE.browsers) !== null) {
    for (const key of LEGACY_BROWSER_KEYS) storage.removeItem(key)
    return
  }
  for (const key of LEGACY_BROWSER_KEYS) {
    try {
      const value = storage.getItem(key)
      if (value === null) continue
      const previous = JSON.parse(value) ?? {}
      const tabs = Object.fromEntries((Object.entries(previous) as [string, any][])
        .filter(([, page]) => page && typeof page === 'object')
        .map(([botId, page]) => {
          const tab = { id: `v1-${botId}`, url: page.url ?? '', title: page.title ?? '' }
          return [botId, { tabs: [tab], active: tab.id }]
        }))
      storage.setItem(STORAGE.browsers, JSON.stringify(tabs))
      for (const earlier of LEGACY_BROWSER_KEYS) storage.removeItem(earlier)
      return
    } catch {}
  }
}

export function migrateStorage(storage = globalThis.localStorage) {
  for (const key of Object.values(STORAGE)) {
    if (key === STORAGE.browsers) continue
    for (const legacy of legacyKeys(key)) {
      try {
        const value = storage.getItem(legacy)
        if (value !== null && storage.getItem(key) === null) storage.setItem(key, value)
        storage.removeItem(legacy)
      } catch {}
    }
  }
  try { migrateBrowsers(storage) } catch {}
  try {
    const prefs = JSON.parse(storage.getItem(STORAGE.prefs) ?? 'null')
    if (prefs && Object.hasOwn(LEGACY_THEMES, prefs.theme ?? '')) {
      storage.setItem(STORAGE.prefs, JSON.stringify({ ...prefs, theme: LEGACY_THEMES[prefs.theme] }))
    }
  } catch {}
}
