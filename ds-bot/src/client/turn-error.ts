import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { currentPart, isHiddenTurn } from './text.ts'
import { CheckIcon, CopyIcon } from './icons.ts'
import { ModelKeyCard, manageModels } from './model-menu.ts'
import { knownFailure } from './diagnostics.ts'
import { hostText, t } from './i18n.ts'

const OFFICIAL = 'deepseek-official'
const ACCOUNT = 'deepseek-account'
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
const ACCOUNT_MODELS_WAIT_MS = 20_000
const SIGNED_OUT = new Set(['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID'])
const KEY_CODES = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'])
const CREDENTIAL_CODES = new Set([...KEY_CODES, ...SIGNED_OUT])

export function failureText(code, { name, provider, status }) {
  switch (code) {
    case 'MISSING_CREDENTIAL': return t("{name}'s model has no API key yet.", { name })
    case 'INVALID_CREDENTIAL': return t('This API key is not in the right format.')
    case 'AUTH': return status === undefined
      ? t('{provider} did not accept the current API key.', { provider })
      : t('{provider} did not accept the current API key ({status}).', { provider, status })
    case 'CONTENT_POLICY': return status === undefined
      ? t('{provider} blocked this request with its content filter. The API key is not the problem; edit the input or start a new chat.', { provider })
      : t('{provider} blocked this request with its content filter ({status}). The API key is not the problem; edit the input or start a new chat.', { provider, status })
    case 'QUOTA': return status === undefined
      ? t('{provider} is out of balance or quota.', { provider })
      : t('{provider} is out of balance or quota ({status}).', { provider, status })
    case 'ACCOUNT_QUOTA': return t('The DeepSeek account balance is too low.')
    case 'ACCOUNT_SIGN_IN_REQUIRED':
    case 'ACCOUNT_SIGNED_OUT':
    case 'ACCOUNT_TOKEN_INVALID': return t('The DeepSeek account sign-in has expired.')
    case 'TRANSPORT':
    case 'TIMEOUT': return t('Could not reach the model service.')
    case 'RATE_LIMIT': return t('Too many requests. Wait a moment, then try again.')
    case 'SERVER': return t('The model service failed.')
    case 'INTERRUPTED': return t('DeepSeek Harness stopped before this turn finished.')
    case 'MODEL_SWITCH_COMPACTION_FAILED': return t("The conversation could not be compacted for this model. Try again or choose another model.")
    default: return knownFailure(code) ?? t('This turn failed.')
  }
}

export function fixesFor(code, { canSignIn, official, topUp, onAccount = false }) {
  if (onAccount && KEY_CODES.has(code)) return []
  if (SIGNED_OUT.has(code)) return canSignIn ? ['sign-in-again'] : ['model']
  switch (code) {
    case 'MISSING_CREDENTIAL': return ['key', canSignIn ? 'sign-in' : null, 'model'].filter(Boolean)
    case 'INVALID_CREDENTIAL': return ['rekey', 'model']
    case 'AUTH': return ['rekey', canSignIn ? 'use-account' : null, 'model'].filter(Boolean)
    case 'CONTENT_POLICY': return []
    case 'QUOTA': return official ? ['top-up'] : []
    case 'ACCOUNT_QUOTA': return topUp ? ['top-up'] : []
    case 'MODEL_SWITCH_COMPACTION_FAILED': return ['model', 'model-settings']
    default: return []
  }
}

export const retryShown = (code, blocked) => !CREDENTIAL_CODES.has(code) || blocked === undefined

const FIX_LABELS = {
  key: () => t('Enter API key'),
  'model-settings': () => t('Open model settings'),
  rekey: () => t('Enter the key again'),
  'sign-in': signedIn => (signedIn ? t('Use the DeepSeek account') : t('Sign in with a DeepSeek account')),
  'use-account': () => t('Use a DeepSeek account instead'),
  'sign-in-again': () => t('Sign in again'),
  model: () => t('Pick another model'),
  'top-up': () => t('Top up ↗'),
}

const NO_SUBSCRIBE = () => () => {}
const NO_VIEW = () => null

function useAccountView(actions) {
  const entry = actions.signInEntry?.() ?? null
  const ops = useMemo(() => entry?.inject?.() ?? {}, [entry])
  const source = ops.hooks?.account
  const read = source ? () => source.getSnapshot()?.view ?? null : NO_VIEW
  return useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIBE, read, read)
}

const topUpOf = (view) => {
  const url = view?.links?.topUpUrl
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined
}

export function accountModel(roster) {
  const models = (roster.models ?? []).filter(model => model.provider === ACCOUNT)
  return (models.find(model => model.ref === roster.defaultModel) ?? models[0])?.ref
}

const providerOf = (bot, roster) => {
  const ref = bot?.model ?? bot?.appliedModel
  if (!ref) return undefined
  return (roster.models ?? []).find(model => model.ref === ref)?.provider ?? ref.split('/')[0]
}
const KNOWN_PROVIDERS = { 'deepseek-official': 'DeepSeek', 'deepseek-account': 'DeepSeek account' }
const providerName = (roster, provider) => (provider === undefined
  ? t('The model service')
  : (roster.models ?? []).find(model => model.provider === provider)?.providerName
    ?? (KNOWN_PROVIDERS[provider] ? t(KNOWN_PROVIDERS[provider]) : provider))

export function failureFacts(data, blocked) {
  const facts = []
  if (data.code) facts.push(['Code', t('Code'), data.code])
  const status = data.status ?? blocked?.status
  if (status !== undefined) facts.push(['HTTP status', t('HTTP status'), String(status)])
  const requestId = data.requestId ?? blocked?.requestId
  if (requestId) facts.push(['Request ID', t('Request ID'), requestId])
  // DSH already blanks an AUTH message; it never shows here either way.
  if (data.code !== 'AUTH' && data.message) facts.push(['Message', t('Provider message'), data.message])
  return facts
}

function TechnicalDetails({ facts }) {
  const [copied, setCopied] = useState(false)
  if (facts.length === 0) return null
  const copy = () => {
    const text = facts.map(([name, , value]) => `${name}: ${value}`).join('\n')
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) }).catch(() => {})
  }
  return h('details', { className: 'bt-fail-tech' },
    h('summary', null, t('Technical details')),
    h('dl', null, facts.map(([name, label, value]) => [h('dt', { key: `${name}:t` }, label), h('dd', { key: `${name}:d` }, value)])),
    h('button', { type: 'button', className: 'bt-mini bt-fail-copy', onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon), copied ? t('Copied') : t('Copy')))
}

export function FailureCell({ node, sessionId, useRoster, useTurnClock, actions }) {
  const roster = useRoster(value => value)
  const failRow = node?.data ?? {}
  const bot = roster.byId?.[sessionId]
  // The host corrects a failure DSH classified from the status alone (a 403 content
  // audit arrives as AUTH) and keeps the upstream message and request id. Its record
  // for this part and turn wins over the row's for the copy and Technical details.
  const host = bot?.failures?.[sessionId]
  const data = host !== undefined && host.turn === failRow.turn ? { ...failRow, ...host } : failRow
  const later = useTurnClock(state => Object.keys(state[sessionId] ?? {}).some(turn => Number(turn) > data.turn))
  const account = useAccountView(actions)
  const signedIn = account?.status === 'credential-stored'
  const topUp = topUpOf(account)
  const [keying, setKeying] = useState(false)
  const [retry, setRetry] = useState('idle')
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(null)
  const blocked = bot?.blocked?.code === data.code ? bot.blocked : undefined
  const provider = blocked?.provider ?? host?.provider ?? providerOf(bot, roster)
  const text = failureText(data.code, { name: bot?.name ?? t('This Bot'), provider: providerName(roster, provider), status: data.status ?? blocked?.status })
  const facts = failureFacts(data, blocked)
  const current = bot !== undefined && currentPart(bot) === sessionId && !later
  const moveToAccount = () => {
    const model = accountModel(roster)
    if (model === undefined) { actions.showDetails?.(sessionId); return }
    if (model === bot.model) return
    setError('')
    void Promise.resolve(actions.updateBot(bot.id, { model })).catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const listed = accountModel(roster)
  useEffect(() => {
    if (joining === null || !signedIn) return undefined
    if (bot === undefined || bot.model !== joining.from) { setJoining(null); return undefined }
    if (listed !== undefined) { setJoining(null); moveToAccount(); return undefined }
    void actions.refreshModels?.()
    const timer = setTimeout(() => { setJoining(null); actions.showDetails?.(sessionId) }, ACCOUNT_MODELS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [joining, signedIn, listed])
  const settled = () => h('div', { className: 'bt-fail', 'data-settled': '', role: 'status' },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)),
    h(TechnicalDetails, { facts }))
  if (!current) return settled()
  const official = provider === OFFICIAL
  const canSignIn = typeof actions.signIn === 'function' && actions.canSignIn?.() === true
  const keyHere = typeof actions.setProviderKey === 'function' && provider !== undefined
  const keyElsewhere = official && actions.openHarnessOnboarding ? () => actions.openHarnessOnboarding(OFFICIAL) : manageModels(actions)
  const viaAccount = () => {
    if (signedIn) { moveToAccount(); return }
    setJoining({ from: bot.model })
    actions.signIn()
  }
  const runs = {
    key: keyHere ? () => setKeying(value => !value) : keyElsewhere,
    rekey: keyHere ? () => setKeying(value => !value) : keyElsewhere,
    'sign-in': viaAccount,
    'use-account': viaAccount,
    'sign-in-again': () => actions.signIn(),
    model: actions.showDetails ? () => actions.showDetails(sessionId) : undefined,
    'model-settings': manageModels(actions),
  }
  const fixes = fixesFor(data.code, { canSignIn, official, topUp: topUp !== undefined, onAccount: provider === ACCOUNT }).filter(fix => fix === 'top-up' || runs[fix] !== undefined)
  const asked = isHiddenTurn(roster, sessionId, data.turn)
  const retrying = !asked && typeof actions.resume === 'function' && retryShown(data.code, blocked)
  const retryFirst = retrying && (fixes.length === 0 || CREDENTIAL_CODES.has(data.code))
  const resume = () => {
    setRetry('busy')
    setError('')
    void Promise.resolve(actions.resume(bot.id))
      .then(() => setRetry('sent'), (failure) => { setRetry('idle'); setError(hostText(failure?.message ?? String(failure))) })
  }
  const button = (fix, primary) => {
    const className = primary ? 'bt-send bt-fail-go' : 'bt-soft bt-soft-sm'
    if (fix === 'top-up') {
      return h('a', { key: fix, className: `${className} bt-fail-link`, href: data.code === 'ACCOUNT_QUOTA' ? topUp : TOP_UP_URL, target: '_blank', rel: 'noopener noreferrer' }, FIX_LABELS[fix]())
    }
    const toggles = keyHere && (fix === 'key' || fix === 'rekey')
    return h('button', { key: fix, type: 'button', className, 'aria-expanded': toggles ? keying : undefined, onClick: () => runs[fix]() }, FIX_LABELS[fix](signedIn))
  }
  const retryButton = primary => h('button', { key: 'retry', type: 'button', className: primary ? 'bt-send bt-fail-go' : 'bt-soft bt-soft-sm', disabled: retry !== 'idle', onClick: resume }, retry === 'idle' ? t('Retry') : t('Retrying…'))
  const row = retryFirst
    ? [retryButton(true), ...fixes.map(fix => button(fix, false))]
    : [...fixes.map((fix, index) => button(fix, index === 0)), retrying ? retryButton(false) : null]
  if (!row.some(Boolean)) return settled()
  return h('div', { className: 'bt-fail', role: 'status' },
    h('div', { className: 'bt-fail-head' }, h('span', { className: 'bt-fail-dot', 'aria-hidden': true }), h('span', { className: 'bt-fail-text' }, text)),
    h('div', { className: 'bt-fail-actions' }, row),
    keying && keyHere ? h(ModelKeyCard, { model: { provider, providerName: providerName(roster, provider) }, actions, onSaved: () => setKeying(false) }) : null,
    error ? h('div', { className: 'bt-fail-error', role: 'alert' }, error) : null,
    h(TechnicalDetails, { facts }))
}

export const TURN_ERROR_CSS = `
.bt-fail{display:flex;flex-direction:column;gap:10px;margin:4px 0 6px;width:max-content;max-width:min(550px,86%);padding:12px 14px;border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line);box-sizing:border-box;color:var(--bt-ink);font-size:14px;line-height:20px}
.bt-fail[data-settled]{gap:4px;padding:2px 0;background:none;box-shadow:none;color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-fail-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.bt-fail-dot{flex:none;width:7px;height:7px;margin-top:6.5px;border-radius:50%;background:var(--bt-danger)}
.bt-fail[data-settled] .bt-fail-dot{margin-top:5.5px}
.bt-fail-text{min-width:0;overflow-wrap:anywhere}
.bt-fail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:15px}
.bt-fail-actions .bt-fail-go{height:28px;padding:0 12px;font:inherit;font-size:12px}
.bt-fail-link{display:inline-flex;align-items:center;box-sizing:border-box;text-decoration:none}
.bt-fail:has(.bt-model-key){width:min(480px,86%)}
.bt-fail .bt-q.bt-model-key{margin:0 0 0 15px;width:auto;padding:0;background:none;box-shadow:none;border-radius:0;animation:none}
.bt-fail-error{margin-left:15px;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-fail-tech{margin-left:15px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-fail-tech summary{width:max-content;cursor:pointer;color:var(--bt-ink-3)}
.bt-fail-tech summary:hover{color:var(--bt-ink-2)}
.bt-fail-tech dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:6px 0}
.bt-fail-tech dt{color:var(--bt-ink-3)}
.bt-fail-tech dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere;white-space:pre-wrap;user-select:text}
.bt-fail-copy{display:inline-flex;align-items:center;gap:4px}
.bt-fail-copy svg{width:13px;height:13px}
`
