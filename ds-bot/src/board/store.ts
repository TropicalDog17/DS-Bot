import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homeLock } from '../host/home-lock.ts'

export const READ_ONLY = 'The board is open in another dsh on this data; it is read-only here.'
const EMPTY = (): { version: number; cards: Record<string, any>; settings?: any; waits?: Record<string, any> } => ({ version: 1, cards: {} })

const clean = (parsed) => {
  const data = EMPTY()
  const cards = parsed?.cards
  if (cards !== null && typeof cards === 'object' && !Array.isArray(cards)) {
    for (const [id, card] of Object.entries<any>(cards)) {
      if (card !== null && typeof card === 'object' && card.id === id) data.cards[id] = card
    }
  }
  const settings = parsed?.settings
  if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) data.settings = settings
  const waits = parsed?.waits
  if (waits !== null && typeof waits === 'object' && !Array.isArray(waits)) {
    for (const [id, wait] of Object.entries<any>(waits)) {
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

export function openBoardStore(file, { warn = (() => {}) as any, lock = homeLock(join(dirname(file), 'board.lock')) }: any = {}) {
  mkdirSync(dirname(file), { recursive: true })
  let data = EMPTY()
  let seen = ''
  const stamp = () => {
    try { const { mtimeMs, size } = statSync(file); return `${mtimeMs}:${size}` } catch { return '' }
  }
  const refresh = () => {
    const now = stamp()
    if (now === seen) return
    seen = now
    if (now === '') { data = EMPTY(); return }
    try {
      data = clean(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      const aside = `${file}.broken-${Date.now()}`
      try { copyFileSync(file, aside) } catch {}
      warn('ds-bot-board: unreadable %s (%s); kept as %s', file, error?.message ?? error, aside)
      data = EMPTY()
    }
  }
  const writable = () => {
    try { return lock.claim() === undefined } catch (error) {
      warn('ds-bot-board: cannot lock %s: %s', file, error?.message ?? error)
      return true
    }
  }
  let queue = Promise.resolve()
  return {
    file,
    read() { refresh(); return data },
    readOnly: () => !writable(),
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
