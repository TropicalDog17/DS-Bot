import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { disk, real, within } from './copy-tree.mjs'

const { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statfsSync, statSync, writeFileSync } = disk

export const DATA_DIR = 'data'
export const WORKSPACE_DIR = 'workspace'
export const LAYER = 'DS Bot'

export function freeSpace(path) {
  let at = resolve(path)
  for (;;) {
    if (existsSync(at)) {
      try {
        const stats = statfsSync(at)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch {
        return undefined
      }
    }
    const up = dirname(at)
    if (up === at) return undefined
    at = up
  }
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  const gb = bytes / 2 ** 30
  if (gb >= 10) return `${String(Math.floor(gb))} GB`
  if (gb >= 1) return `${(Math.floor(gb * 10) / 10).toFixed(1)} GB`
  if (bytes < 2 ** 20) return 'under 1 MB'
  return `${String(Math.floor(bytes / 2 ** 20))} MB`
}

export const LOW_SHARE = 0.2

export function runningLow(free, freeAtStart) {
  return Number.isFinite(free) && Number.isFinite(freeAtStart) && freeAtStart > 0 && free <= freeAtStart * LOW_SHARE
}

export function driveOf(path) {
  const match = /^([A-Za-z]):[\\/]/u.exec(resolve(path))
  return match ? match[1].toUpperCase() : undefined
}

export function shortPath(path, home = homedir()) {
  const full = resolve(path)
  const base = resolve(home)
  if (full === base) return '~'
  return within(full, base) ? `~${sep}${full.slice(base.length).replace(/^[\\/]+/u, '')}` : full
}

export function placeOf(dataDir, { home = homedir(), free } = {}) {
  const drive = driveOf(dataDir)
  const place = drive === undefined ? { path: shortPath(dataDir, home) } : { drive }
  const text = formatBytes(free)
  return text === undefined ? place : { ...place, free: text }
}

export function currentRootOf(dataDir, workspace) {
  if (typeof dataDir !== 'string' || typeof workspace !== 'string') return undefined
  const root = dirname(resolve(dataDir))
  if (basename(resolve(dataDir)) !== DATA_DIR || basename(resolve(workspace)) !== WORKSPACE_DIR || dirname(resolve(workspace)) !== root) return undefined
  return root
}

export const pickFrom = dataDir => dirname(resolve(dataDir))

export function isEmptyTree(folder) {
  try {
    if (!statSync(folder).isDirectory()) return false
    return readdirSync(folder).every(name => isEmptyTree(join(folder, name)))
  } catch {
    return false
  }
}

const ownEmpty = folder => readdirSync(folder).every(name => [DATA_DIR, WORKSPACE_DIR].includes(name) && isEmptyTree(join(folder, name)))

function inOneDrive(path, env) {
  const roots = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map(name => env[name]).filter(value => typeof value === 'string' && value !== '')
  if (roots.some(root => within(path, real(root)))) return true
  const parts = path.split(/[\\/]/u)
  return parts.some((part, k) => part === 'OneDrive' || part.startsWith('OneDrive - ') || (parts[k - 1] === 'CloudStorage' && part.startsWith('OneDrive-')))
}

const sameFolder = (a, b) => within(a, b) && within(b, a)

export function rootOf(picked, { dshHome, program, env = process.env, probe = true, current } = {}) {
  const chosen = resolve(picked)
  const places = root => ({ root, dataDir: join(root, DATA_DIR), workspace: join(root, WORKSPACE_DIR) })
  try {
    const data = typeof current?.dataDir === 'string' ? real(current.dataDir) : undefined
    const workspace = typeof current?.workspace === 'string' && existsSync(current.workspace) && !isEmptyTree(current.workspace) ? real(current.workspace) : undefined
    const now = [data, workspace].filter(path => path !== undefined)
    const nowRoot = currentRootOf(current?.dataDir, current?.workspace)
    const physicalChosen = real(chosen)
    if ([data, nowRoot === undefined ? undefined : real(nowRoot)].some(path => path !== undefined && sameFolder(physicalChosen, path))) return { same: true }
    if (now.some(path => within(physicalChosen, path))) return { ...places(chosen), added: false, reason: 'nested', at: chosen }
    const isDrive = parse(chosen).root === chosen
    let root = chosen
    let added = false
    if (isDrive) {
      root = join(chosen, LAYER)
      added = true
    } else if (existsSync(chosen)) {
      if (!statSync(chosen).isDirectory()) return { ...places(root), added, reason: 'foreign', at: chosen }
      if (readdirSync(chosen).length > 0 && !ownEmpty(chosen)) {
        root = join(chosen, LAYER)
        added = true
      }
    }
    const result = { ...places(root), added }
    const reject = (reason, at = root) => ({ ...result, reason, at })
    if (added && existsSync(root) && (!statSync(root).isDirectory() || (readdirSync(root).length > 0 && !ownEmpty(root)))) return reject('foreign')
    const physical = real(root)
    if (now.some(path => within(physical, path) || within(path, physical))) return reject('nested', chosen)
    if (inOneDrive(physical, env)) return reject('onedrive', chosen)
    if (dshHome !== undefined && existsSync(dshHome)) {
      const dsh = real(dshHome)
      if (within(physical, dsh) || within(dsh, physical)) return reject('dsh', chosen)
    }
    if (program !== undefined && within(physical, real(program))) return reject('program', chosen)
    if (probe && !canWrite(result.dataDir)) return reject('permission', chosen)
    return result
  } catch {
    return { ...places(chosen), added: false, reason: 'permission', at: chosen }
  }
}

function canWrite(folder) {
  const made = []
  try {
    for (let at = resolve(folder); !existsSync(at); at = dirname(at)) {
      made.unshift(at)
      if (dirname(at) === at) break
    }
    mkdirSync(folder, { recursive: true })
    const file = join(folder, '.ds-bot-write-check')
    writeFileSync(file, '')
    rmSync(file)
    return true
  } catch {
    return false
  } finally {
    for (const at of [...made].reverse()) { try { rmdirSync(at) } catch { /* not empty: left as it is */ } }
  }
}
