import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paneTarget } from './cards.ts'

const PANE_ID = /\bw[0-9A-Za-z]+:p[0-9A-Za-z]+\b/g
const HERDR = /\bherdr\b/
const CLOSES = /\bpane\s+close\b/
export const PANE_LINES = 200
export const PANE_TEXT_MAX = 20_000
const READ_TIMEOUT_MS = 4000

export function panesIn(command) {
  const text = typeof command === 'string' ? command : ''
  if (!HERDR.test(text) || CLOSES.test(text)) return []
  return [...new Set(text.match(PANE_ID) ?? [])]
}

// The binary: config.herdr, else the user's ~/.local/bin/herdr when it is there (a
// service's PATH often lacks it), else herdr on the PATH.
export function herdrBinary(config: any = {}, home = homedir()) {
  if (typeof config.herdr === 'string' && config.herdr !== '') return config.herdr
  const local = join(home, '.local', 'bin', 'herdr')
  return existsSync(local) ? local : 'herdr'
}

const run = (file, args): Promise<any> => new Promise((resolve) => {
  execFile(file, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: error?.code === 'ENOENT' })
  })
})

const parsed = (text) => {
  try { return JSON.parse(text) } catch { return undefined }
}

const tail = (text, max) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`)

export function createHerdr({ binary = 'herdr', exec = run }: any = {}) {
  return {
    async read(target) {
      const pane = paneTarget(target)
      if (pane === undefined) return { error: 'Not a pane.' }
      const [read, got] = await Promise.all([
        exec(binary, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(PANE_LINES)]),
        exec(binary, ['pane', 'get', pane]),
      ])
      if (read.missing) return { error: 'herdr is not installed here.' }
      if (!read.ok) {
        const error = parsed(read.stdout)?.error ?? parsed(read.stderr)?.error
        const gone = typeof error?.code === 'string' && error.code.endsWith('not_found')
        return { error: error?.message ?? (read.stderr.trim() || 'herdr could not read the pane.'), ...(gone ? { gone: true } : {}) }
      }
      const info = got.ok ? parsed(got.stdout)?.result?.pane : undefined
      const status = typeof info?.agent_status === 'string' ? info.agent_status : undefined
      const title = typeof info?.terminal_title_stripped === 'string' ? info.terminal_title_stripped.trim() : undefined
      return { text: tail(read.stdout.replace(/\s+$/, ''), PANE_TEXT_MAX), ...(status ? { status } : {}), ...(title ? { title } : {}) }
    },
    async status(target) {
      const pane = paneTarget(target)
      if (pane === undefined) return { error: 'Not a pane.' }
      const got = await exec(binary, ['pane', 'get', pane])
      if (got.missing) return { error: 'herdr is not installed here.' }
      if (!got.ok) {
        const error = parsed(got.stdout)?.error ?? parsed(got.stderr)?.error
        const gone = typeof error?.code === 'string' && error.code.endsWith('not_found')
        return { error: error?.message ?? (got.stderr.trim() || 'herdr could not get the pane.'), ...(gone ? { gone: true } : {}) }
      }
      const status = parsed(got.stdout)?.result?.pane?.agent_status
      return typeof status === 'string' ? { status } : {}
    },
  }
}
