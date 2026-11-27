import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FILE_VIEW_MAX = 256 * 1024

const failure = (message, code) => Object.assign(new Error(message), { code })

// A link target as a Bot writes it: an absolute path or a file:// URL, maybe with a line anchor.
export function pathOfLink(target) {
  const bare = String(target ?? '').trim().replace(/#L\d+(?:-L\d+)?$/, '')
  let path = bare
  if (/^file:\/\//i.test(bare)) {
    try { path = fileURLToPath(bare) } catch { return undefined }
  } else {
    try { path = decodeURIComponent(bare) } catch { /* a bare % stays as written */ }
  }
  return isAbsolute(path) ? path : undefined
}

export async function readTextFile(path, { isData, max = FILE_VIEW_MAX }) {
  const real = await realpath(path).catch(() => undefined)
  if (real === undefined) throw failure('File not found', 'bot/not-found')
  if (await isData(real)) throw failure('That file is in the team\'s data', 'bot/forbidden')
  const handle = await open(real, 'r').catch(() => undefined)
  if (handle === undefined) throw failure('File not found', 'bot/not-found')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw failure('Not a file', 'bot/invalid')
    const length = Math.min(info.size, max)
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw failure('Not a text file', 'bot/invalid')
    return { name: basename(real), path: real, text: new TextDecoder().decode(bytes), size: info.size, truncated: info.size > bytesRead }
  } finally {
    await handle.close()
  }
}
