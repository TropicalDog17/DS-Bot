import { createElement as h, useMemo, useState } from 'react'
import { t } from './i18n.ts'

export const FOLD_AT = { chars: 1500, lines: 25 }
export const FOLD_HUGE = { chars: 20_000, lines: Infinity }
const ALWAYS = { chars: -1, lines: 0 }
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 600
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const closes = (line, open) => {
  const marker = CLOSE.exec(line)?.[1]
  return marker !== undefined && marker[0] === open[0] && marker.length >= open.length
}

function cutAt(text, end) {
  const code = text.charCodeAt(end - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

function moreLines(text, max) {
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    if (++lines > max) return true
  }
  return false
}

function openedFence(lines) {
  let open = null
  let openLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    const marker = FENCE.exec(lines[i])?.[1]
    if (marker === undefined) continue
    if (open === null) { open = marker; openLine = i }
    else if (closes(lines[i], open)) open = null
  }
  return open === null ? null : { marker: open, line: openLine }
}

function blockCode(body, fenceLine, open) {
  const lines = body.split('\n')
  const indent = /^ */.exec(lines[fenceLine])[0].length
  const code = []
  for (let i = fenceLine + 1; i < lines.length; i += 1) {
    if (closes(lines[i], open)) break
    code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''))
  }
  return code.join('\n')
}

export function foldView(text, limit = FOLD_AT, markdown = true) {
  if (text.length <= limit.chars && !moreLines(text, limit.lines)) return null
  const body = text.replace(/^(\s*\n)+/, '')
  if (body.trim() === '') return null
  let head = body.split('\n', PREVIEW_LINES).join('\n')
  if (head.length > PREVIEW_CHARS) {
    const cut = head.lastIndexOf('\n', PREVIEW_CHARS)
    head = cutAt(head, cut > 0 ? cut : PREVIEW_CHARS)
  }
  if (head.trim() === '') head = cutAt(body, PREVIEW_CHARS)
  if (!markdown) return { head }
  let opened = openedFence(head.split('\n'))
  if (opened !== null && head.split('\n').slice(opened.line + 1).join('').trim() === '') {
    head = cutAt(body, PREVIEW_CHARS)
    opened = openedFence(head.split('\n'))
  }
  if (opened === null) return { head }
  const lines = head.split('\n')
  lines[opened.line] = opened.marker
  return {
    head: `${lines.join('\n')}\n${opened.marker}`,
    prose: lines.slice(0, opened.line).join('\n'),
    codeHead: lines.slice(opened.line + 1).join('\n'),
    code: blockCode(body, opened.line, opened.marker),
  }
}

export function foldPreview(text, limit = FOLD_AT, markdown = true) {
  return foldView(text, limit, markdown)?.head ?? null
}

export const stripLongNote = text => text.replace(/^\[A long message: \d+ characters\.[^\]\n]*\]\n/, '')

export function useFold(text, { limit = FOLD_AT, whole, live = false, markdown = true }: { limit?: { chars: number; lines: number }; whole?: any; live?: boolean; markdown?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState()
  const cut = whole !== undefined && whole.length > text.length
  const view = useMemo(() => (live ? null : foldView(text, cut ? ALWAYS : limit, markdown)), [text, live, limit, markdown, cut])
  if (view === null) return { shown: text, control: null }
  const readWhole = async () => {
    if (typeof read?.text === 'string') return read
    setRead('loading')
    const value = await Promise.resolve().then(() => whole.load?.()).catch(() => undefined) ?? { whole: false }
    setRead(value)
    return value
  }
  const code = view.code === undefined ? undefined : !cut ? view.code : async () => {
    const loaded = await readWhole()
    const full = loaded.whole === true ? foldView(loaded.text, ALWAYS, markdown)?.code : undefined
    if (full === undefined) throw new Error('Could not read the whole code block')
    return full
  }
  const shown = code === undefined ? view.head : view.prose
  const count = (cut ? whole.length : text.length).toLocaleString()
  if (!open) {
    const show = async () => {
      setOpen(true)
      if (cut) await readWhole()
    }
    return { shown, folded: true, code, codeHead: view.codeHead, control: h('span', { className: 'bt-fold' }, h('button', { type: 'button', className: 'bt-more', onClick: show }, t('Show all · {count} characters', { count }))) }
  }
  const loaded = typeof read?.text === 'string' ? read : undefined
  const note = !cut || read === undefined || read === 'loading' || loaded?.whole ? null
    : loaded !== undefined && loaded.text.length > text.length ? t('Showing the first {count} characters', { count: loaded.text.length.toLocaleString() })
      : t('Only the start of this message is kept here')
  return {
    shown: loaded?.text ?? text,
    control: h('span', { className: 'bt-fold' },
      note ? h('span', { className: 'bt-fold-note' }, note) : null,
      h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(false) }, t('Show less'))),
  }
}
