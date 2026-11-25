import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOG_LIMIT = 2 * 1024 * 1024
export const LOG_FILES = 3
const PARTIAL_MAX = 8 * 1024

export const logNames = (count = LOG_FILES) => Array.from({ length: count }, (_, index) => (index === 0 ? 'main.log' : `main.${String(index)}.log`))

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function redactor({ home = homedir(), platform = process.platform } = {}) {
  const parts = home.split(/[\\/]+/u).filter(Boolean)
  const lead = /^[\\/]/u.test(home) ? '[\\\\/]' : ''
  const homePattern = parts.length > 0 ? new RegExp(`${lead}${parts.map(escape).join('[\\\\/]+')}(?=[\\\\/\\s"'\`<>|:;,)\\]}]|$)`, platform === 'win32' ? 'giu' : 'gu') : undefined
  const label = platform === 'win32' ? '%USERPROFILE%' : '~'
  return (text) => {
    let out = text
      .replace(/(token=)[^&\s"'<>]+/giu, '$1<hidden>')
      .replace(/(\/oauth\/callback)\?[^\s"'<>]+/gu, '$1?<hidden>')
      .replace(/\bsk-[A-Za-z0-9][\w-]*/gu, 'sk-<hidden>')
      .replace(/\b(Bearer\s+)[\w.~+/=-]+/gu, '$1<hidden>')
    if (homePattern !== undefined) out = out.replace(homePattern, label)
    return out
  }
}

export function splitLines(rest, chunk) {
  const pieces = (rest + chunk).split(/\r?\n/u)
  let tail = pieces.pop() ?? ''
  const lines = pieces.map(line => line.replace(/\r/gu, ''))
  if (tail.length > PARTIAL_MAX) {
    lines.push(tail.replace(/\r/gu, ''))
    tail = ''
  }
  return { lines, rest: tail }
}

export const shouldRotate = (size, add, limit = LOG_LIMIT) => size > 0 && size + add > limit

export function rotate(dir, count = LOG_FILES) {
  const names = logNames(count)
  for (let index = names.length - 1; index > 0; index -= 1) {
    try {
      renameSync(join(dir, names[index - 1]), join(dir, names[index]))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function tailLines(text, count) {
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count)
}

export class LogFile {
  #dir
  #file
  #fd
  #size = 0
  #limit
  #redact
  #now
  #rests = new Map()
  #broken = false

  constructor({ dir, limit = LOG_LIMIT, redact = redactor(), now = () => new Date() }) {
    this.#dir = dir
    this.#file = join(dir, logNames()[0])
    this.#limit = limit
    this.#redact = redact
    this.#now = now
  }

  get dir() { return this.#dir }

  write(source, chunk) {
    const { lines, rest } = splitLines(this.#rests.get(source) ?? '', String(chunk))
    this.#rests.set(source, rest)
    for (const line of lines) this.#line(source, line)
  }

  flush() {
    for (const [source, rest] of this.#rests) if (rest !== '') this.#line(source, rest)
    this.#rests.clear()
  }

  tail(count) {
    this.flush()
    const texts = []
    for (const name of logNames()) {
      try {
        texts.unshift(readFileSync(join(this.#dir, name), 'utf8'))
      } catch {
        break
      }
      if (tailLines(texts.join(''), count).length >= count) break
    }
    return tailLines(texts.join(''), count).map(this.#redact)
  }

  close() {
    this.flush()
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }

  #line(source, line) {
    if (this.#broken) return
    const text = `${this.#now().toISOString()} [${source}] ${this.#redact(line)}\n`
    const bytes = Buffer.byteLength(text)
    try {
      if (this.#fd === undefined) this.#open()
      if (shouldRotate(this.#size, bytes, this.#limit)) {
        closeSync(this.#fd)
        this.#fd = undefined
        try { rotate(this.#dir) } catch { /* kept */ }
        this.#open()
      }
      writeSync(this.#fd, text)
      this.#size += bytes
    } catch {
      this.#broken = true
    }
  }

  #open() {
    mkdirSync(this.#dir, { recursive: true })
    this.#fd = openSync(this.#file, 'a')
    this.#size = statSync(this.#file).size
  }
}

export function captureStdio(log, streams = { stdout: process.stdout, stderr: process.stderr }) {
  const raw = {}
  for (const [name, stream] of Object.entries(streams)) {
    const write = stream.write.bind(stream)
    raw[name] = (text) => { try { write(text) } catch { /* no console */ } }
    stream.write = (chunk, encoding, callback) => {
      log.write('main', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'))
      try {
        return write(chunk, encoding, callback)
      } catch {
        // A packaged app on Windows can have no console behind stdout.
        return true
      }
    }
  }
  return raw
}
