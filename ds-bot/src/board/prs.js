// The GitHub pull requests on a card, and whether each is merged. A card whose work is
// done but whose PR is not merged yet waits in Review; the board asks the gh CLI (as
// the user who runs dsh) and moves it to Done once every PR on it is merged.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/
const READ_TIMEOUT_MS = 15_000
export const PR_STATES = ['OPEN', 'CLOSED', 'MERGED']

// A pull request's address in one spelling (no /files, no query), or undefined.
export function prUrl(text) {
  const match = PR.exec(String(text ?? '').trim())
  return match === null ? undefined : `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
}

// The PRs a card links, once each, in the order they were added.
export const prsOf = links => [...new Set((links ?? []).map(link => prUrl(typeof link === 'string' ? link : link?.url)).filter(url => url !== undefined))]

// `owner/repo#12`, as the card's links show a PR.
export const prName = url => url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#')

// The binary: config.gh, else /usr/bin/gh when it is there (a service's PATH may lack
// the user's own), else gh on the PATH.
export function ghBinary(config = {}) {
  if (typeof config.gh === 'string' && config.gh !== '') return config.gh
  return existsSync('/usr/bin/gh') ? '/usr/bin/gh' : 'gh'
}

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? '') })
  })
})

// Reads PR states through gh. `exec(file, args)` is replaceable for tests.
export function createPrs({ binary = 'gh', exec = run } = {}) {
  return {
    // A PR's address -> 'OPEN' | 'CLOSED' | 'MERGED', or undefined when gh could not tell
    // (not installed, not signed in, no access).
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
