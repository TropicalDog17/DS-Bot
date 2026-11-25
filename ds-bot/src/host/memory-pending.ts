import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const PENDING_FILE = 'pending.json'
const PENDING = 'memory/pending'
const MAX_BYTES = 1_048_576

export function pendingPath(root) {
  return join(root, PENDING_FILE)
}

export function inside(root, path) {
  const base = resolve(root)
  const full = resolve(base, path)
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`the path ${path} is outside the memory folder`)
  return full
}

export function relativePath(root, path) {
  return relative(resolve(root), resolve(path)).split(sep).join('/')
}

export function record({ id, time, op, scope, steps, row }) {
  return { id, time, op, scope, steps, row: { time, id, ...row } }
}

export function serialize(record) {
  const text = JSON.stringify(record)
  const size = Buffer.byteLength(text)
  if (size > MAX_BYTES) {
    throw Object.assign(new Error(`The memory change is too large to record (${size} of ${MAX_BYTES} bytes). Make the memory file smaller first.`), { code: 'memory/too-large' })
  }
  return text
}

export function read(root) {
  const path = pendingPath(root)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw Object.assign(new Error(`${PENDING_FILE} could not be read (${error?.code ?? error?.message})`), { code: PENDING })
  }
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw Object.assign(new Error(`${PENDING_FILE} is larger than a memory change record`), { code: PENDING })
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw Object.assign(new Error(`${PENDING_FILE} is not readable (${error.message})`), { code: PENDING })
  }
  if (!wellFormed(value)) throw Object.assign(new Error(`${PENDING_FILE} is not a memory change record`), { code: PENDING })
  return value
}

const wellFormed = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.op !== 'string' || typeof value.scope !== 'string') return false
  if (!Array.isArray(value.steps) || value.steps.length === 0) return false
  if (!value.steps.every(step => step !== null && typeof step === 'object' && typeof step.path === 'string' && step.path !== ''
    && (step.action === 'remove' ? step.text === undefined : step.action === 'write' && typeof step.text === 'string'))) return false
  if (value.row === null || typeof value.row !== 'object' || Array.isArray(value.row)) return false
  return typeof value.row.id === 'string' && value.row.id !== ''
}
