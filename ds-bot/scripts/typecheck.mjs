// Type-check ds-bot's TypeScript modules using tsc from ds-bot, ../link, or DSH_HARNESS.
// Usage: npm run typecheck [-- <tsc options>]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
const candidates = [
  join(plugin, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(plugin, '..', 'link', 'node_modules', 'typescript', 'bin', 'tsc'),
  process.env.DSH_HARNESS ? join(process.env.DSH_HARNESS, 'node_modules', 'typescript', 'bin', 'tsc') : undefined,
]
const bin = candidates.filter(Boolean).find(existsSync)
if (!bin) {
  console.error('typecheck: no tsc found; run `npm ci --prefix ../link` or install typescript')
  process.exit(2)
}
const result = spawnSync(process.execPath, [bin, '-p', 'tsconfig.json', ...process.argv.slice(2)], {
  cwd: plugin,
  stdio: 'inherit',
})
if (result.error) console.error(`typecheck: ${result.error.message}`)
process.exit(result.status ?? 1)
