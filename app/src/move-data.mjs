import { basename, dirname, join, resolve } from 'node:path'
import { copyTree, disk, real, within } from './copy-tree.mjs'

export { copyReason } from './copy-tree.mjs'

const { existsSync, readdirSync, statSync } = disk
const { mkdir, rename, rm, rmdir, writeFile } = disk.promises

const LEFT_BEHIND = [/^bot[\\/]state\.lock$/u, /^\.import(-check)?-\d+$/u]
const MARK = '.ds-bot-moving'

export function installFolder(exe, platform = process.platform) {
  if (platform === 'darwin') {
    for (let at = dirname(exe); dirname(at) !== at; at = dirname(at)) if (at.endsWith('.app')) return at
  }
  return dirname(exe)
}

export function moveProblem(places) {
  const [from, to, dshHome] = [places.from, places.to, places.dshHome].map(real)
  const workspace = places.workspace === undefined ? undefined : real(places.workspace)
  const program = places.program === undefined ? undefined : real(places.program)
  if (dirname(to) === to) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (within(to, dshHome) || within(dshHome, to)) return 'dsh'
  if (program !== undefined && within(to, program)) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export async function copyData(from, to, signal) {
  const parent = dirname(resolve(to))
  await mkdir(parent, { recursive: true })
  const staging = new RegExp(`^\\.${escaped(basename(to))}\\.moving-\\d+$`, 'u')
  for (const name of readdirSync(parent).filter(entry => staging.test(entry) && existsSync(join(parent, entry, MARK)))) {
    await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 })
  }
  const stage = join(parent, `.${basename(to)}.moving-${String(Date.now())}`)
  await mkdir(stage)
  try {
    await writeFile(join(stage, MARK), '')
    await copyTree(from, stage, { as: to, leave: path => LEFT_BEHIND.some(pattern => pattern.test(path)), signal })
    signal?.throwIfAborted()
    if (existsSync(to)) await rmdir(to)
    await rename(stage, to)
  } catch (error) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 })
    throw error
  }
  await rm(join(to, MARK), { force: true })
}
