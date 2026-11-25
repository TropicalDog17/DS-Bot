import { t } from './i18n.ts'

export const SIDE_SOURCE = 'ds-bot-side'
export const SIDE_TOKEN = '/side '

const GROUP_REFUSAL = "Side chat is only available in a Bot's private chat."
const ATTACHMENT_REFUSAL = '/side does not take attachments.'
const EMPTY_REFUSAL = 'Write a question after /side.'
const LOADING_REFUSAL = 'DS Bot is still loading this chat.'

export function sideSurface(roster, sessionId) {
  if (!roster?.ready) return 'unknown'
  if (roster.roomsById?.[sessionId]) return 'group'
  if (roster.byId?.[sessionId]) return 'bot'
  return 'other'
}

export function sideChatsOf(roster, botId) {
  const chats = roster?.sideChats?.[botId]
  return Array.isArray(chats) ? chats : []
}

export function parseSideLine(line) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const gap = trimmed.search(/\s/)
  const token = gap === -1 ? trimmed : trimmed.slice(0, gap)
  if (token !== '/side') return null
  const args = gap === -1 ? '' : trimmed.slice(gap + 1)
  return { args, bare: args.trim() === '' }
}

export function sideQueryMatches(query) {
  const head = String(query ?? '').trim().toLowerCase().split(/\s/, 1)[0] ?? ''
  return head === '' || 'side'.startsWith(head)
}

export function matchSideSpace(roster, sessionId, token) {
  if (token !== '/side' || sideSurface(roster, sessionId) !== 'bot') return undefined
  return { claim: true }
}

export function matchSideClaim(roster, sessionId, token) {
  if (token !== '/side' || sideSurface(roster, sessionId) !== 'bot') return undefined
  return true
}

function liveRoster(roster) {
  if (typeof roster?.getSnapshot === 'function' && typeof roster?.subscribe === 'function') return roster
  return undefined
}

function readRoster(roster) {
  const live = liveRoster(roster)
  return live ? live.getSnapshot() : roster
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error('slash adjudication aborted')
}

function whenRosterReady(roster, signal) {
  const current = readRoster(roster)
  if (current?.ready) return Promise.resolve(current)
  const live = liveRoster(roster)
  if (!live) return Promise.reject(new Error(t(LOADING_REFUSAL)))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    let gate = true
    let off = () => {}
    const stop = () => {
      off()
      off = () => {}
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      const next = live.getSnapshot()
      if (!next?.ready) return
      stop()
      resolve(next)
    }
    const onAbort = () => {
      stop()
      reject(abortError(signal))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    off = live.subscribe(() => {
      if (!gate) finish()
    })
    gate = false
    finish()
  })
}

export async function matchSideEnter(roster, sessionId, line, envelope, signal) {
  const parsed = parseSideLine(line)
  if (!parsed) return undefined
  const snap = readRoster(roster)?.ready ? readRoster(roster) : await whenRosterReady(roster, signal)
  const surface = sideSurface(snap, sessionId)
  if (surface === 'other') return undefined
  if (surface === 'group') throw new Error(t(GROUP_REFUSAL))
  if (surface !== 'bot') throw new Error(t(LOADING_REFUSAL))
  if ((envelope?.attachments ?? 0) > 0) throw new Error(t(ATTACHMENT_REFUSAL))
  if (parsed.bare) throw new Error(t(EMPTY_REFUSAL))
  return { claim: true }
}

export async function submitSide({ call, roster, sessionId, args, attachments, open }) {
  const text = String(args ?? '').trim()
  if (sideSurface(roster, sessionId) === 'group') throw new Error(t(GROUP_REFUSAL))
  if (Array.isArray(attachments) && attachments.length > 0) throw new Error(t(ATTACHMENT_REFUSAL))
  if (text === '') throw new Error(t(EMPTY_REFUSAL))
  const value = await call('side-ask', { sessionId, recent: true, text })
  open?.(value?.chatId)
  return { kind: 'success' }
}

export const panelHasStrip = (canBrowse, tabCount, sideCount) =>
  (canBrowse === true && tabCount > 0) || sideCount > 0

export function stripMenuKeys({ canBrowse, canTerminal, canFiles }) {
  const keys = []
  if (canBrowse === true) keys.push('new-tab')
  keys.push('side')
  const tail = []
  if (canTerminal === true) tail.push('terminal')
  if (canFiles === true) tail.push('files')
  if (tail.length > 0) keys.push('sep')
  return [...keys, ...tail]
}

export function drawerMenuKeys({ bot, room, canBrowse, canTerminal, canFiles }) {
  const keys = []
  if (bot === true && canBrowse === true) keys.push('browser')
  if (bot === true) keys.push('side')
  const tail = []
  if (bot === true || room === true) {
    if (canTerminal === true) tail.push('terminal')
    if (canFiles === true) tail.push('files')
  }
  if (keys.length > 0 && tail.length > 0) keys.push('sep')
  return [...keys, ...tail]
}
