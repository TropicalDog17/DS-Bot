import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const electron = new URL('../node_modules/electron/', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', electron), 'utf8'))
const checksums = JSON.parse(readFileSync(new URL('checksums.json', electron), 'utf8'))

const root = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'electron')
  : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron')

mkdirSync(root, { recursive: true })
const file = join(root, `SHASUMS256.txt-${version}`)
writeFileSync(file, Object.entries(checksums).map(([name, sum]) => `${sum} *${name}\n`).join(''))
console.log(`${Object.keys(checksums).length} checksums of Electron ${version} in ${file}`)
