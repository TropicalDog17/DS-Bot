import { createElement as h, useEffect, useRef } from 'react'
import { TextIcon } from './icons.ts'
import { t } from './i18n.ts'

export const PASTE_LIMIT = 1500
const NO_BLOCKS = []
const NO_IDS = []
const ORPHAN_MS = 3000

export const foldPastedText = text => (typeof text === 'string' && text.length > PASTE_LIMIT ? text : null)

export const pastedName = text => `Pasted text (${text.length} characters).txt`

export const blockLives = (block, ids) => block.attachmentId === null || ids.includes(block.attachmentId)

// The shell's attachment rail lists draft files in the same order as their ids.
// File cards wear the file name as their title; an image tile wears it as the img alt.
function composerLabels(root) {
  const group = root.querySelector('[data-slot="conversation.input.attachments"] [role="group"]')
  if (group === null) return []
  return [...group.children].map((item) => {
    const alt = item.querySelector('img[alt]')?.getAttribute('alt') ?? ''
    if (alt !== '') return alt
    return item.querySelector('[title]')?.getAttribute('title') ?? ''
  })
}

export function pasteLinks(blocks, ids, labels) {
  if (labels.length !== ids.length) return []
  const taken = new Set()
  for (const block of blocks) if (block.attachmentId !== null) taken.add(block.attachmentId)
  const links = []
  for (const block of blocks) {
    if (block.attachmentId !== null || !block.name) continue
    const index = labels.findIndex((label, i) => label === block.name && !taken.has(ids[i]))
    if (index === -1) continue
    taken.add(ids[index])
    links.push({ blockId: block.id, attachmentId: ids[index] })
  }
  return links
}

export function putBackText({ block, inputActions, draft = '' }) {
  const text = block?.text ?? ''
  if (text === '' || !inputActions) return false
  if (block.attachmentId && typeof inputActions.removeAttachment === 'function') inputActions.removeAttachment(block.attachmentId)
  if (typeof inputActions.insertText === 'function' && inputActions.insertText(text, inputActions.captureInsertion())) return true
  inputActions.setDraft?.(`${draft}${text}`)
  return true
}

export function handOffPaste({ event, card, sessionId, actions }) {
  if ((event.clipboardData?.files?.length ?? 0) > 0) return null
  const kept = foldPastedText(event.clipboardData?.getData('text/plain') ?? '')
  if (kept === null) return null
  const input = card.querySelector('input[type=file]')
  if (input === null || input === undefined) return null
  const file = new File([kept], pastedName(kept), { type: 'text/plain' })
  event.preventDefault()
  event.stopPropagation()
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  actions.addPaste(sessionId, kept, file.name)
  return file.name
}

export function PasteCard({ text, onPutBack, onRemove }) {
  return h('div', { className: 'bt-paste-card' },
    h('span', { className: 'bt-paste-icon', 'aria-hidden': true }, h(TextIcon)),
    h('span', { className: 'bt-paste-label' }, t('Pasted text · {count} characters', { count: text.length.toLocaleString() })),
    onPutBack === undefined ? null : h('button', {
      type: 'button', className: 'bt-paste-put', title: t('Put back into the box'), onClick: onPutBack,
    }, t('Put back')),
    h('button', {
      type: 'button', className: 'bt-paste-x', 'aria-label': t('Remove pasted text'), title: t('Remove pasted text'), onClick: onRemove,
    }, '×'))
}

export function PasteDock({ sessionId, inputActions, useUi, useInput, actions }) {
  const blocks = useUi(state => state.paste?.[sessionId]) ?? NO_BLOCKS
  const draft = useInput?.(state => state.draft) ?? ''
  if (blocks.length === 0) return null
  const drop = (block) => {
    if (block.attachmentId && typeof inputActions?.removeAttachment === 'function') inputActions.removeAttachment(block.attachmentId)
    actions.removePaste(sessionId, [block.id])
  }
  return h('div', { className: 'bt-paste-dock' }, blocks.map(block => h(PasteCard, {
    key: block.id, text: block.text,
    onPutBack: () => { if (putBackText({ block, inputActions, draft })) actions.removePaste(sessionId, [block.id]) },
    onRemove: () => drop(block),
  })))
}

export function PasteGuard({ sessionId, inputActions, useInput, useUi, actions }) {
  const anchor = useRef(null)
  const blocks = useUi(state => state.paste?.[sessionId]) ?? NO_BLOCKS
  const ids = useInput?.(state => state.attachmentIds) ?? NO_IDS
  const latest = useRef({ blocks, ids })
  latest.current = { blocks, ids }
  useEffect(() => {
    if (!blocks.some(block => block.attachmentId === null)) return undefined
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const sync = () => {
      const { blocks: now, ids: nowIds } = latest.current
      if (!now.some(block => block.attachmentId === null)) return
      const links = pasteLinks(now, nowIds, composerLabels(card))
      if (links.length > 0) actions.linkPastes(sessionId, links)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(card, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [ids, blocks])
  useEffect(() => {
    const gone = latest.current.blocks.filter(block => !blockLives(block, ids))
    if (gone.length > 0) actions.removePaste(sessionId, gone.map(block => block.id))
  }, [ids])
  useEffect(() => {
    const waiting = blocks.filter(block => block.attachmentId === null)
    if (waiting.length === 0) return undefined
    const timer = setTimeout(() => {
      for (const block of waiting) {
        const now = latest.current.blocks.find(item => item.id === block.id)
        if (now === undefined || now.attachmentId !== null) continue
        inputActions?.insertText?.(block.text, inputActions?.captureInsertion?.())
        actions.removePaste(sessionId, [block.id])
      }
    }, ORPHAN_MS)
    return () => clearTimeout(timer)
  }, [blocks])
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const mark = () => {
      for (const block of blocks) {
        if (block.attachmentId === null) continue
        for (const node of card.querySelectorAll('[title]')) {
          if (node.getAttribute('title') === block.name) node.setAttribute('data-bt-paste', '')
        }
      }
    }
    mark()
    // The shell draws the file card after the attachment lands, and again while it uploads.
    const observer = new MutationObserver(mark)
    observer.observe(card, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [blocks, ids])
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const onPaste = (event) => { handOffPaste({ event, card, sessionId, actions }) }
    card.addEventListener('paste', onPaste, true)
    return () => card.removeEventListener('paste', onPaste, true)
  }, [sessionId])
  return h('span', { ref: anchor, className: 'bt-paste-guard', 'aria-hidden': true })
}

export const PASTE_CSS = `
.bt-paste-guard{display:none}
[data-composer-card] [data-bt-paste]{display:none!important}
.bt-paste-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,748px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto calc(0px - var(--dsh-composer-stack-gap,8px) + 8px);padding:0 var(--dsh-composer-dock-inset,0px);flex:none;display:flex;flex-direction:column;gap:6px}
.bt-paste-card{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 5px 4px 10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px}
.bt-paste-icon{flex:none;display:inline-flex;width:16px;height:16px;color:var(--bt-ink-3)}
.bt-paste-label{min-width:0;flex:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-paste-put{flex:none;border:0;border-radius:8px;background:none;color:var(--bt-accent);font:inherit;font-size:13px;line-height:18px;padding:4px 6px;cursor:pointer}
.bt-paste-put:hover{background:color-mix(in srgb,var(--bt-accent) 10%,transparent)}
.bt-paste-x{flex:none;display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:8px;background:none;color:var(--bt-ink-3);font:inherit;font-size:15px;line-height:1;cursor:pointer}
.bt-paste-x:hover{background:color-mix(in srgb,var(--bt-ink) 8%,transparent);color:var(--bt-ink)}
`
