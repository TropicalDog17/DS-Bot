// Adapted from DeepSeek Harness apps/desktop/src/browser-guests.ts (MIT); see NOTICE.
import { createHash, randomUUID } from 'node:crypto'

const KEY_MAX = 4096
const BLANK = 'about:blank#'
const LOOPBACK = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', '[::ffff:7f00:1]'])

export const partitionOf = key => `persist:ds-bot-browser-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`

export function isAppHost(url, origin) {
  if (origin === undefined) return false
  const host = new URL(origin)
  if (url.port !== host.port) return false
  const name = url.hostname.replace(/\.$/u, '')
  return name === host.hostname || LOOPBACK.has(name) || name.endsWith('.localhost') || /^127\./u.test(name)
}

const credentialFree = url => url.username === '' && url.password === ''

export function allowedNavigation(value, origin) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && credentialFree(url) && !isAppHost(url, origin)
}

export function requestAllowed(value, origin) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return credentialFree(url) && !isAppHost(url, origin)
  return ['about:', 'data:', 'blob:'].includes(url.protocol)
}

const keyOf = (key) => {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX) throw new Error('DS Bot: a browser storage key is required')
  return key
}

export class BotBrowserGuests {
  #leases = new Map()
  #configured = new Set()
  #downloadHandlers = new Map()

  constructor({ session, origin, devTools }) {
    this.session = session
    this.origin = origin
    this.devTools = devTools
  }

  acquire(owner, key) {
    const { partition } = this.storageFor(key)
    const lease = randomUUID()
    this.#leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  storageFor(key) {
    const partition = partitionOf(keyOf(key))
    if (!this.#configured.has(partition)) {
      this.#configure(this.session.fromPartition(partition), partition)
      this.#configured.add(partition)
    }
    return { partition, storage: this.session.fromPartition(partition) }
  }

  setDownloadHandler(key, handler) {
    const { storage, partition } = this.storageFor(key)
    this.#downloadHandlers.set(partition, handler)
    return storage
  }

  async release(owner, id) {
    if (typeof id !== 'string') throw new Error('DS Bot: invalid browser lease')
    const lease = this.#leases.get(id)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('DS Bot: the browser lease belongs to another window')
    this.#leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  async forget(owner, key) {
    const partition = partitionOf(keyOf(key))
    const own = [...this.#leases].filter(([, lease]) => lease.owner === owner && lease.partition === partition)
    await Promise.all(own.map(([id]) => this.release(owner, id)))
    const storage = this.session.fromPartition(partition)
    await storage.clearStorageData()
    await storage.clearCache()
    this.#downloadHandlers.delete(partition)
  }

  bind(window) {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith(BLANK) ? params.src.slice(BLANK.length) : ''
      const lease = this.#leases.get(id)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups flag: it lets window requests reach the guest's handler, which denies them all.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: this.devTools,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attached
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith(BLANK) ? url.slice(BLANK.length) : ''
        const lease = this.#leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attached = id
        guest.once('destroyed', () => { this.#leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attached === undefined ? undefined : this.#leases.get(attached)
        if (lease?.guest === guest && !owner.isDestroyed() && postBody === undefined && allowedNavigation(url, this.origin())) {
          owner.send('ds-bot:browser-open-requested', { lease: attached, url: new URL(url).href })
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !allowedNavigation(event.url, this.origin())) event.preventDefault()
      })
      guest.on('will-redirect', (event) => {
        if (event.isMainFrame && !allowedNavigation(event.url, this.origin())) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = () => {
      for (const [id, lease] of this.#leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  #configure(storage, partition) {
    storage.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    storage.setPermissionCheckHandler(() => false)
    storage.setDevicePermissionHandler(() => false)
    storage.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    storage.on('will-download', (event, item, source) => {
      const handler = this.#downloadHandlers.get(partition)
      if (handler) handler(event, item, source)
      else event.preventDefault()
    })
    storage.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !requestAllowed(details.url, this.origin()) }) })
  }
}
