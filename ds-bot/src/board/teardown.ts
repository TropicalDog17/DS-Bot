import { every as schedule } from './poller.ts'

const POLL_MS = 30_000
const FINISHED = new Set(['review', 'done', 'cancelled'])
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish'])
type ForegroundProcess = { name: string; argv: string[] }

function waitingWrapper(foreground: ForegroundProcess[]) {
  if (foreground.length !== 2) return false
  const sleep = foreground.findIndex(process => process.name === 'sleep')
  if (sleep === -1) return false
  const wrapper = foreground[1 - sleep]
  if (wrapper.name !== 'herdr-run-builder' && !SHELLS.has(wrapper.name)) return false
  const script = SHELLS.has(wrapper.name) ? wrapper.argv[1] : wrapper.argv[0]
  return /(?:^|\/)herdr-run-builder$/.test(script ?? '')
}

function eligible(data, owned) {
  if (owned === undefined || owned.closed !== undefined) return false
  const finished = owned.cardId === undefined ? owned.released === true : FINISHED.has(data.cards[owned.cardId]?.status)
  return finished && !Object.values<any>(data.waits ?? {}).some(wait => wait.pane === owned.pane)
}

const active = status => status === 'working' || status === 'blocked'

export function createPaneTeardown({ store, herdr, now = Date.now, warn = console.warn, every = schedule, roster }: any) {
  let disposed = false
  let polling = false

  function current(data, owned) {
    const entry = data.owned?.[owned.pane]
    if (disposed || !eligible(data, entry) || entry.botId !== owned.botId
      || entry.cardId !== owned.cardId || entry.sessionId !== owned.sessionId || entry.at !== owned.at) return undefined
    return entry
  }

  const skipped = { error: 'The pane is no longer ready to close.' }

  async function markGone(owned) {
    const result = await store.change(data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      entry.closed = { text: '', ...entry.evidence, at: now() }
      delete entry.evidence
    })
    return result.error === undefined
  }

  async function close(owned) {
    const { pane } = owned
    const status = await herdr.status(pane)
    if (status.gone === true) return markGone(owned)
    if (status.error !== undefined || typeof status.status !== 'string' || disposed) return false
    const processes = await herdr.processes(pane)
    if (processes.gone === true) return markGone(owned)
    if (processes.error !== undefined || !Array.isArray(processes.foreground) || disposed) return false
    const foreground: ForegroundProcess[] = processes.foreground
    const wrapper = waitingWrapper(foreground)
    const shell = foreground.length === 1 && SHELLS.has(foreground[0].name) && foreground[0].argv.length === 1
    if (!wrapper && (!shell || active(status.status))) return false

    const [read, info] = await Promise.all([herdr.read(pane), herdr.info(pane)])
    if (read.gone === true || info.gone === true) return markGone(owned)
    if (read.error !== undefined || typeof read.text !== 'string' || info.error !== undefined
      || typeof info.status !== 'string' || (!wrapper && (active(info.status) || active(read.status)))) return false
    const { status: lastStatus, agent, session } = info
    const saved = await store.change(data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      entry.evidence = { text: read.text, status: lastStatus, agent, session }
    })
    if (saved.error !== undefined) return false

    const result = await store.change(async data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      // Keep wait and card changes queued from this check until herdr answers.
      const closed = await herdr.close(pane)
      if (closed.ok !== true && closed.gone !== true) {
        warn('ds-bot-board: closing herdr pane %s failed: %s', pane, closed.error)
        return { error: closed.error ?? 'herdr could not close the pane.' }
      }
      entry.closed = { ...entry.evidence, at: now() }
      delete entry.evidence
    })
    return result.error === undefined
  }

  async function poll() {
    if (disposed || polling || store.readOnly()) return []
    polling = true
    const closed = []
    try {
      await roster.ready()
      for (const owned of Object.values<any>(store.read().owned ?? {})) {
        if (disposed) break
        if (!eligible(store.read(), owned)) continue
        try {
          if (await close(owned)) closed.push(owned.pane)
        } catch (error) {
          warn('ds-bot-board: checking herdr pane %s failed: %s', owned.pane, error)
        }
      }
    } finally {
      polling = false
    }
    return closed
  }

  const stop = every(POLL_MS, poll, {
    readOnly: () => store.readOnly(),
    onError: error => warn('ds-bot-board: polling herdr teardown failed: %s', error),
  })
  return Object.freeze({
    poll,
    dispose() { disposed = true; stop() },
  })
}
