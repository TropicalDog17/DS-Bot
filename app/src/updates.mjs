const CHECK_EVERY_MS = 4 * 60 * 60_000
export const RELEASES_URL = 'https://api.github.com/repos/Fei2411/DS-Bot/releases?per_page=20'
export const RELEASE_PAGE = 'https://github.com/Fei2411/DS-Bot/releases/latest'
const MB = 1024 * 1024

function parseVersion(version) {
  if (typeof version !== 'string') return null
  const value = version.replace(/^v/u, '')
  const separator = value.indexOf('-')
  const core = separator < 0 ? value : value.slice(0, separator)
  const pre = separator < 0 ? null : value.slice(separator + 1).split('.')
  const parts = core.split('.')
  if (parts.length > 3 || parts.some(part => !/^\d+$/u.test(part)) || pre?.some(part => part === '')) return null
  return {
    core: [0, 1, 2].map(index => (index < parts.length ? BigInt(parts[index]) : 0n)),
    pre,
  }
}

export function isNewer(candidate, current) {
  const newer = parseVersion(candidate)
  const older = parseVersion(current)
  if (newer === null || older === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (newer.core[index] !== older.core[index]) return newer.core[index] > older.core[index]
  }
  if (newer.pre === null) return older.pre !== null
  if (older.pre === null) return false
  for (let index = 0; index < Math.max(newer.pre.length, older.pre.length); index += 1) {
    const left = newer.pre[index]
    const right = older.pre[index]
    if (left === undefined) return false
    if (right === undefined) return true
    if (left === right) continue
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right)
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return false
}

function isHttpsPage(page) {
  if (typeof page !== 'string') return false
  try {
    return new URL(page).protocol === 'https:'
  } catch {
    return false
  }
}

const UPDATE_BUSY = new Set(['checking', 'downloading', 'downloaded'])

function stateHolder(log) {
  let state = { phase: 'checking' }
  const listeners = new Set()
  return {
    state: () => state,
    set: (next) => {
      state = next
      for (const listener of [...listeners]) {
        try { listener(next) } catch (error) { log.error(`DS Bot: an update state listener failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function watchReleases({ current, arch, fetch = globalThis.fetch, ask, open, feed = RELEASES_URL, log = console, asset }) {
  const assetName = asset ?? (version => `DS-Bot-${version}-mac-${arch}.zip`)
  let asked
  let latest = Promise.resolve(null)
  const holder = stateHolder(log)
  const run = () => {
    holder.set({ phase: 'checking' })
    latest = (async () => {
      try {
        const response = await fetch(feed, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': `DS-Bot/${current}` },
        })
        if (!response.ok) {
          log.error(`DS Bot: update check failed: HTTP ${String(response.status)}`)
          holder.set({ phase: 'failed' })
          return null
        }
        const releases = await response.json()
        if (!Array.isArray(releases)) {
          log.error('DS Bot: update check failed: releases response is not an array')
          holder.set({ phase: 'failed' })
          return null
        }
        const currentVersion = parseVersion(current)
        const allowPrerelease = currentVersion !== null && currentVersion.pre !== null
        let found
        for (const release of releases) {
          if (release === null || typeof release !== 'object' || release.draft === true
            || (release.prerelease === true && !allowPrerelease)) continue
          const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : ''
          if (!isNewer(version, current)) continue
          if (!Array.isArray(release.assets) || !release.assets.some(entry => entry?.name === assetName(version))) continue
          if (!isHttpsPage(release.html_url)) {
            log.error('DS Bot: update check failed: release page URL is not HTTPS')
            continue
          }
          if (found === undefined || isNewer(version, found.version)) found = { version, page: release.html_url }
        }
        if (found === undefined) {
          holder.set({ phase: 'current' })
          return null
        }
        log.info(`DS Bot: update ${found.version} available`)
        if (ask !== undefined && asked !== found.version) {
          asked = found.version
          void Promise.resolve().then(() => ask(found.version))
            .then(yes => (yes ? open(found.page) : undefined))
            .catch((error) => { log.error(`DS Bot: update ${found.version} not opened: ${error instanceof Error ? error.message : String(error)}`) })
        }
        holder.set({ phase: 'available', version: found.version, page: found.page })
        return found
      } catch (error) {
        log.error(`DS Bot: update check failed: ${error instanceof Error ? error.message : String(error)}`)
        holder.set({ phase: 'failed' })
        return null
      }
    })()
  }
  const check = () => { if (!UPDATE_BUSY.has(holder.state().phase)) run() }
  run()
  const timer = setInterval(check, CHECK_EVERY_MS)
  timer.unref?.()
  return { stop: () => { clearInterval(timer) }, latest: () => latest, state: holder.state, subscribe: holder.subscribe, check }
}

export function watchUpdates({ updater, beforeInstall, ask, feed, log = console }) {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  if (feed) updater.setFeedURL({ provider: 'generic', url: feed })
  const holder = stateHolder(log)
  const install = async () => {
    await beforeInstall()
    updater.quitAndInstall(true, true)
  }
  let asked
  updater.on('checking-for-update', () => { holder.set({ phase: 'checking' }) })
  updater.on('update-not-available', () => { holder.set({ phase: 'current' }) })
  updater.on('update-available', (info) => { holder.set({ phase: 'downloading', version: info?.version }) })
  updater.on('download-progress', (progress) => {
    const current = holder.state()
    const percent = Math.floor(Number(progress?.percent))
    if (current.phase !== 'downloading' || !Number.isFinite(percent) || percent === current.percent) return
    holder.set({ ...current, percent, received: Math.round(Number(progress.transferred) / MB) || 0, total: Math.round(Number(progress.total) / MB) || 0 })
  })
  updater.on('update-downloaded', ({ version }) => {
    log.info(`DS Bot: update ${version} downloaded`)
    holder.set({ phase: 'downloaded', version })
    if (ask === undefined || asked === version) return
    asked = version
    void ask(version).then(now => (now ? install() : undefined))
      .catch((error) => { log.error(`DS Bot: update ${version} not installed: ${error instanceof Error ? error.message : String(error)}`) })
  })
  updater.on('error', (error) => {
    log.error(`DS Bot: update failed: ${error instanceof Error ? error.message : String(error)}`)
    if (holder.state().phase !== 'downloaded') holder.set({ phase: 'failed' })
  })
  let latest = Promise.resolve(null)
  const settled = (next) => { if (holder.state().phase === 'checking') holder.set(next) }
  const run = () => {
    latest = updater.checkForUpdates().then((result) => {
      if (result?.isUpdateAvailable && result.downloadPromise) {
        settled({ phase: 'downloading', version: result.updateInfo.version })
        return { version: result.updateInfo.version, downloaded: result.downloadPromise.then(() => true, () => false) }
      }
      settled({ phase: 'current' })
      return null
    }, () => { settled({ phase: 'failed' }); return null })
  }
  const check = () => { if (!UPDATE_BUSY.has(holder.state().phase)) run() }
  run()
  const timer = setInterval(check, CHECK_EVERY_MS)
  timer.unref?.()
  return { stop: () => { clearInterval(timer) }, latest: () => latest, install, state: holder.state, subscribe: holder.subscribe, check }
}
