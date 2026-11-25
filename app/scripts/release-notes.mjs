import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Fei2411/DS-Bot'
export const PACKAGES = [
  { file: 'win-x64.exe', system: '**Windows 10/11 (64-bit / 64 位)**', note: 'Double-click to install / 双击安装' },
  { file: 'mac-arm64.zip', system: 'macOS, Apple chip / Apple 芯片' },
  { file: 'mac-x64.zip', system: 'macOS, Intel' },
  { file: 'linux-x86_64.AppImage', system: 'Linux, AppImage' },
  { file: 'linux-amd64.deb', system: 'Linux, deb (Debian, Ubuntu)' },
  { file: 'android.apk', system: 'Android (phone app / 手机 App)' },
]
export const SUMS = 'SHA256SUMS.txt'
const START = '<!-- downloads -->'
const END = '<!-- /downloads -->'

export const packageName = (version, entry) => `DS-Bot-${version}-${entry.file}`
export const copyName = entry => `DS-Bot-${entry.file}`

export function missingPackages(version, names) {
  const have = new Set(names)
  return PACKAGES.map(entry => packageName(version, entry)).filter(name => !have.has(name))
}

export function formatSize(bytes) {
  return `${String(Math.max(1, Math.round(bytes / 1024 ** 2)))} MB`
}

export function releaseUrl({ repo = REPO, version, name }) {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`
}

function mirrorUrl(mirror, name) {
  return `${mirror.replace(/\/+$/u, '')}/${encodeURIComponent(name)}`
}

export function downloadBlock({ version, sizes, repo = REPO, mirror }) {
  const links = (name) => {
    const github = releaseUrl({ repo, version, name })
    return mirror ? `${name}: [Mirror / 国内镜像](${mirrorUrl(mirror, name)}) · [GitHub](${github})` : `[${name}](${github})`
  }
  const rows = PACKAGES.map((entry) => {
    const name = packageName(version, entry)
    const system = entry.note === undefined ? entry.system : `${entry.system}<br>${entry.note}`
    return `| ${system} | ${links(name)} | ${formatSize(sizes[name])} |`
  })
  const sums = releaseUrl({ repo, version, name: SUMS })
  return [
    START,
    '## Download / 下载',
    '',
    '| System / 系统 | Download / 下载 | Size / 大小 |',
    '|---|---|---|',
    ...rows,
    '',
    'The `.blockmap`, `latest*.yml` and `ds-bot-*.tgz` files and the source code archives are for updates and the plugin: you do not need to download them.',
    '',
    '`.blockmap`、`latest*.yml`、`ds-bot-*.tgz` 和源代码是给自动更新和插件用的，不用下载。',
    '',
    `To check a download, compare its SHA-256 with [${SUMS}](${sums}). / 下载后可以用 [${SUMS}](${sums}) 核对 SHA-256。`,
    END,
  ].join('\n')
}

export function checksums(version, hashes) {
  const lines = PACKAGES.flatMap((entry) => {
    const hash = hashes[packageName(version, entry)]
    return [`${hash}  ${packageName(version, entry)}`, `${hash}  ${copyName(entry)}`]
  })
  return `${lines.join('\n')}\n`
}

export function withDownloads(notes, block) {
  const start = notes.indexOf(START)
  const end = notes.indexOf(END, start)
  const rest = start === -1 || end === -1 ? notes : notes.slice(0, start) + notes.slice(end + END.length)
  const body = rest.trim()
  return body === '' ? `${block}\n` : `${block}\n\n${body}\n`
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function main([version, from, to, notesFile]) {
  if (!version || !from || !to) {
    console.error('release-notes: usage: node scripts/release-notes.mjs <version> <folder with the packages> <folder for the files to attach> [<current notes>]')
    process.exit(2)
  }
  const missing = missingPackages(version, readdirSync(from))
  if (missing.length > 0) {
    console.error(`release-notes: ${from} has no ${missing.join(', ')}`)
    process.exit(1)
  }
  mkdirSync(to, { recursive: true })
  const sizes = {}
  const hashes = {}
  for (const entry of PACKAGES) {
    const name = packageName(version, entry)
    sizes[name] = statSync(join(from, name)).size
    hashes[name] = await sha256(join(from, name))
    copyFileSync(join(from, name), join(to, copyName(entry)))
  }
  writeFileSync(join(to, SUMS), checksums(version, hashes))
  const block = downloadBlock({ version, sizes, repo: process.env.GITHUB_REPOSITORY || REPO, mirror: process.env.MIRROR_BASE || undefined })
  process.stdout.write(withDownloads(notesFile === undefined ? '' : readFileSync(notesFile, 'utf8'), block))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
