import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Electron's fs takes every path that ends in .asar for an archive: a file that is none cannot be
// read, one that is looks like a folder and stays locked on Windows, and a name that is not there
// yet is an error that fs.cp stops at. original-fs is the disk as it is, but for a recursive
// readdir, which still goes through Electron; plain Node has only fs.
export const disk = process.getBuiltinModule('original-fs') ?? process.getBuiltinModule('node:fs')
const { existsSync, realpathSync } = disk
const { cp, lstat, readlink, realpath, stat, symlink } = disk.promises

export const within = (inner, outer) => {
  const path = relative(resolve(outer), resolve(inner))
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && !/^[a-z]:/iu.test(path))
}

export function copyReason(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'EBUSY') return 'inUse'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'full'
  return 'other'
}

export function real(path) {
  const rest = []
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) return resolve(path)
    rest.unshift(basename(at))
    at = up
  }
  return join(realpathSync.native(at), ...rest)
}

async function relink(source, path, roots, to) {
  const text = (await readlink(source)).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '')
  const written = resolve(dirname(source), text)
  const physical = await realpath(written).catch(() => written)
  const direct = roots.some(folder => within(written, folder))
  const target = direct ? written : physical
  const root = roots.find(folder => within(target, folder))
  const folder = (await stat(source).catch(() => undefined))?.isDirectory() === true
  const windows = process.platform === 'win32'
  const inside = root === undefined ? written : join(to, relative(root, target))
  await symlink(direct && !isAbsolute(text) && !(windows && folder) ? text : inside, path, folder ? (windows ? 'junction' : 'dir') : 'file')
}

export async function copyTree(from, into, { force = true, skip = false, leave = () => false, as = into, signal, seen } = {}) {
  const origin = real(from)
  const links = []
  const skipped = []
  await cp(origin, into, {
    recursive: true,
    force,
    filter: async (source) => {
      signal?.throwIfAborted()
      const path = relative(origin, source)
      if (path !== '' && leave(path)) return false
      if (path === '') return true
      const info = await lstat(source).catch((error) => { if (!skip) throw error })
      if (info === undefined) skipped.push(path)
      else if (info.isSymbolicLink()) links.push(path)
      else if (info.isFile()) seen?.(info.size)
      return info?.isSymbolicLink() === false
    },
  })
  const roots = [...new Set([resolve(from), origin])]
  for (const path of links) {
    signal?.throwIfAborted()
    const at = join(into, path)
    if (!force && await lstat(at).then(() => true, () => false)) continue
    await relink(join(origin, path), at, roots, resolve(as)).catch((error) => {
      if (!skip) throw error
      skipped.push(path)
    })
  }
  return skipped
}
