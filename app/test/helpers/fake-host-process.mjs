import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './fake-electron.mjs'

const port = () => {
  try {
    return String(JSON.parse(readFileSync(join(paths.userData, 'host-port.json'), 'utf8')).port)
  } catch {
    return '43117'
  }
}

let gate
let open

export const state = {
  starts: 0,
  envs: [],
  stops: 0,
  fail: false,
  held: false,
  release: () => { if (open !== undefined) { open(); open = undefined } },
}

export const hold = () => {
  state.held = true
  gate = new Promise((done) => { open = done })
}

export class HostProcess {
  #options
  #messageListeners = new Set()

  constructor(options) { this.#options = options }

  async start() {
    state.starts += 1
    state.envs.push(this.#options.env)
    if (state.held) await gate
    if (state.fail) throw new Error('the Host did not start')
    if (this.#options.env?.DS_BOT_CHECK) return { unreadable: [] }
    return { url: `http://127.0.0.1:${port()}/?token=test-token`, injections: [] }
  }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  send() {}

  async stop() { state.stops += 1 }
}
