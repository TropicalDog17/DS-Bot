// The board's own file: <DSH_HOME>/bot-board/board.json, apart from the team's
// state.json. Writes are whole-file and atomic (a temp file, fsync, rename), queued in
// this process, and taken only while this process holds board.lock: dsh Web and dsh
// Desktop share one home, and the second host reads the board without writing it.
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homeLock } from '../host/home-lock.js'

export const READ_ONLY = 'The board is open in another dsh on this data; it is read-only here.'
const EMPTY = () => ({ version: 1, cards: {} })

const clean = (parsed) => {
  const data = EMPTY()
  const cards = parsed?.cards
  if (cards !== null && typeof cards === 'object' && !Array.isArray(cards)) {
    for (const [id, card] of Object.entries(cards)) {
      if (card !== null && typeof card === 'object' && card.id === id) data.cards[id] = card
    }
  }
  const settings = parsed?.settings
  if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) data.settings = settings
  // The Bots' waits on herdr panes (waits.js), by id.
  const waits = parsed?.waits
  if (waits !== null && typeof waits === 'object' && !Array.isArray(waits)) {
    for (const [id, wait] of Object.entries(waits)) {
      if (wait !== null && typeof wait === 'object' && wait.id === id && typeof wait.pane === 'string' && typeof wait.botId === 'string' && Array.isArray(wait.until)) (data.waits ??= {})[id] = wait
    }
  }
  return data
}

export async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export function openBoardStore(file, { warn = () => {}, lock = homeLock(join(dirname(file), 'board.lock')) } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  let data = EMPTY()
  let seen = ''
  const stamp = () => {
    try { const { mtimeMs, size } = statSync(file); return `${mtimeMs}:${size}` } catch { return '' }
  }
  // Re-read when the file changed under this process (the other host wrote it).
  const refresh = () => {
    const now = stamp()
    if (now === seen) return
    seen = now
    if (now === '') { data = EMPTY(); return }
    try {
      data = clean(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      // A board that does not parse is kept aside, never overwritten in place.
      const aside = `${file}.broken-${Date.now()}`
      try { copyFileSync(file, aside) } catch {}
      warn('ds-bot-board: unreadable %s (%s); kept as %s', file, error?.message ?? error, aside)
      data = EMPTY()
    }
  }
  const writable = () => {
    try { return lock.claim() === undefined } catch (error) {
      // An unusable lock (a read-only file system) must not stop the board.
      warn('ds-bot-board: cannot lock %s: %s', file, error?.message ?? error)
      return true
    }
  }
  let queue = Promise.resolve()
  return {
    file,
    read() { refresh(); return data },
    readOnly: () => !writable(),
    // fn gets a copy of the board to change and returns a result; { error } discards
    // the copy. One change at a time.
    change(fn) {
      const run = queue.then(async () => {
        if (!writable()) return { error: READ_ONLY }
        refresh()
        const draft = structuredClone(data)
        const result = await fn(draft)
        if (result?.error !== undefined) return result
        await writeAtomic(file, `${JSON.stringify(draft, null, 1)}\n`)
        data = draft
        seen = stamp()
        return result ?? {}
      })
      queue = run.catch(() => {})
      return run
    },
    dispose: () => lock.release(),
  }
}
