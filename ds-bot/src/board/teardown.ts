import { basename } from 'node:path'
import { every as schedule } from './poller.ts'
import type { OwnedPane } from './store.ts'

const POLL_MS = 30_000
const CLOSED_LIMIT = 200
const FINISHED = new Set(['review', 'done', 'cancelled'])
const QUIET_AGENT = new Set(['done', 'idle'])
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

function eligible(data, owned: OwnedPane | undefined) {
  if (owned === undefined || owned.closed !== undefined) return false
  const finished = owned.cardId === undefined ? owned.released === true : FINISHED.has(data.cards[owned.cardId]?.status)
  return finished && !Object.values<any>(data.waits ?? {}).some(wait => wait.pane === owned.pane)
}

function safeToClose(owned: OwnedPane, info, processes) {
  if (owned.terminal === undefined || info.terminal !== owned.terminal || info.focused !== false
    || info.error !== undefined || typeof info.status !== 'string' || info.status === 'working'
    || processes.error !== undefined || !Array.isArray(processes.foreground)) return false
  const foreground: ForegroundProcess[] = processes.foreground
  if (waitingWrapper(foreground)) return QUIET_AGENT.has(info.status) || info.status === 'blocked'
  if (info.status === 'blocked' || foreground.length !== 1) return false
  const [process] = foreground
  if (SHELLS.has(process.name) && process.argv.length === 1) return true
  return QUIET_AGENT.has(info.status) && typeof info.agent === 'string' && info.agent !== ''
    && (process.name === info.agent || basename(process.argv[0] ?? '') === info.agent)
}

function saveClosed(owned: Record<string, OwnedPane>, entry: OwnedPane, at: number) {
  entry.closed = { text: '', ...entry.evidence, at }
  delete entry.evidence
  const older = Object.values(owned).filter(pane => pane !== entry && pane.closed !== undefined)
  if (older.length < CLOSED_LIMIT) return
  older.sort((a, b) => b.closed.at - a.closed.at || b.at - a.at)
  for (const pane of older.slice(CLOSED_LIMIT - 1)) delete owned[pane.pane]
}

export function createPaneTeardown({ store, herdr, now = Date.now, warn = console.warn, every = schedule, roster }: any) {
  let disposed = false
  let polling = false
  const warned = new Map<string, { terminal?: string; error: string }>()

  function current(data, owned: OwnedPane): OwnedPane | undefined {
    const entry = data.owned?.[owned.pane]
    if (disposed || !eligible(data, entry) || entry.botId !== owned.botId
      || entry.cardId !== owned.cardId || entry.sessionId !== owned.sessionId || entry.at !== owned.at
      || entry.terminal !== owned.terminal) return undefined
    return entry
  }

  const skipped = { error: 'The pane is no longer ready to close.' }

  async function markGone(owned: OwnedPane) {
    const result = await store.change(data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      saveClosed(data.owned, entry, now())
    })
    return result.error === undefined
  }

  async function close(owned: OwnedPane) {
    const { pane } = owned
    const processes = await herdr.processes(pane)
    if (processes.gone === true) return markGone(owned)
    if (disposed) return false
    const info = await herdr.info(pane)
    if (info.gone === true) return markGone(owned)
    if (disposed || !safeToClose(owned, info, processes)) return false

    const read = await herdr.read(pane)
    if (read.gone === true) return markGone(owned)
    if (read.error !== undefined || typeof read.text !== 'string') return false
    const { status, agent, session } = info
    const saved = await store.change(data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      entry.evidence = { text: read.text, status, agent, session }
    })
    if (saved.error !== undefined) return false

    const result = await store.change(async data => {
      const entry = current(data, owned)
      if (entry === undefined) return skipped
      // Keep wait and card changes queued from this check until herdr answers.
      const foreground = await herdr.processes(pane)
      if (disposed) return skipped
      const latest = await herdr.info(pane)
      if (disposed) return skipped
      if (latest.gone === true || foreground.gone === true) {
        saveClosed(data.owned, entry, now())
        return
      }
      if (!safeToClose(entry, latest, foreground) || latest.agent !== agent || latest.session !== session) return skipped
      const closed = await Promise.resolve().then(() => herdr.close(pane)).catch(error => ({ error: error?.message ?? String(error) }))
      if (closed.ok !== true && closed.gone !== true) {
        const error = closed.error ?? 'herdr could not close the pane.'
        const previous = warned.get(pane)
        if (previous?.terminal !== entry.terminal || previous?.error !== error) {
          warned.set(pane, { terminal: entry.terminal, error })
          warn('ds-bot-board: closing herdr pane %s failed: %s', pane, error)
        }
        return { error }
      }
      saveClosed(data.owned, entry, now())
    })
    return result.error === undefined
  }

  async function poll() {
    if (disposed || polling || store.readOnly()) return []
    polling = true
    const closed = []
    try {
      await roster.ready()
      for (const owned of Object.values<OwnedPane>(store.read().owned ?? {})) {
        if (disposed) break
        if (!eligible(store.read(), owned)) continue
        try {
          if (await close(owned)) {
            warned.delete(owned.pane)
            closed.push(owned.pane)
          }
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
