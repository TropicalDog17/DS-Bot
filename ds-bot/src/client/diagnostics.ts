import { t, language } from './i18n.ts'

const MAX = 30
const REPEAT_MS = 5 * 60 * 1000
const entries = []
const noted = new WeakSet()
export const markNoted = (error) => {
  if (error !== null && typeof error === 'object') noted.add(error)
  return error
}

export function noteClientError(where, error) {
  if (error !== null && typeof error === 'object') {
    if (noted.has(error)) return
    noted.add(error)
  }
  const message = String(error?.message ?? error ?? 'error').slice(0, 300)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const text = `${where}: ${message}`
  const now = Date.now()
  const last = entries.at(-1)
  if (last && last.text === text && now - last.time < REPEAT_MS) {
    last.time = now
    last.count = (last.count ?? 1) + 1
    return
  }
  entries.push({ time: now, level: 'error', text, ...(code ? { code } : {}) })
  if (entries.length > MAX) entries.splice(0, entries.length - MAX)
}

export const quietly = where => error => noteClientError(where, error)

export const clearClientErrors = () => { entries.length = 0 }

export const clientErrors = () => entries.map(entry => (entry.count > 1 ? { ...entry, text: `${entry.text} (×${entry.count})` } : { ...entry }))

export function clientFacts() {
  return {
    surface: (window as any).dshDesktop ? 'DSH Desktop' : 'DSH Web',
    language: language(),
    userAgent: navigator.userAgent,
  }
}

const FAILURES = {
  MISSING_CREDENTIAL: 'The model has no API key',
  INVALID_CREDENTIAL: 'The API key is not in the right format',
  AUTH: 'The API key was rejected',
  CONTENT_POLICY: 'The model service blocked the content',
  QUOTA: 'The account is out of quota',
  ACCOUNT_QUOTA: 'The account is out of quota',
  ACCOUNT_SIGN_IN_REQUIRED: 'The DeepSeek account needs a sign-in',
  ACCOUNT_SIGNED_OUT: 'The DeepSeek account is signed out',
  ACCOUNT_TOKEN_INVALID: 'The DeepSeek account sign-in has expired',
  RATE_LIMIT: 'Too many requests to the model',
  CONTEXT_WINDOW_EXCEEDED: 'The conversation is too long for the model',
  INVALID_REQUEST: 'The model service refused the request',
  SERVER: 'The model service failed',
  TIMEOUT: 'The model took too long to answer',
  TRANSPORT: 'Could not reach the model service',
  MODEL_SWITCH_COMPACTION_FAILED: "The conversation could not be compacted for the model switch",
  SESSION: 'Its group conversation could not open',
  SESSION_RESET: 'Its group conversation could not open, so it starts a new one next time',
}

export const knownFailure = code => (Object.hasOwn(FAILURES, code ?? '') ? t(FAILURES[code]) : undefined)

export function failureLabel(code, message) {
  return knownFailure(code) ?? (message || code || t('Unknown error'))
}

// GitHub refuses very long addresses; past this the diagnostics go by the clipboard.
const URL_LIMIT = 7000
export const WHAT_MAX = 2000
const PASTE_NOTE = 'DS Bot copied the diagnostics to the clipboard. Paste them here.'
const REST_NOTE = 'The recent errors do not fit in the link. DS Bot copied the diagnostics to the clipboard: paste them below this line.'

export function issueUrl(base, { what = '', diagnostics }) {
  const text = what.trim().slice(0, WHAT_MAX)
  const title = text.split('\n')[0].slice(0, 80)
  const build = body => `${base}?${new URLSearchParams({ template: 'bug.yml', ...(title ? { title } : {}), ...(text ? { what: text } : {}), diagnostics: body })}`
  const full = build(diagnostics)
  if (full.length <= URL_LIMIT) return { url: full, inline: true }
  const facts = build(`${diagnostics.split('\n\n')[0]}\n\n${REST_NOTE}`)
  return { url: facts.length <= URL_LIMIT ? facts : build(PASTE_NOTE), inline: false }
}
