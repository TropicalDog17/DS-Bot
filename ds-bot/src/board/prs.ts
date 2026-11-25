import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/
const READ_TIMEOUT_MS = 15_000
export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED']

export function prUrl(text) {
  const match = PR.exec(String(text ?? '').trim())
  return match === null ? undefined : `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
}

export const prsOf = links => [...new Set((links ?? []).map(link => prUrl(typeof link === 'string' ? link : link?.url)).filter(url => url !== undefined))]

export const prName = url => url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#')

// The binary: config.gh, else /usr/bin/gh when it is there (a service's PATH may lack
// the user's own), else gh on the PATH.
export function ghBinary(config: any = {}) {
  if (typeof config.gh === 'string' && config.gh !== '') return config.gh
  return existsSync('/usr/bin/gh') ? '/usr/bin/gh' : 'gh'
}

const run = (file, args): Promise<any> => new Promise((resolve) => {
  execFile(file, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') })
  })
})

export function createPrs({ binary = 'gh', exec = run }: any = {}) {
  return {
    async state(url) {
      const pr = prUrl(url)
      if (pr === undefined) return undefined
      const got = await exec(binary, ['pr', 'view', pr, '--json', 'state'])
      if (!got.ok) return undefined
      let state
      try { state = JSON.parse(got.stdout)?.state } catch { return undefined }
      return PR_STATES.includes(state) ? state : undefined
    },
  }
}
