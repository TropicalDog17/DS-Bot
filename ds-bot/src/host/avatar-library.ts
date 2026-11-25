import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { avatarBytes } from './avatar.ts'
import { replaceFile } from './files.ts'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const HASH = /^[0-9a-f]{64}$/
const MAX_PHOTOS = 500
const MAX_LISTED = 48

export function install(rt) {
  const root = typeof rt.home === 'string' ? join(rt.home, 'avatars') : undefined
  const files = root === undefined ? undefined : join(root, 'files')
  const indexPath = root === undefined ? undefined : join(root, 'index.json')

  const fileOf = entry => join(files, `${entry.id}.${EXTENSIONS[entry.mime]}`)

  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => {}, () => {})
    return run
  }

  const readIndex = async () => {
    if (indexPath === undefined) return []
    let parsed
    try { parsed = JSON.parse(await readFile(indexPath, 'utf8')) } catch { return [] }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return items
      .filter(entry => typeof entry?.id === 'string' && HASH.test(entry.id) && EXTENSIONS[entry.mime] !== undefined)
      .map(entry => ({
        id: entry.id,
        name: String(entry.name ?? '').slice(0, 120),
        mime: entry.mime,
        bytes: Number(entry.bytes) || 0,
        createdAt: Number(entry.createdAt) || 0,
      }))
  }

  const writeIndex = async (items) => {
    await mkdir(root, { recursive: true })
    const temp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
    await replaceFile(temp, indexPath)
  }

  const writeImage = async (entry, bytes) => {
    await mkdir(files, { recursive: true })
    const path = fileOf(entry)
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, bytes)
    await replaceFile(temp, path)
  }

  const there = async path => stat(path).then(() => true, () => false)

  const importPhotos = (items) => serial(async () => {
    if (root === undefined) throw new Error('This host keeps no Bot data folder, so it has no avatar library.')
    const index = await readIndex()
    const result = { imported: [], duplicates: [], failed: [] }
    for (const item of items) {
      const name = String(item?.name ?? '').trim().slice(0, 120)
      try {
        const { bytes, mime } = avatarBytes(item?.image)
        const id = createHash('sha256').update(bytes).digest('hex')
        const known = index.find(entry => entry.id === id)
        if (known) {
          if (!await there(fileOf(known))) await writeImage(known, bytes)
          result.duplicates.push({ id: known.id, name: known.name })
          continue
        }
        if (index.length >= MAX_PHOTOS) throw new Error(`The avatar library holds at most ${MAX_PHOTOS} photos.`)
        const entry = { id, name: name || 'photo', mime, bytes: bytes.length, createdAt: Date.now() }
        await writeImage(entry, bytes)
        await writeIndex([...index, entry])
        index.push(entry)
        result.imported.push(entry)
      } catch (error) {
        result.failed.push({ name, message: error?.message ?? String(error) })
      }
    }
    return result
  })

  const libraryView = async ({ offset = 0, limit = MAX_LISTED } = {}) => {
    const index = await readIndex()
    const ordered = [...index].reverse().sort((a, b) => b.createdAt - a.createdAt)
    const start = Math.max(0, Math.floor(Number(offset)) || 0)
    const count = Math.min(MAX_LISTED, Math.max(1, Math.floor(Number(limit)) || MAX_LISTED))
    const items = []
    const page = ordered.slice(start, start + count)
    for (const entry of page) {
      const bytes = await readFile(fileOf(entry)).catch(() => undefined)
      if (bytes === undefined) continue
      items.push({ ...entry, image: `data:${entry.mime};base64,${bytes.toString('base64')}` })
    }
    return { items, total: ordered.length, next: start + page.length }
  }

  const deletePhoto = (id) => serial(async () => {
    const index = await readIndex()
    const entry = index.find(item => item.id === id)
    if (entry === undefined) return false
    await writeIndex(index.filter(item => item.id !== id))
    await rm(fileOf(entry), { force: true })
    return true
  })

  Object.assign(rt, { avatarLibraryView: libraryView, avatarLibraryImport: importPhotos, avatarLibraryDelete: deletePhoto })
}
