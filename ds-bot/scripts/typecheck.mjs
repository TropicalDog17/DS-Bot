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
const extra = process.argv.slice(2)
for (const project of ['tsconfig.json', 'tsconfig.strict.json']) {
  const result = spawnSync(process.execPath, [bin, '-p', project, ...extra], {
    cwd: plugin,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`typecheck: ${result.error.message}`)
    process.exit(1)
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}
