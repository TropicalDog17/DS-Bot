import { appendFileSync } from 'node:fs'

appendFileSync(process.argv[2], 'started\n')
await import('./fake-acp.mjs')
