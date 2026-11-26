import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paneTarget } from './cards.ts'

const PANE_ID = /\bw[0-9A-Za-z]+:p[0-9A-Za-z]+\b/g
const EXACT_PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/
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

const herdrPath = String.raw`(?:[\w./~-]+/)?herdr`
const herdrAlias = new RegExp(String.raw`^([A-Za-z_]\w*)=${herdrPath}[ \t]*;[ \t]*\$(?:\1|\{\1\})(?=[ \t])`)
const createCommand = new RegExp(String.raw`^${herdrPath}[ \t]+(tab[ \t]+create|workspace[ \t]+create|pane[ \t]+split)(?:[ \t]+(?:[^\s;&|<>()$\x60'"\\]|'[^'\r\n]*'|"[^"\r\n$\x60\\]*")+)*$`)
const isPaneId = target => typeof target === 'string' && EXACT_PANE_ID.test(target)

export function paneCreation(command: string) {
  const match = createCommand.exec(command.trim().replace(herdrAlias, 'herdr'))
  return match?.[1].replace(/[ \t]+/, ' ')
}

export function createdPane(command: string, output: string) {
  const creation = paneCreation(command)
  if (creation === undefined) return undefined
  const response = parsed(output.trim().replace(/\r?\n\[Command finished with exit code 0\]$/, ''))
  if (response?.error !== undefined) return undefined
  const result = response?.result
  const pane = creation === 'pane split'
    ? (response?.id === 'cli:pane:split' ? result?.pane?.pane_id : undefined)
    : (result?.type === `${creation.split(' ')[0]}_created` ? result.root_pane?.pane_id : undefined)
  return isPaneId(pane) ? pane : undefined
}

function cliError(response, fallback) {
  if (response.missing) return { error: 'herdr is not installed here.' }
  const error = parsed(response.stdout)?.error ?? parsed(response.stderr)?.error
  const gone = typeof error?.code === 'string' && error.code.endsWith('not_found')
  return { error: error?.message ?? (response.stderr?.trim() || fallback), ...(gone ? { gone: true } : {}) }
}

const tail = (text, max) => (text.length <= max ? text : `…${text.slice(text.length - max + 1)}`)

export function createHerdr({ binary = 'herdr', exec = run }: any = {}) {
  async function get(pane) {
    const got = await exec(binary, ['pane', 'get', pane])
    if (got.missing || !got.ok) return cliError(got, 'herdr could not get the pane.')
    return { pane: parsed(got.stdout)?.result?.pane }
  }
  return {
    async read(target) {
      const pane = paneTarget(target)
      if (pane === undefined) return { error: 'Not a pane.' }
      const [read, got] = await Promise.all([
        exec(binary, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(PANE_LINES)]),
        exec(binary, ['pane', 'get', pane]),
      ])
      if (read.missing || !read.ok) return cliError(read, 'herdr could not read the pane.')
      const info = got.ok ? parsed(got.stdout)?.result?.pane : undefined
      const status = typeof info?.agent_status === 'string' ? info.agent_status : undefined
      const title = typeof info?.terminal_title_stripped === 'string' ? info.terminal_title_stripped.trim() : undefined
      return { text: tail(read.stdout.replace(/\s+$/, ''), PANE_TEXT_MAX), ...(status ? { status } : {}), ...(title ? { title } : {}) }
    },
    async status(target) {
      const pane = paneTarget(target)
      if (pane === undefined) return { error: 'Not a pane.' }
      const got = await get(pane)
      if ('error' in got) return got
      const status = got.pane?.agent_status
      return typeof status === 'string' ? { status } : {}
    },
    async info(target) {
      if (!isPaneId(target)) return { error: 'Not a pane.' }
      const got = await get(target)
      if ('error' in got) return got
      const status = got.pane?.agent_status
      if (typeof status !== 'string') return { error: 'herdr did not return a pane status.' }
      const agent = got.pane.agent
      const session = got.pane.agent_session?.value
      return { status, ...(typeof agent === 'string' ? { agent } : {}), ...(typeof session === 'string' ? { session } : {}) }
    },
    async processes(target) {
      if (!isPaneId(target)) return { error: 'Not a pane.' }
      const got = await exec(binary, ['pane', 'process-info', '--pane', target])
      if (got.missing || !got.ok) return cliError(got, 'herdr could not get the pane processes.')
      const foreground = parsed(got.stdout)?.result?.process_info?.foreground_processes
      if (!Array.isArray(foreground) || !foreground.every(process => typeof process?.name === 'string'
        && Array.isArray(process.argv) && process.argv.every(arg => typeof arg === 'string'))) {
        return { error: 'herdr did not return the pane processes.' }
      }
      return { foreground: foreground.map(({ name, argv }) => ({ name, argv })) }
    },
    async close(target) {
      if (!isPaneId(target)) return { error: 'Not a pane.' }
      const got = await exec(binary, ['pane', 'close', target])
      return got.ok ? { ok: true } : cliError(got, 'herdr could not close the pane.')
    },
  }
}
