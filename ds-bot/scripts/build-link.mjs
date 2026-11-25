import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'link.js')

export async function bundleLink() {
  const result = await build({
    absWorkingDir: join(PLUGIN, '..', 'link'),
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'inline',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return `// Generated from ../link/src by \`npm run build\` (scripts/build-link.mjs). Do not edit by hand.\n${result.outputFiles[0].text}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleLink()
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch {}
    if (current !== next) {
      console.error('link.js is stale: run `npm run build` in ds-bot and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
  }
}
