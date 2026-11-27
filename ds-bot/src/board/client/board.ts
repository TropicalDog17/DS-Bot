import { createElement as h, memo as reactMemo, useCallback, useEffect, useLayoutEffect, useMemo as reactUseMemo, useRef, useState } from 'react'
const memo = typeof reactMemo === 'function' ? reactMemo : (fn => fn)
const useMemo = typeof reactUseMemo === 'function' ? reactUseMemo : (fn => fn())
import { BotMark } from '../../client/mark.ts'
import { ChevronLeftIcon, PlusIcon } from '../../client/icons.ts'
import { useEscape } from '../../client/overlay-hooks.ts'
import { clockLabel, elapsedLabel, relativeShort } from '../../client/text.ts'
import { workPhrase } from '../../client/cells.ts'
import { mdLabels, t } from '../../client/i18n.ts'
import { MarkdownText } from '../../client/dsh-primitives.ts'
import { sendsOnEnter } from '../../client/enter-key.ts'
import { NOTE_MAX, charCount, isBlankNote, noteText } from '../card-fields.ts'
import { LinkIcon, StepsIcon } from './icons.ts'
import { CARD_LINK_ORIGIN, linkCards, nameCards } from './card-tag.ts'

export const COLUMNS = [['todo', 'Todo'], ['active', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done']]
const OPEN = ['todo', 'active', 'review', 'blocked']
const DONE_DAYS = 7
const DONE_SHOWN = 10
const USER = 'user'
const DRAG_TYPE = 'text/x-ds-bot-card'
const NOTE_COUNT_FROM = 18_000
const noteCountFormat = new Intl.NumberFormat('en-US')

export function boardColumns(cards, now = Date.now()) {
  const all = Object.values<any>(cards ?? {}).filter(card => card && typeof card.id === 'string').sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const columns = Object.fromEntries(OPEN.map(status => [status, all.filter(card => card.status === status)]))
  const done = all.filter(card => card.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt ?? 0) - (a.doneAt ?? a.updatedAt ?? 0))
  const recent = done.filter(card => now - (card.doneAt ?? card.updatedAt ?? 0) < DONE_DAYS * 86_400_000).slice(0, DONE_SHOWN)
  columns.done = recent
  const history = [...done.filter(card => !recent.includes(card)), ...all.filter(card => card.status === 'cancelled')]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { columns, history }
}

export function leadColumn(columns) {
  const order = ['review', 'blocked', 'active', 'todo']
  return order.find(status => columns[status]?.some(card => card.unread === true))
    ?? order.find(status => columns[status]?.length > 0) ?? 'todo'
}

export function plainLine(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(\S(?:[^*\n]*\S)?)\*(?!\w)/g, '$1$2')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

const BotText = memo(function BotText({ text, cards, className }) {
  const linked = useMemo(() => linkCards(text ?? '', cards), [text, cards])
  const labels = useMemo(() => mdLabels(), [])
  return h('div', { className: `bt-board-md ${className}` },
    h(MarkdownText, { text: linked, labels, variant: 'compact' }))
})

export function linkLabel(href) {
  let url
  try { url = new URL(href) } catch { return href }
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'github.com' && parts.length >= 2) {
    const repo = `${parts[0]}/${parts[1]}`
    if (/^(pull|issues)$/.test(parts[2] ?? '') && /^\d+$/.test(parts[3] ?? '')) return `${repo}#${parts[3]}`
    if (parts[2] === 'commit' && /^[0-9a-f]{7,}$/i.test(parts[3] ?? '')) return `${repo}@${parts[3].slice(0, 7)}`
    if (parts.length === 2) return repo
  }
  return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
}

const markdownLink = href => `[${linkLabel(href).replace(/[[\]\\]/g, '\\$&')}](<${href}>)`

function Options({ options, picked, pick, busy }) {
  return h('div', { className: 'bt-board-options' },
    options.map(option => h('button', {
      key: option, type: 'button', className: 'bt-board-option',
      disabled: pick === undefined || busy, 'data-picked': option === picked || undefined,
      onClick: () => pick?.(option),
    }, option)))
}

const cardLinkTap = openCard => (event) => {
  const anchor = typeof event.target?.closest === 'function' ? event.target.closest(`a[href^="${CARD_LINK_ORIGIN}"]`) : null
  if (anchor === null) return
  event.preventDefault()
  event.stopPropagation()
  openCard?.(anchor.getAttribute('href').slice(CARD_LINK_ORIGIN.length))
}

const Dot = ({ status }) => h('span', { className: 'bt-board-dot', 'data-status': status, 'aria-hidden': true })

function Who({ id, roster, size = 20 }) {
  const bot = id === USER ? undefined : roster.byId?.[id]
  const name = bot?.name ?? (id === USER || id === undefined ? t('You') : id)
  return h('span', { className: 'bt-board-who' },
    bot ? h(BotMark, { bot, size }) : h('span', { className: 'bt-board-me', style: { width: size, height: size, fontSize: Math.round(size * 0.5) }, 'aria-hidden': true }, name.slice(0, 1).toUpperCase()),
    h('span', { className: 'bt-board-who-name' }, name))
}

function AssigneeOptions({ assignee, roster }) {
  const bots = roster.bots ?? []
  const known = assignee === USER || bots.some(bot => bot.id === assignee)
  return [
    h('option', { key: USER, value: USER }, t('You')),
    ...bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)),
    ...(typeof assignee === 'string' && !known
      ? [h('option', { key: assignee, value: assignee }, roster.byId?.[assignee]?.name ?? assignee)]
      : []),
  ]
}

function Card({ card, roster, onOpen, onDrag }) {
  const links = (card.links ?? []).length
  const unread = card.unread === true
  const reply = unread ? (card.notes ?? []).findLast(note => note.by !== USER) : undefined
  const line = reply?.text ?? (card.status === 'done' ? card.result : card.status === 'cancelled' ? card.reason : card.progress)
  return h('button', {
    type: 'button', className: 'bt-board-card', 'data-status': card.status, 'data-unread': unread || undefined, draggable: true,
    onClick: () => onOpen(card.id),
    onDragStart: (event) => { event.dataTransfer.setData(DRAG_TYPE, card.id); event.dataTransfer.effectAllowed = 'move'; onDrag(card.id) },
    onDragEnd: () => onDrag(null),
  },
  card.key ? h('span', { className: 'bt-board-key' }, card.key) : null,
  h('span', { className: 'bt-board-title' }, card.title),
  line ? h('span', { className: 'bt-board-progress' }, plainLine(nameCards(line, roster.board?.cards ?? {}))) : null,
  h('span', { className: 'bt-board-card-foot' },
    h(Who, { id: card.assignee, roster }),
    links > 0 || card.url ? h('span', { className: 'bt-board-has-link', 'aria-label': t('Link') }, h(LinkIcon)) : null,
    unread ? h('span', { className: 'bt-board-new', role: 'img', 'aria-label': t('New reply') }) : null,
    h('span', { className: 'bt-board-age' }, relativeShort(card.updatedAt ?? card.createdAt ?? Date.now()))))
}

function AddCard({ roster, actions, onDone }) {
  const [title, setTitle] = useState('')
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [assignee, setAssignee] = useState(USER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const add = () => {
    if (title.trim() === '' || busy) return
    setBusy(true)
    Promise.resolve(actions.boardAdd({ title: title.trim(), key: key.trim(), url: url.trim(), assignee })).then(
      () => { setBusy(false); onDone() },
      (failure) => { setBusy(false); setError(String(failure?.message ?? failure)) },
    )
  }
  const enter = (event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); add() } }
  return h('div', { className: 'bt-board-sheet-body' },
    h('div', { className: 'bt-board-form' },
      h('input', { className: 'bt-input bt-board-title-input', value: title, autoFocus: true, placeholder: t('Title'), 'aria-label': t('Title'), maxLength: 200, onChange: event => setTitle(event.target.value), onKeyDown: enter }),
      h('div', { className: 'bt-board-form-row' },
        h('input', { className: 'bt-input bt-board-key-input', value: key, placeholder: 'LIFE-782', 'aria-label': t('Ticket'), maxLength: 32, onChange: event => setKey(event.target.value), onKeyDown: enter }),
        h('input', { className: 'bt-input', value: url, placeholder: 'https://', 'aria-label': t('Link'), inputMode: 'url', onChange: event => setUrl(event.target.value), onKeyDown: enter })),
      h('select', { className: 'bt-input bt-board-select', value: assignee, 'aria-label': t('Assignee'), onChange: event => setAssignee(event.target.value) },
        h(AssigneeOptions, { assignee, roster })),
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null),
    h('div', { className: 'bt-board-sheet-foot' },
      h('button', { type: 'button', className: 'bt-send bt-board-go', disabled: title.trim() === '' || busy, onClick: add }, t('Add card'))))
}

function ToolStep({ step, open }) {
  const line = [
    h('span', { key: 'dot', className: 'bt-board-tool-dot', 'aria-hidden': true }),
    h('span', { key: 'text', className: 'bt-board-tool-text' }, step.text ?? workPhrase(step)),
  ]
  if (!step.input && !step.output) return h('li', { className: 'bt-board-step bt-board-tool', 'data-state': step.state }, line)
  return h('li', { className: 'bt-board-step', 'data-state': step.state },
    h('details', { className: 'bt-board-tool-fold', open: open || undefined },
      h('summary', { className: 'bt-board-tool' }, line),
      step.input ? h('pre', { className: 'bt-board-io bt-board-input' }, step.input) : null,
      step.output ? h('pre', { className: 'bt-board-io bt-board-output' }, step.output) : null))
}

export function Trace({ steps, live = false, open = false }) {
  const box = useRef(null)
  const last = steps.at(-1)
  const size = `${steps.length}:${last?.kind === 'think' ? last.text.length : `${last?.state}${last?.output ? '+' : ''}`}`
  useEffect(() => {
    const node = box.current
    if (live && node) node.scrollTop = node.scrollHeight
  }, [live, size])
  return h('ol', { className: 'bt-board-trace', ref: box, 'data-live': live || undefined },
    steps.map((step, index) => step.kind === 'think'
      ? h('li', { key: index, className: 'bt-board-step bt-board-thought' }, step.text)
      : h(ToolStep, { key: index, step, open })))
}

const TraceFold = memo(function TraceFold({ trace, open }) {
  const steps = Array.isArray(trace?.steps) ? trace.steps : []
  if (steps.length === 0) return null
  return h('details', { className: 'bt-board-fold' },
    h('summary', null, t('Thought it through'),
      typeof trace.ms === 'number' ? h('span', { className: 'bt-board-age' }, `· ${elapsedLabel(Math.max(1000, trace.ms))}`) : null),
    h(Trace, { steps, open }))
})

const Thread = memo(function Thread({ notes, roster, awaiting, worker, live, pick, busy }) {
  const cards = roster.board?.cards ?? {}
  const asked = notes.findLastIndex(note => Array.isArray(note.options) && note.options.length > 0)
  const answer = asked < 0 ? undefined : notes.slice(asked + 1).find(note => note.by === undefined || note.by === USER)
  const working = Array.isArray(live?.steps) && live.steps.length > 0 ? live.steps : undefined
  const waiter = roster.byId?.[awaiting?.botId ?? (working ? worker : undefined)]
  const open = roster.board?.trace === 'all'
  return h('ol', { className: 'bt-board-thread' },
    notes.map((note, index) => {
      const bot = note.by === undefined || note.by === USER ? undefined : roster.byId?.[note.by]
      const fromBot = note.by !== undefined && note.by !== USER
      return h('li', { key: note.pendingId ?? index, className: 'bt-board-msg', 'data-by': fromBot ? 'bot' : 'user', 'data-pending': note.pending ? true : undefined },
        fromBot ? (bot ? h(BotMark, { bot, size: 24 }) : h('span', { className: 'bt-board-msg-mark', 'aria-hidden': true })) : null,
        h('div', { className: 'bt-board-msg-body' },
          fromBot ? h(TraceFold, { trace: note.trace, open }) : null,
          fromBot
            ? h(BotText, { text: note.text, cards, className: 'bt-board-msg-text' })
            : h('span', { className: 'bt-board-msg-text' }, nameCards(note.text, cards)),
          index === asked ? h(Options, { options: note.options, picked: answer?.text, pick: answer === undefined ? pick : undefined, busy }) : null,
          h('span', { className: 'bt-board-age' }, clockLabel(note.at ?? 0))))
    }),
    waiter ? h('li', { key: 'waiting', className: 'bt-board-msg bt-board-waiting', 'data-by': 'bot', 'aria-busy': true },
      h(BotMark, { bot: waiter, size: 24 }),
      h('div', { className: 'bt-board-msg-body' },
        working ? h(Trace, { steps: working, live: true, open }) : null,
        h('span', { className: 'bt-board-msg-text bt-board-dots', 'aria-hidden': true }, h('i'), h('i'), h('i')))) : null)
})

const Steps = memo(function Steps({ card, cards }) {
  const [open, setOpen] = useState(false)
  const earlier = (card.log ?? []).slice(0, -1).reverse()
  if (earlier.length === 0) return null
  return h('div', { className: 'bt-board-steps' },
    h('button', { type: 'button', className: 'bt-more bt-board-steps-toggle', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
      open ? t('Hide history') : t('History ({count})', { count: earlier.length })),
    open ? h('ol', { className: 'bt-board-steps-list' }, earlier.map((step, index) =>
      h('li', { key: index, className: 'bt-board-step' },
        h(Dot, { status: step.status }),
        h('span', { className: 'bt-board-age' }, clockLabel(step.at ?? 0)),
        step.progress ? h(BotText, { text: step.progress, cards, className: 'bt-board-step-text' }) : null))) : null)
})

const PANE_MS = 2000
export function Panes({ card, actions }) {
  const panes = card.panes ?? []
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(null)
  const [shown, setShown] = useState(null)
  const box = useRef(null)
  const pane = panes.some(entry => entry.id === picked) ? picked : panes.at(-1)?.id
  useEffect(() => {
    if (!open || pane === undefined || typeof actions.boardPane !== 'function') return undefined
    let stopped = false
    let timer
    const tick = () => {
      Promise.resolve(actions.boardPane(card.id, pane))
        .then(value => value, failure => ({ pane, error: String(failure?.message ?? failure) }))
        .then((value) => {
          if (stopped) return
          setShown(value ?? null)
          if (!value?.gone) timer = setTimeout(tick, PANE_MS)
        })
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [open, pane, card.id])
  const view = shown?.pane === pane ? shown : undefined
  const follow = useRef(true)
  useEffect(() => { follow.current = true }, [pane, open])
  useEffect(() => {
    const node = box.current
    if (node && follow.current) node.scrollTop = node.scrollHeight
  }, [view?.text])
  const scrolled = (event) => {
    const node = event.currentTarget
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
  }
  if (pane === undefined) return null
  return h('div', { className: 'bt-board-panes' },
    h('button', { type: 'button', className: 'bt-more bt-board-pane-toggle', 'aria-expanded': open, 'data-state': view?.status, onClick: () => setOpen(value => !value) },
      h('span', { className: 'bt-board-tool-dot', 'aria-hidden': true }),
      open ? t('Hide terminal') : t('Terminal'),
      h('span', { className: 'bt-board-age' }, view?.status ? `${pane} · ${view.status}` : pane)),
    open && panes.length > 1 ? h('div', { className: 'bt-board-pane-pick', role: 'tablist' }, panes.map(entry =>
      h('button', { key: entry.id, type: 'button', role: 'tab', className: 'bt-board-pane-tab', 'aria-selected': entry.id === pane, onClick: () => setPicked(entry.id) }, entry.id))) : null,
    open ? (view === undefined
      ? h('div', { className: 'bt-board-msg-text bt-board-dots', 'aria-hidden': true }, h('i'), h('i'), h('i'))
      : view.error !== undefined
        ? h('div', { className: 'bt-board-line bt-board-pane-gone' }, view.gone ? t('This pane is closed.') : view.error)
        : h('pre', { className: 'bt-board-term', ref: box, title: view.title, onScroll: scrolled }, view.text || ' ')) : null)
}

const BRIEF_FOLD = 280
const Brief = memo(function Brief({ text, cards }) {
  const [open, setOpen] = useState(false)
  const long = text.length > BRIEF_FOLD || text.split('\n').length > 4
  return h('div', { className: 'bt-board-brief', 'data-folded': long && !open ? true : undefined },
    h(BotText, { text, cards, className: 'bt-board-line' }),
    long ? h('button', { type: 'button', className: 'bt-more', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
      open ? t('Show less') : t('Show more')) : null)
})

function fitComposer(node: HTMLTextAreaElement, canShrink = true) {
  const border = node.offsetHeight - node.clientHeight
  if (!canShrink && node.style.height !== '') {
    const height = `${Math.min(180, Math.max(40, node.scrollHeight + border))}px`
    if (parseFloat(height) > parseFloat(node.style.height)) node.style.height = height
    return
  }
  if (node.style.height === '40px') {
    const height = `${Math.min(180, Math.max(40, node.scrollHeight + border))}px`
    if (node.style.height !== height) node.style.height = height
    return
  }
  const scrollTop = node.scrollTop
  const { maxHeight, overflowY } = node.style
  node.style.maxHeight = '0px'
  node.style.overflowY = 'hidden'
  const height = `${Math.min(180, Math.max(40, node.scrollHeight + border))}px`
  node.style.maxHeight = maxHeight
  node.style.overflowY = overflowY
  if (node.style.height !== height) node.style.height = height
  if (node.scrollTop !== scrollTop) node.scrollTop = scrollTop
}

const EMPTY_DRAFT = { typed: '', refused: [] as { seq: number; text: string }[] }

export function CardDetail({ card, roster, actions, live, onOpenCard }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState([])
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const scroller = useRef(null)
  const composer: { current: HTMLTextAreaElement | null } = useRef(null)
  const prevTextLen = useRef(0)
  const pendingSeq = useRef(0)
  const mountedCard = useRef(null)
  const follow = useRef(true)
  const notes = card.notes ?? []
  const shownNotes = useMemo(() => (pending.length > 0 ? [...notes, ...pending] : notes), [notes, pending])
  const said = shownNotes.length
  const steps = live?.steps?.length ?? 0
  const waiting = card.awaiting !== undefined || steps > 0
  const text = [draft.typed, ...draft.refused.map(entry => entry.text)].filter(part => part !== '').join('\n\n')
  const line = noteText(text)
  const count = charCount(line)
  const excess = count - NOTE_MAX
  const sendDisabled = isBlankNote(line) || excess > 0
  const open = OPEN.includes(card.status)
  useLayoutEffect(() => {
    const node = composer.current
    const canShrink = text.length < prevTextLen.current
    prevTextLen.current = text.length
    if (node !== null) {
      if (node.value !== text) node.value = text
      fitComposer(node, canShrink)
    }
  }, [open, text])
  useLayoutEffect(() => {
    const node = composer.current
    if (node === null || typeof ResizeObserver !== 'function') return undefined
    let width = node.getBoundingClientRect().width
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().width
      if (next === width) return
      width = next
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        fitComposer(node)
      })
    })
    observer.observe(node, { box: 'border-box' })
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [open])
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const switched = mountedCard.current !== card.id
    if (switched) {
      mountedCard.current = card.id
      follow.current = true
    }
    if (switched || follow.current) node.scrollTop = node.scrollHeight
  }, [card.id, said, waiting])
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || steps === 0) return
    if (follow.current) node.scrollTop = node.scrollHeight
  }, [steps])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const run = (promise, after?) => {
    setBusy(true)
    setError('')
    Promise.resolve(promise).then(
      () => { setBusy(false); after?.() },
      (failure) => { setBusy(false); setError(String(failure?.message ?? failure)) },
    )
  }
  const editDraft = (typed: string) => {
    setDraft(current => ({
      typed,
      refused: current.refused.filter(entry => !draft.refused.includes(entry)),
    }))
  }
  const sendNote = useCallback((line, original?: string) => {
    const seq = ++pendingSeq.current
    const pendingId = `pending-${seq}`
    const optimistic = { pendingId, pending: true, at: Date.now(), by: USER, text: line }
    follow.current = true
    setError('')
    setPending(list => [...list, optimistic])
    Promise.resolve(actions.boardNote(card.id, line)).then(
      () => { setPending(list => list.filter(entry => entry.pendingId !== pendingId)) },
      (failure) => {
        setPending(list => list.filter(entry => entry.pendingId !== pendingId))
        if (original !== undefined) setDraft(current => ({
          typed: current.typed,
          refused: [...current.refused, { seq, text: original }].sort((a, b) => a.seq - b.seq),
        }))
        setError(String(failure?.message ?? failure))
      },
    )
  }, [actions, card.id])
  const handlePick = useCallback(option => sendNote(option), [sendNote])
  const send = () => {
    if (sendDisabled) return
    editDraft('')
    sendNote(line, text)
  }
  const cancel = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    run(actions.boardCancel(card.id))
  }
  const links = [...(card.url && !card.key ? [{ url: card.url }] : []), ...(card.links ?? [])]
  const allCards = roster.board?.cards ?? {}
  const waitsOnUser = card.status === 'review' || card.status === 'blocked'
  const need = waitsOnUser ? card.need || card.progress || '' : ''
  const progress = need !== '' && !card.need ? '' : card.progress
  const onDetailScroll = (event) => {
    const node = event.currentTarget
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
  }
  return h('div', { className: 'bt-board-sheet-body', 'data-status': card.status },
    h('div', { className: 'bt-board-detail', ref: scroller, onScroll: onDetailScroll, onClick: cardLinkTap(onOpenCard) },
      card.key ? (card.url
        ? h('a', { className: 'bt-board-key', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, card.key)
        : h('span', { className: 'bt-board-key' }, card.key)) : null,
      h('h3', { className: 'bt-board-detail-title' }, card.title),
      h('div', { className: 'bt-board-meta' },
        h(Who, { id: card.assignee, roster, size: 24 }),
        h('span', { className: 'bt-board-age' }, clockLabel(card.createdAt ?? Date.now()))),
      card.status === 'cancelled'
        ? h('div', { className: 'bt-board-status' }, h(Dot, { status: 'cancelled' }), t('Cancelled'))
        : h('label', { className: 'bt-board-status bt-board-move', 'data-status': card.status },
            h(Dot, { status: card.status }),
            h('select', {
              value: card.status, disabled: busy, 'aria-label': t('Move to'),
              onChange: (event) => { if (event.target.value !== card.status) run(actions.boardMove(card.id, event.target.value)) },
            }, COLUMNS.map(([status, name]) => h('option', { key: status, value: status }, t(name))))),
      open ? h('label', { className: 'bt-board-assignee' },
        h('span', { className: 'bt-board-age' }, t('Assignee')),
        h('select', {
          className: 'bt-input bt-board-select', value: card.assignee, disabled: busy, 'aria-label': t('Assignee'), 'data-action': 'reassign',
          onChange: (event) => { if (event.target.value !== card.assignee) run(actions.boardReassign(card.id, event.target.value)) },
        }, h(AssigneeOptions, { assignee: card.assignee, roster }))) : null,
      need ? h('div', { className: 'bt-board-need', 'data-status': card.status, role: 'note' },
        h(BotText, { text: need, cards: allCards, className: 'bt-board-line bt-board-strong' })) : null,
      progress ? h(BotText, { text: progress, cards: allCards, className: 'bt-board-line' }) : null,
      h(Steps, { card, cards: allCards }),
      h(Panes, { card, actions }),
      card.result ? h(BotText, { text: card.result, cards: roster.board?.cards ?? {}, className: 'bt-board-line bt-board-strong' }) : null,
      card.reason ? h(BotText, { text: card.reason, cards: roster.board?.cards ?? {}, className: 'bt-board-line' }) : null,
      links.length > 0 ? h('div', { className: 'bt-board-links' },
        links.map(link => h('div', { key: link.url, className: 'bt-board-md bt-board-link', title: link.url },
          h(MarkdownText, { text: markdownLink(link.url), labels: mdLabels(), variant: 'compact' })))) : null,
      card.brief ? h(Brief, { text: card.brief, cards: allCards }) : null,
      open ? h('button', {
        type: 'button', className: 'bt-board-cancel', 'data-confirm': confirming || undefined, disabled: busy,
        'aria-label': confirming ? t('Click again to cancel') : t('Cancel card'), onClick: cancel,
      }, t('Cancel card')) : null,
      shownNotes.length > 0 || (open && steps > 0) ? h(Thread, {
        notes: shownNotes, roster, awaiting: open ? card.awaiting : undefined, worker: card.assignee, live: open ? live : undefined, busy,
        pick: open ? handlePick : undefined,
      }) : null,
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null),
    open ? h('div', { className: 'bt-board-sheet-foot bt-board-write' },
      h('textarea', {
        ref: composer, className: 'bt-input', defaultValue: '', placeholder: t('Message'), 'aria-label': t('Message'), rows: 1, 'aria-invalid': excess > 0 || undefined,
        onChange: event => editDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' || !sendsOnEnter(roster.prefs) || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
            || event.keyCode === 229 || event.nativeEvent?.isComposing) return
          event.preventDefault()
          send()
        },
      }),
      h('button', { type: 'button', className: 'bt-send', disabled: sendDisabled, onClick: send }, t('Send')),
      h('div', { className: 'bt-board-write-status', 'data-over-limit': excess > 0 || undefined },
        count > NOTE_COUNT_FROM ? h('span', { className: 'bt-board-write-count' },
          t('{count} / {limit}', { count: noteCountFormat.format(count), limit: noteCountFormat.format(NOTE_MAX) })) : null,
        h('span', { className: 'bt-board-write-error', 'aria-live': 'polite' },
          excess > 0 ? t(excess === 1 ? 'Too long by {count} character' : 'Too long by {count} characters', { count: noteCountFormat.format(excess) }) : ''))) : null)
}

const LEVELS = [['off', 'Off'], ['tools', 'Tool calls'], ['thinking', 'Thinking'], ['all', 'All']]
function LevelPick({ level, pick }) {
  return h('label', { className: 'bt-board-level', title: t('Show thinking') },
    h(StepsIcon),
    h('select', { className: 'bt-select', 'aria-label': t('Show thinking'), value: level, onChange: event => { void Promise.resolve(pick(event.target.value)).catch(() => {}) } },
      LEVELS.map(([id, name]) => h('option', { key: id, value: id }, t(name)))))
}

export function BoardScreen({ roster, actions, paneLeft = 0, leaving = false, focus = null }) {
  const { columns, history } = boardColumns(roster.board?.cards)
  const [shown, setShown] = useState(null)
  const [sheet, setSheet] = useState(typeof focus === 'string' && roster.board?.cards?.[focus] ? { card: focus } : null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const close = useCallback(() => actions.closeBoard(), [])
  const back = () => setSheet(null)
  useEscape(() => (sheet !== null ? setSheet(null) : close()))
  const column = shown ?? leadColumn(columns)
  const card = sheet?.card === undefined ? undefined : roster.board?.cards?.[sheet.card]
  const read = card?.unread === true ? card.id : null
  useEffect(() => {
    if (read !== null) Promise.resolve(actions.boardSeen?.(read)).catch(() => {})
  }, [read])
  const openCard = id => setSheet({ card: id })
  const addCard = () => setSheet({ add: true })
  const drop = (event, status) => {
    event.preventDefault()
    setOver(null)
    const id = event.dataTransfer.getData(DRAG_TYPE) || dragging
    setDragging(null)
    const moved = roster.board?.cards?.[id]
    if (moved === undefined || moved.status === status) return
    Promise.resolve(actions.boardMove(id, status)).catch(error => actions.reportError?.(error, 'board'))
  }
  const cardOf = item => h(Card, { key: item.id, card: item, roster, onOpen: openCard, onDrag: setDragging })
  const alone = paneLeft === 0
  return h('div', { className: 'bt-pane bt-board-page', style: { left: paneLeft }, role: 'region', 'aria-label': t('Board'), 'data-leaving': leaving || undefined, 'data-sheet': sheet !== null || undefined },
    h('div', { className: 'bt-board' },
      h('div', { className: 'bt-board-head' },
        alone ? h('button', { type: 'button', className: 'bt-icon-btn bt-board-back', 'aria-label': t('Back'), onClick: close }, h(ChevronLeftIcon)) : null,
        h('h2', null, t('Board')),
        actions.boardTrace ? h(LevelPick, { level: roster.board?.trace ?? 'thinking', pick: actions.boardTrace }) : null,
        h('button', { type: 'button', className: 'bt-send bt-board-add', onClick: addCard }, h(PlusIcon), h('span', null, t('Add card')))),
      h('div', { className: 'bt-board-tabs', role: 'tablist', 'aria-label': t('Board') },
        COLUMNS.map(([status, name]) => h('button', {
          key: status, type: 'button', role: 'tab', className: 'bt-board-tab', 'data-status': status, 'aria-selected': column === status,
          onClick: () => setShown(status),
        }, h('span', { className: 'bt-board-tab-count' }, h(Dot, { status }), columns[status].length), h('span', { className: 'bt-board-tab-name' }, t(name))))),
      h('div', { className: 'bt-board-cols' },
        COLUMNS.map(([status, name]) => h('section', {
          key: status, className: 'bt-board-col', 'data-status': status, 'data-shown': column === status || undefined,
          'data-drop': over === status || undefined, 'aria-label': t(name),
          onDragOver: (event) => { if (dragging === null) return; event.preventDefault(); if (over !== status) setOver(status) },
          onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(null) },
          onDrop: event => drop(event, status),
        },
        h('div', { className: 'bt-board-col-head' }, h(Dot, { status }), h('span', { className: 'bt-board-col-name' }, t(name)), h('span', { className: 'bt-board-count' }, columns[status].length)),
        h('div', { className: 'bt-board-list' },
          columns[status].length > 0 ? columns[status].map(cardOf) : h('div', { className: 'bt-board-empty', 'aria-hidden': true })),
        status === 'done' && history.length > 0
          ? h('button', { type: 'button', className: 'bt-more bt-board-history-toggle', 'aria-expanded': historyOpen, onClick: () => setHistoryOpen(value => !value) },
              historyOpen ? t('Hide history') : t('History ({count})', { count: history.length }))
          : null,
        status === 'done' && historyOpen ? h('div', { className: 'bt-board-list bt-board-history' }, history.map(cardOf)) : null))),
      h('button', { type: 'button', className: 'bt-board-fab', 'aria-label': t('Add card'), onClick: addCard }, h(PlusIcon))),
    sheet !== null ? h('div', { className: 'bt-board-scrim', onMouseDown: back }) : null,
    sheet !== null ? h('div', { className: 'bt-board-sheet', role: 'dialog', 'aria-label': sheet.add ? t('Add card') : card?.title ?? t('Board') },
      h('div', { className: 'bt-board-sheet-head' },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: back }, h(ChevronLeftIcon)),
        sheet.add ? h('h3', null, t('Add card')) : null),
      sheet.add
        ? h(AddCard, { roster, actions, onDone: back })
        : card !== undefined ? h(CardDetail, { key: card.id, card, roster, actions, live: roster.board?.live?.[card.id], onOpenCard: openCard }) : null) : null)
}

export const BOARD_CSS = `
.bt-board-page{left:0;z-index:46;flex-direction:column;animation:bt-veil-in .18s ease-out}
.bt-board-page[data-leaving]{opacity:0;transition:opacity .16s ease-out}
.bt-board{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.bt-board-head{display:flex;align-items:center;gap:8px;padding:16px 24px 8px;flex:none}
.bt-board-head h2{margin:0;flex:1;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.02em}
.bt-board-add{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 16px 0 12px;font-weight:500}
.bt-board-add svg{width:16px;height:16px}
.bt-board-back svg,.bt-board-sheet-head .bt-icon-btn svg{width:16px;height:16px}
.bt-board-back{width:44px;height:44px;margin-left:-12px}
.bt-board-tabs,.bt-board-fab{display:none}
.bt-board-dot{flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--bt-ink-3)}
.bt-board-dot[data-status=active]{background:var(--bt-accent)}
.bt-board-dot[data-status=review]{background:var(--bt-star)}
.bt-board-dot[data-status=blocked]{background:var(--bt-danger)}
.bt-board-dot[data-status=done]{background:var(--bt-green)}
.bt-board-dot[data-status=cancelled]{background:transparent;box-shadow:inset 0 0 0 1.5px var(--bt-ink-3)}
.bt-board-cols{flex:1;min-height:0;display:grid;grid-template-columns:repeat(5,minmax(160px,1fr));align-items:start;gap:16px;padding:16px 24px 32px;overflow:auto}
.bt-board-col{display:flex;flex-direction:column;gap:8px;min-width:0;border-radius:12px;transition:background-color .14s ease}
.bt-board-col[data-drop]{background:var(--bt-accent-soft)}
.bt-board-col-head{display:flex;align-items:center;gap:8px;height:32px;padding:0 4px;font-size:13px;line-height:16px;font-weight:600;color:var(--bt-ink)}
.bt-board-col-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-count{font-size:12px;font-weight:500;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-list{display:flex;flex-direction:column;gap:8px}
.bt-board-empty{height:72px;border-radius:12px;border:1px dashed var(--bt-line-2)}
.bt-board-col[data-drop] .bt-board-empty{border-color:var(--bt-accent)}
.bt-board-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;box-sizing:border-box;text-align:left;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);box-shadow:var(--bt-card-shadow);color:var(--bt-ink);padding:12px;font:inherit;cursor:pointer;transition:border-color .14s ease,transform .14s ease}
.bt-board-card:hover{border-color:var(--bt-line-2)}
.bt-board-card:active{transform:scale(.99)}
.bt-board-card:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-board-card[data-status=cancelled]{opacity:.6}
.bt-board-key{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;font-weight:500;letter-spacing:.01em;text-decoration:none;white-space:nowrap}
a.bt-board-key:hover{color:var(--bt-ink)}
.bt-board-card[data-unread]{border-color:var(--bt-accent)}
.bt-board-card[data-unread] .bt-board-progress{color:var(--bt-ink)}
.bt-board-new{flex:none;width:8px;height:8px;border-radius:50%;background:var(--bt-accent)}
.bt-board-title{width:100%;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.bt-board-progress{width:100%;margin-top:-4px;font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-card-foot{display:flex;align-items:center;gap:8px;width:100%;min-width:0}
.bt-board-who{display:inline-flex;align-items:center;gap:8px;min-width:0;flex:1;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-board-who>.bt-mark,.bt-board-who>svg{flex:none}
.bt-board-me{flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;corner-shape:round;background:var(--bt-user);color:var(--bt-user-ink);font-weight:600;line-height:1}
.bt-board-who-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-has-link{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-board-has-link svg{width:14px;height:14px}
.bt-board-age{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-board-history-toggle{align-self:flex-start;margin:0 4px}
.bt-board-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--bt-ink) 12%,transparent);animation:bt-veil-in .16s ease-out}
.bt-board-sheet{position:absolute;top:0;right:0;bottom:0;width:min(440px,100%);background:var(--bt-main);border-left:.5px solid var(--bt-line);box-shadow:var(--bt-dialog-shadow);display:flex;flex-direction:column;animation:bt-veil-in .16s ease-out}
.bt-board-sheet-head{display:flex;align-items:center;gap:8px;height:56px;padding:0 16px;flex:none}
.bt-board-sheet-head .bt-icon-btn{width:36px;height:36px}
.bt-board-sheet-head h3{margin:0;font-size:16px;line-height:24px;font-weight:600}
.bt-board-sheet-body{flex:1;min-height:0;display:flex;flex-direction:column}
.bt-board-form,.bt-board-detail{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:stretch;gap:16px;padding:8px 24px 24px;contain:layout style}
.bt-board-form .bt-input{height:40px;font-size:14px}
.bt-board-title-input{font-weight:500}
.bt-board-form-row{display:flex;gap:8px}
.bt-board-key-input{flex:0 0 128px;font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);text-transform:uppercase}
.bt-board-sheet-foot{flex:none;display:flex;gap:8px;align-items:center;padding:12px 24px calc(12px + env(safe-area-inset-bottom,0px));border-top:.5px solid var(--bt-line);background:var(--bt-main);contain:layout style}
.bt-board-go{flex:1}
.bt-board-detail>.bt-board-key{align-self:flex-start;margin-bottom:-8px}
.bt-board-detail-title{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
.bt-board-meta{display:flex;align-items:center;gap:8px}
.bt-board-meta .bt-board-who{font-size:13px;color:var(--bt-ink)}
.bt-board-status{position:relative;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:999px;background:var(--bt-hover);font-size:13px;font-weight:500;color:var(--bt-ink)}
.bt-board-move{padding-right:32px;cursor:pointer;background-image:var(--bt-select-arrow);background-repeat:no-repeat;background-position:right 12px center}
.bt-board-move:hover{background-color:var(--bt-active)}
.bt-board-move select{appearance:none;-webkit-appearance:none;border:0;background:none;color:inherit;font:inherit;padding:0;margin:0;cursor:pointer;outline:none}
.bt-board-move select::after{content:''}
.bt-board-move:focus-within{box-shadow:0 0 0 2px var(--bt-accent-soft)}
.bt-board-move select option{color:var(--bt-ink);background:var(--bt-card)}
.bt-board-move::before{content:'';position:absolute;inset:0;border-radius:inherit}
.bt-board-assignee{display:flex;align-items:center;gap:8px}
.bt-board-assignee .bt-input{flex:1;min-width:0;height:36px;font-size:13px}
.bt-board-line{margin:0;font-size:14px;line-height:21px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-board-strong{color:var(--bt-ink)}
.bt-board-need{padding:12px 14px;border-radius:12px;corner-shape:round;background:color-mix(in srgb,var(--bt-star) 12%,transparent);box-shadow:inset 3px 0 0 var(--bt-star)}
.bt-board-need[data-status=blocked]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);box-shadow:inset 3px 0 0 var(--bt-danger)}
.bt-board-steps{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:-8px}
.bt-board-steps-list{display:grid;grid-template-columns:8px auto 1fr;column-gap:8px;row-gap:6px;margin:0;padding:0;list-style:none;align-self:stretch;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-board-step{display:contents}
.bt-board-step .bt-board-dot{align-self:start;margin-top:5.5px}
.bt-board-step .bt-board-age{white-space:nowrap}
.bt-board-step-text{min-width:0;overflow-wrap:anywhere}
.bt-board-panes{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:-8px;align-self:stretch;min-width:0}
.bt-board-pane-toggle{display:inline-flex;align-items:center;gap:6px}
.bt-board-pane-toggle .bt-board-tool-dot{background:var(--bt-ink-3)}
.bt-board-pane-toggle[data-state=working] .bt-board-tool-dot{background:var(--bt-accent);animation:bt-board-pulse 1.2s ease-in-out infinite}
.bt-board-pane-toggle[data-state=done] .bt-board-tool-dot,.bt-board-pane-toggle[data-state=idle] .bt-board-tool-dot{background:var(--bt-green)}
.bt-board-pane-toggle[data-state=blocked] .bt-board-tool-dot{background:var(--bt-danger)}
.bt-board-pane-pick{display:flex;flex-wrap:wrap;gap:6px}
.bt-board-pane-tab{height:26px;padding:0 10px;border:1px solid var(--bt-line);border-radius:13px;background:none;color:var(--bt-ink-2);font:12px/24px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer}
.bt-board-pane-tab[aria-selected=true]{border-color:var(--bt-ink-2);color:var(--bt-ink)}
.bt-board-term{align-self:stretch;margin:0;padding:8px 10px;border-radius:8px;background:var(--bt-hover);font:12px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink);white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.bt-board-pane-gone{color:var(--bt-ink-3)}
.bt-board-brief{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding-top:12px;border-top:1px solid var(--bt-line)}
.bt-board-brief[data-folded] .bt-board-md{max-height:84px;overflow:hidden;mask-image:linear-gradient(to bottom,#000 60%,transparent)}
.bt-board-links{display:flex;flex-direction:column;gap:4px}
.bt-board-link{min-width:0;min-height:28px;font-size:13px;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-link p{display:inline}
.bt-board-options{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.bt-board-option{min-height:32px;max-width:100%;padding:5px 12px;border:1px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px;text-align:left;overflow-wrap:anywhere;cursor:pointer;transition:border-color .14s ease,background-color .14s ease}
.bt-board-option:not(:disabled):hover{border-color:var(--bt-accent);background:var(--bt-accent-soft)}
.bt-board-option:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-board-option:disabled{cursor:default;opacity:.55}
.bt-board-option[data-picked]{opacity:1;border-color:var(--bt-accent);background:var(--bt-accent-soft);font-weight:500}
.bt-board-thread{list-style:none;margin:8px 0 0;padding:16px 0 0;border-top:.5px solid var(--bt-line);display:flex;flex-direction:column;gap:12px}
.bt-board-msg{display:flex;align-items:flex-end;gap:8px;max-width:100%;transition:opacity .16s ease}
.bt-board-msg[data-pending]{opacity:.68}
.bt-board-msg[data-by=user]{justify-content:flex-end}
.bt-board-msg>.bt-board-msg-mark{flex:none;width:24px;height:24px}
.bt-board-msg-body{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:85%}
.bt-board-msg[data-by=user] .bt-board-msg-body{align-items:flex-end}
.bt-board-msg[data-by=bot] .bt-board-msg-body{align-items:flex-start}
.bt-board-msg-text{padding:7px 12px;border-radius:18px;font-size:14px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;text-wrap:pretty}
.bt-board-msg[data-by=user] .bt-board-msg-text{background:var(--bt-user);color:var(--bt-user-ink)}
.bt-board-msg[data-by=bot] .bt-board-msg-text{background:var(--bt-hover);color:var(--bt-ink);white-space:normal;min-width:0;max-width:100%;box-sizing:border-box}
.bt-board-md [class*="_markdown"]{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-board-md [class*="_markdown"]>*+*{margin-top:8px}
.bt-board-md p{margin:0}
.bt-board-md :is(h1,h2,h3,h4,h5,h6){margin:0;font-size:1em;line-height:inherit;font-weight:600}
.bt-board-md ul,.bt-board-md ol{margin:4px 0;padding-left:20px}
.bt-board-md li+li{margin-top:4px}
.bt-board-md li::marker{color:var(--bt-ink-2)}
.bt-board-md :not(pre)>code{line-height:1;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.bt-board-md pre{max-width:100%;overflow-x:auto}
.bt-board-md table{display:block;max-width:100%;overflow-x:auto}
.bt-board-md :is(img,video){max-width:100%;height:auto}
.bt-board-msg .bt-board-age{padding:0 4px}
.bt-board-dots{display:flex;gap:4px;align-items:center;height:34px;padding:0 14px}
.bt-board-dots>i{width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3,currentColor);opacity:.4;animation:bt-board-dot 1.2s ease-in-out infinite}
.bt-board-dots>i:nth-child(2){animation-delay:.15s}
.bt-board-dots>i:nth-child(3){animation-delay:.3s}
@keyframes bt-board-dot{30%{opacity:1;translate:0 -2px}}
@media (prefers-reduced-motion:reduce){.bt-board-dots>i{animation:none}}
.bt-board-waiting .bt-board-msg-body{flex:1;gap:8px}
.bt-board-trace{list-style:none;margin:0;padding:0 0 0 10px;border-left:2px solid var(--bt-line-2);display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-board-trace[data-live]{max-height:240px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.bt-board-step{min-width:0;overflow-wrap:anywhere}
.bt-board-thought{white-space:pre-wrap}
.bt-board-trace[data-live] .bt-board-thought:not(:last-child){display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.bt-board-tool{display:flex;align-items:baseline;gap:8px;color:var(--bt-ink)}
.bt-board-tool-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3);translate:0 -1px}
.bt-board-trace [data-state=running] .bt-board-tool-dot{background:var(--bt-accent);animation:bt-board-pulse 1.2s ease-in-out infinite}
.bt-board-trace [data-state=failed] .bt-board-tool-dot{background:var(--bt-danger)}
.bt-board-tool-text{min-width:0}
.bt-board-tool-fold summary{cursor:pointer;list-style:none}
.bt-board-tool-fold summary::-webkit-details-marker{display:none}
.bt-board-tool-fold summary:hover .bt-board-tool-text{text-decoration:underline;text-decoration-color:var(--bt-line-2);text-underline-offset:3px}
.bt-board-io{margin:6px 0 0 14px;padding:6px 8px;border-radius:6px;background:var(--bt-hover);font:12px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;scrollbar-width:thin}
.bt-board-output{color:var(--bt-ink)}
[data-state=failed] > .bt-board-tool-fold .bt-board-output{color:var(--bt-danger)}
.bt-board-level{display:inline-flex;align-items:center;gap:6px;color:var(--bt-ink-2)}
.bt-board-level .bt-select{min-width:0;height:30px}
@keyframes bt-board-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.bt-board-trace [data-state=running] .bt-board-tool-dot,.bt-board-pane-toggle[data-state=working] .bt-board-tool-dot{animation:none}}
.bt-board-fold{align-self:stretch;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-board-fold summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;padding:0 4px}
.bt-board-fold summary::-webkit-details-marker{display:none}
.bt-board-fold[open] summary{margin-bottom:6px}
.bt-board-fold .bt-board-trace{max-height:240px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.bt-board-cancel{align-self:flex-start;margin-top:8px;height:32px;padding:0;border:0;background:none;color:var(--bt-ink-3);font:inherit;font-size:13px;cursor:pointer}
.bt-board-cancel:hover,.bt-board-cancel[data-confirm]{color:var(--bt-danger)}
.bt-board-cancel[data-confirm]{font-weight:600}
.bt-board-write{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 8px;align-items:end}
.bt-board-write>.bt-input{height:auto;min-height:40px;max-height:180px;padding:9px 11px;line-height:20px;font-size:14px;resize:none;overflow-y:auto}
.bt-board-write-status{grid-column:1/-1;text-align:right;color:var(--bt-ink-2);font-size:12px}
.bt-board-write-status[data-over-limit]{color:var(--bt-danger)}
.bt-board-write-count,.bt-board-write-error:not(:empty){display:block;margin-top:4px}
@media (max-width:640px){
  .bt-board-page{top:0}
  .bt-board-head{padding:12px 8px 8px 16px}
  .bt-board-add{display:none}
  .bt-board-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin:0 16px;padding:2px;border-radius:12px;background:var(--bt-hover);flex:none}
  .bt-board-tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0;height:48px;padding:0 4px;border:0;border-radius:10px;background:none;color:var(--bt-ink-2);font:inherit;cursor:pointer}
  .bt-board-tab[aria-selected=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:var(--bt-card-shadow)}
  .bt-board-tab-count{display:inline-flex;align-items:center;gap:4px;font-size:15px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}
  .bt-board-tab-count>.bt-board-dot{width:6px;height:6px}
  .bt-board-tab-name{max-width:100%;font-size:11px;line-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bt-board-cols{display:block;padding:16px 16px calc(96px + env(safe-area-inset-bottom,0px))}
  .bt-board-col{display:none}
  .bt-board-col[data-shown]{display:flex}
  .bt-board-col-head{display:none}
  .bt-board-empty{height:96px}
  .bt-board-card{padding:16px;gap:8px}
  .bt-board-title{font-size:15px;line-height:22px}
  .bt-board-progress{font-size:13px;line-height:18px}
  .bt-board .bt-board-fab{display:inline-flex;align-items:center;justify-content:center;position:absolute;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:56px;height:56px;border-radius:50%;corner-shape:round;border:0;background:var(--bt-accent);color:var(--bt-main);box-shadow:var(--bt-dialog-shadow);cursor:pointer}
  .bt-board-fab svg{width:22px;height:22px}
  .bt-board-fab:active{transform:scale(.96)}
  .bt-board-sheet{width:100%;border-left:0}
  .bt-board-sheet-head{padding:0 8px}
  .bt-board-form,.bt-board-detail{padding:8px 16px 24px}
  .bt-board-sheet-foot{padding:8px 16px calc(8px + env(safe-area-inset-bottom,0px))}
}
`
