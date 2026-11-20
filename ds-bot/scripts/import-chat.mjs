#!/usr/bin/env node
// Usage: node scripts/import-chat.mjs <bot home> <botId> <OptChat store> [--replace]
// Writes the user's and the assistant's messages from an OptChat store (main/*.jsonl)
// as part 0 of the Bot's own chat, which read_own_chat searches. <bot home> is the
// ds-bot folder in DSH_HOME (DSH_HOME/bot). The store is only read.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fromOptChat, importedChatFile } from '../src/host/imported-chat.js'

const args = process.argv.slice(2)
const replace = args.includes('--replace')
const [home, botId, source] = args.filter(arg => arg !== '--replace')
if (!home || !botId || !source) {
  console.error('usage: import-chat.mjs <bot home> <botId> <OptChat store> [--replace]')
  process.exit(2)
}
const file = importedChatFile(home, botId)
if (existsSync(file) && !replace) {
  console.error(`${file} exists; pass --replace to write it again`)
  process.exit(1)
}
const rows = fromOptChat(source)
if (rows.length === 0) {
  console.error(`no messages in ${source}`)
  process.exit(1)
}
mkdirSync(dirname(file), { recursive: true })
// Written aside and renamed, so a read never sees half a file.
writeFileSync(`${file}.tmp`, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
renameSync(`${file}.tmp`, file)
console.log(JSON.stringify({ file, messages: rows.length, first: new Date(rows[0].time).toISOString(), last: new Date(rows.at(-1).time).toISOString() }))
