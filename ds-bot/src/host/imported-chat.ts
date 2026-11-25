import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const IMPORTED_PART = 0

export const importedChatFile = (home, botId) => join(home, 'imported-chat', `${botId}.jsonl`)
export const importedSession = botId => `import:${botId}`

export function parseImportedChat(text) {
  const rows = []
  text.split('\n').forEach((line, n) => {
    if (line.trim() === '') return
    let row
    try { row = JSON.parse(line) } catch { throw new Error(`imported chat: bad JSON at line ${n + 1}`) }
    if (!Number.isInteger(row.seq) || !Number.isFinite(row.time) || (row.who !== 'user' && row.who !== 'you') || typeof row.text !== 'string') {
      throw new Error(`imported chat: invalid message at line ${n + 1}`)
    }
    rows.push(row)
  })
  return rows.sort((a, b) => a.seq - b.seq)
}

export function fromOptChat(dir) {
  const main = join(dir, 'main')
  if (!existsSync(main)) throw new Error(`no OptChat store at ${dir}: main/ is missing`)
  const rows = []
  for (const name of readdirSync(main).filter(file => file.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(main, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line)
      const who = row.kind === 'user' ? 'user' : row.kind === 'talk' ? 'you' : undefined
      const time = Date.parse(row.date)
      if (who === undefined || !Number.isInteger(row.i) || !Number.isFinite(time) || typeof row.text !== 'string' || row.text.trim() === '') continue
      rows.push({ seq: row.i, time, who, text: row.text })
    }
  }
  return rows.sort((a, b) => a.seq - b.seq)
}

export function importedChatReader(rt) {
  const cache = new Map()
  return function importedChat(botId) {
    const file = importedChatFile(rt.home, botId)
    let stat
    try { stat = statSync(file) } catch { cache.delete(botId); return undefined }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const kept = cache.get(botId)
    if (kept?.stamp === stamp) return kept.chat
    let chat
    try {
      const rows = parseImportedChat(readFileSync(file, 'utf8'))
      chat = rows.length === 0 ? undefined : { rows, stamp, part: { sessionId: importedSession(botId), number: IMPORTED_PART, imported: true, startedAt: rows[0].time, endedAt: rows.at(-1).time } }
    } catch (error) {
      rt.warn('ds-bot: imported chat of %s is unreadable: %s', botId, error?.message ?? error)
      chat = undefined
    }
    cache.set(botId, { stamp, chat })
    return chat
  }
}
