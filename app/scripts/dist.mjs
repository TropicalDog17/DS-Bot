import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const RETRY_DELAYS_MS = [30_000, 90_000, 180_000]
const TAIL_CHARS = 64 * 1024

const GATEWAY_FAILURE = /Response code (?:5\d\d|429|408)\b|primary runtime download: (?:5\d\d|429|408) /u

export function gatewayFailure(output) {
  const last = output.match(/^\s*⨯ .*$/gmu)?.at(-1)?.trim()
  return last !== undefined && GATEWAY_FAILURE.test(last) ? last : undefined
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

function runOnce(args) {
  const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    const keep = (sink) => (chunk) => {
      sink.write(chunk)
      output = (output + chunk.toString('utf8')).slice(-TAIL_CHARS)
    }
    child.stdout.on('data', keep(process.stdout))
    child.stderr.on('data', keep(process.stderr))
    child.once('error', fail)
    child.once('close', (code, signal) => { done({ code, signal, output }) })
  })
}

export async function dist(args, options = {}) {
  const runImpl = options.runImpl ?? runOnce
  const sleepImpl = options.sleepImpl ?? sleep
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const log = options.log ?? ((line) => { console.error(line) })
  const attempts = retryDelaysMs.length + 1
  for (let attempt = 1; ; attempt += 1) {
    const { code, signal, output } = await runImpl(args)
    if (code === 0 || signal !== null) return { code, signal }
    const failure = gatewayFailure(output)
    const delay = failure === undefined ? undefined : retryDelaysMs[attempt - 1]
    if (delay === undefined) {
      if (failure !== undefined) log(`dist: attempt ${String(attempt)}/${String(attempts)} failed on a download, giving up: ${failure}`)
      return { code, signal }
    }
    log(`dist: attempt ${String(attempt)}/${String(attempts)} failed on a download: ${failure}; running again in ${String(delay / 1000)} s`)
    await sleepImpl(delay)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, signal } = await dist(['--publish', 'never', ...process.argv.slice(2)])
  if (signal !== null) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
}
