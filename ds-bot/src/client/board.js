// The Board page: the user's work in five columns (Todo, In progress, Review, Blocked,
// Done). Bots put their work on it with the `board` tool; the user adds cards, drags
// them between columns (or moves them from the open card on a phone), adds a note that
// reaches the card's Bot, and cancels. Recent Done cards show; older ones and cancelled
// ones wait under History.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { BotMark } from './mark.js'
import { CloseIcon, ChevronLeftIcon, PlusIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { clockLabel, relativeShort } from './text.js'
import { t } from './i18n.js'

export const COLUMNS = [['todo', 'Todo'], ['active', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done']]
const OPEN = ['todo', 'active', 'review', 'blocked']
const DONE_DAYS = 7
const DONE_SHOWN = 10
const USER = 'user'
const DRAG_TYPE = 'text/x-ds-bot-card'

// The cards in their columns, oldest first; Done newest first, only the last week's and
// at most DONE_SHOWN; the rest of Done and every cancelled card in `history`.
export function boardColumns(cards, now = Date.now()) {
  const all = Object.values(cards ?? {}).filter(card => card && typeof card.id === 'string').sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const columns = Object.fromEntries(OPEN.map(status => [status, all.filter(card => card.status === status)]))
  const done = all.filter(card => card.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt ?? 0) - (a.doneAt ?? a.updatedAt ?? 0))
  const recent = done.filter(card => now - (card.doneAt ?? card.updatedAt ?? 0) < DONE_DAYS * 86_400_000).slice(0, DONE_SHOWN)
  columns.done = recent
  const history = [...done.filter(card => !recent.includes(card)), ...all.filter(card => card.status === 'cancelled')]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return { columns, history }
}

// The column that needs the user first: something to review, then something blocked.
export function leadColumn(columns) {
  return ['review', 'blocked', 'active', 'todo'].find(status => columns[status]?.length > 0) ?? 'todo'
}

function Assignee({ id, roster, size = 18 }) {
  const bot = id === USER ? undefined : roster.byId?.[id]
  if (bot === undefined) return h('span', { className: 'bt-board-you', title: t('You') }, t('You'))
  return h('span', { className: 'bt-board-who', title: bot.name }, h(BotMark, { bot, size }), h('span', { className: 'bt-board-who-name' }, bot.name))
}

function Card({ card, roster, onOpen, onDrag }) {
  return h('button', {
    type: 'button', className: 'bt-board-card', 'data-status': card.status, draggable: true,
    onClick: () => onOpen(card.id),
    onDragStart: (event) => { event.dataTransfer.setData(DRAG_TYPE, card.id); event.dataTransfer.effectAllowed = 'move'; onDrag(card.id) },
    onDragEnd: () => onDrag(null),
  },
  h('span', { className: 'bt-board-card-top' },
    card.key ? h('span', { className: 'bt-board-key' }, card.key) : null,
    h('span', { className: 'bt-board-title' }, card.title)),
  card.progress && card.status !== 'done' ? h('span', { className: 'bt-board-progress' }, card.progress) : null,
  card.status === 'done' && card.result ? h('span', { className: 'bt-board-progress' }, card.result) : null,
  h('span', { className: 'bt-board-card-foot' },
    h(Assignee, { id: card.assignee, roster }),
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
  return h('div', { className: 'bt-board-form' },
    h('input', { className: 'bt-input', value: title, autoFocus: true, placeholder: t('Title'), 'aria-label': t('Title'), maxLength: 200, onChange: event => setTitle(event.target.value), onKeyDown: enter }),
    h('div', { className: 'bt-board-form-row' },
      h('input', { className: 'bt-input bt-board-key-input', value: key, placeholder: 'LIFE-782', 'aria-label': t('Ticket'), maxLength: 32, onChange: event => setKey(event.target.value), onKeyDown: enter }),
      h('input', { className: 'bt-input', value: url, placeholder: 'https://', 'aria-label': t('Link'), inputMode: 'url', onChange: event => setUrl(event.target.value), onKeyDown: enter })),
    h('select', { className: 'bt-input', value: assignee, 'aria-label': t('Assignee'), onChange: event => setAssignee(event.target.value) },
      h('option', { value: USER }, t('You')),
      (roster.bots ?? []).map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    h('button', { type: 'button', className: 'bt-send bt-board-go', disabled: title.trim() === '' || busy, onClick: add }, t('Add card')))
}

function CardDetail({ card, roster, actions }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const open = OPEN.includes(card.status)
  const run = (promise, after) => {
    setBusy(true)
    setError('')
    Promise.resolve(promise).then(
      () => { setBusy(false); after?.() },
      (failure) => { setBusy(false); setError(String(failure?.message ?? failure)) },
    )
  }
  const send = () => {
    const line = text.trim()
    if (line === '' || busy) return
    run(actions.boardNote(card.id, line), () => setText(''))
  }
  const cancel = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    run(actions.boardCancel(card.id))
  }
  const notes = card.notes ?? []
  return h('div', { className: 'bt-board-detail', 'data-status': card.status },
    h('div', { className: 'bt-board-detail-title' },
      card.key ? (card.url
        ? h('a', { className: 'bt-board-key', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, card.key)
        : h('span', { className: 'bt-board-key' }, card.key)) : null,
      h('span', null, card.title)),
    h('div', { className: 'bt-board-meta' },
      h(Assignee, { id: card.assignee, roster, size: 22 }),
      h('span', { className: 'bt-board-age' }, clockLabel(card.createdAt ?? Date.now()))),
    card.status === 'cancelled' ? null : h('div', { className: 'bt-board-moves', role: 'group', 'aria-label': t('Move to') },
      COLUMNS.map(([status, name]) => h('button', {
        key: status, type: 'button', className: 'bt-board-move', 'aria-pressed': card.status === status, disabled: busy,
        onClick: () => { if (card.status !== status) run(actions.boardMove(card.id, status)) },
      }, t(name)))),
    !card.key && card.url ? h('a', { className: 'bt-board-link', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, card.url) : null,
    card.progress ? h('div', { className: 'bt-board-line' }, card.progress) : null,
    card.result ? h('div', { className: 'bt-board-line bt-board-result' }, card.result) : null,
    card.reason ? h('div', { className: 'bt-board-line bt-board-reason' }, card.reason) : null,
    (card.links ?? []).length > 0 ? h('div', { className: 'bt-board-links' },
      card.links.map(link => h('a', { key: link.url, className: 'bt-board-link', href: link.url, target: '_blank', rel: 'noreferrer noopener' }, link.url))) : null,
    notes.length > 0 ? h('div', { className: 'bt-board-notes' },
      notes.map((note, index) => h('div', { key: index, className: 'bt-board-note' },
        h('span', { className: 'bt-board-note-text' }, note.text),
        h('span', { className: 'bt-board-age' }, clockLabel(note.at ?? 0))))) : null,
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    open ? h('div', { className: 'bt-board-write' },
      h('input', {
        className: 'bt-input', value: text, placeholder: t('Add a note'), 'aria-label': t('Add a note'), maxLength: 500,
        onChange: event => setText(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); send() } },
      }),
      h('button', { type: 'button', className: 'bt-send', disabled: text.trim() === '' || busy, onClick: send }, t('Send'))) : null,
    open ? h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm bt-board-cancel', 'data-confirm': confirming || undefined, disabled: busy,
      'aria-label': confirming ? t('Click again to cancel') : t('Cancel card'), onClick: cancel,
    }, confirming ? t('Cancel card') : t('Cancel')) : null)
}

export function BoardDialog({ roster, actions, leaving = false }) {
  const { columns, history } = boardColumns(roster.board?.cards)
  const [shown, setShown] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dragging, setDragging] = useState(null)
  const [over, setOver] = useState(null)
  const close = useCallback(() => actions.closeBoard(), [])
  const back = () => setSheet(null)
  useEscape(() => (sheet !== null ? setSheet(null) : close()))
  const column = shown ?? leadColumn(columns)
  const card = sheet?.card === undefined ? undefined : roster.board?.cards?.[sheet.card]
  const openCard = id => setSheet({ card: id })
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
  return h('div', { className: 'bt-settings-layer bt-board-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-board', role: 'dialog', 'aria-modal': true, 'aria-label': t('Board'), 'data-sheet': sheet !== null || undefined },
      h('div', { className: 'bt-board-head' },
        h('h2', null, t('Board')),
        h('button', { type: 'button', className: 'bt-send bt-board-add', onClick: () => setSheet({ add: true }) }, h(PlusIcon), t('Add card')),
        h('button', { type: 'button', className: 'bt-icon-btn bt-board-close', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-board-tabs', role: 'tablist', 'aria-label': t('Board') },
        COLUMNS.map(([status, name]) => h('button', {
          key: status, type: 'button', role: 'tab', className: 'bt-board-tab', 'data-status': status, 'aria-selected': column === status,
          onClick: () => setShown(status),
        }, t(name), h('span', { className: 'bt-board-count' }, columns[status].length)))),
      h('div', { className: 'bt-board-cols' },
        COLUMNS.map(([status, name]) => h('section', {
          key: status, className: 'bt-board-col', 'data-status': status, 'data-shown': column === status || undefined,
          'data-drop': over === status || undefined, 'aria-label': t(name),
          onDragOver: (event) => { if (dragging === null) return; event.preventDefault(); if (over !== status) setOver(status) },
          onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(null) },
          onDrop: event => drop(event, status),
        },
        h('div', { className: 'bt-board-col-head' }, h('span', null, t(name)), h('span', { className: 'bt-board-count' }, columns[status].length)),
        h('div', { className: 'bt-board-list' }, columns[status].map(cardOf)),
        status === 'done' && history.length > 0
          ? h('button', { type: 'button', className: 'bt-more bt-board-history-toggle', 'aria-expanded': historyOpen, onClick: () => setHistoryOpen(value => !value) },
              historyOpen ? t('Hide history') : t('History ({count})', { count: history.length }))
          : null,
        status === 'done' && historyOpen ? h('div', { className: 'bt-board-list bt-board-history' }, history.map(cardOf)) : null))),
      sheet !== null ? h('div', { className: 'bt-board-sheet' },
        h('div', { className: 'bt-board-sheet-head' },
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: back }, h(ChevronLeftIcon)),
          h('h3', null, sheet.add ? t('Add card') : '')),
        sheet.add
          ? h(AddCard, { roster, actions, onDone: back })
          : card !== undefined ? h(CardDetail, { key: card.id, card, roster, actions }) : null) : null))
}

export const BOARD_CSS = `
.bt-board{--bt-board-w:min(1280px,calc(100vw - 48px));position:relative;width:var(--bt-board-w);height:min(820px,calc(100dvh - 2*max(32px,var(--dsh-frame-overlay-top,32px))));background:var(--bt-main);border-radius:20px;border:.5px solid var(--bt-glass-rim);box-shadow:var(--bt-dialog-shadow);display:flex;flex-direction:column;overflow:hidden;color:var(--bt-ink);animation:bt-dialog-rise .3s ease-out,bt-veil-in .2s ease-out}
.bt-board-head{display:flex;align-items:center;gap:10px;padding:18px 20px 10px 24px}
.bt-board-head h2{margin:0;font-size:17px;line-height:24px;font-weight:600;letter-spacing:-.01em;flex:1}
.bt-board-add{display:inline-flex;align-items:center;gap:6px;height:36px}
.bt-board-add svg{width:16px;height:16px}
.bt-board-close{flex:none}
.bt-board-tabs{display:none}
.bt-board-cols{flex:1;min-height:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:4px 16px 16px;overflow:hidden}
.bt-board-col{display:flex;flex-direction:column;min-height:0;border-radius:12px;background:var(--bt-hover);padding:8px;transition:box-shadow .12s ease}
.bt-board-col[data-drop]{box-shadow:inset 0 0 0 2px var(--bt-accent)}
.bt-board-col-head{display:flex;align-items:center;justify-content:space-between;padding:2px 6px 8px;font-size:13px;line-height:18px;font-weight:600}
.bt-board-count{font-size:12px;font-weight:400;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-col[data-status=review] .bt-board-col-head>span:first-child{color:var(--bt-accent)}
.bt-board-col[data-status=blocked] .bt-board-col-head>span:first-child{color:var(--bt-danger)}
.bt-board-col[data-status=active] .bt-board-col-head>span:first-child{color:var(--bt-green)}
.bt-board-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0}
.bt-board-card{display:flex;flex-direction:column;gap:6px;width:100%;text-align:left;border:.5px solid var(--bt-line);border-radius:10px;background:var(--bt-card,var(--bt-main));color:var(--bt-ink);padding:10px;font:inherit;cursor:pointer;flex:none}
.bt-board-card:hover{border-color:var(--bt-line-2)}
.bt-board-card[data-status=blocked]{border-left:3px solid var(--bt-danger)}
.bt-board-card[data-status=review]{border-left:3px solid var(--bt-accent)}
.bt-board-card[data-status=cancelled]{opacity:.6}
.bt-board-card-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.bt-board-key{flex:none;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-variant-numeric:tabular-nums;text-decoration:none}
a.bt-board-key:hover{text-decoration:underline}
.bt-board-title{min-width:0;font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-progress{font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-card-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}
.bt-board-who{display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-board-who>.bt-mark{flex:none}
.bt-board-who-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-you{font-size:12px;line-height:16px;color:var(--bt-ink-2);padding:0 6px;border-radius:999px;border:.5px solid var(--bt-line-2)}
.bt-board-age{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-history-toggle{align-self:flex-start;margin:8px 6px 0}
.bt-board-history{margin-top:6px}
.bt-board-sheet{position:absolute;top:0;right:0;bottom:0;width:min(420px,100%);background:var(--bt-main);border-left:.5px solid var(--bt-line);box-shadow:var(--bt-dialog-shadow);display:flex;flex-direction:column;animation:bt-veil-in .16s ease-out}
.bt-board-sheet-head{display:flex;align-items:center;gap:6px;padding:16px 16px 4px 12px}
.bt-board-sheet-head h3{margin:0;font-size:15px;line-height:22px;font-weight:600}
.bt-board-form,.bt-board-detail{display:flex;flex-direction:column;gap:10px;padding:8px 20px calc(20px + env(safe-area-inset-bottom,0px));overflow-y:auto;min-height:0}
.bt-board-form-row{display:flex;gap:8px}
.bt-board-key-input{flex:0 0 120px;text-transform:uppercase}
.bt-board-go{align-self:stretch}
.bt-board-detail-title{display:flex;align-items:baseline;gap:8px;font-size:16px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.bt-board-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-board-moves{display:flex;flex-wrap:wrap;gap:6px}
.bt-board-move{height:36px;padding:0 12px;border-radius:999px;border:.5px solid var(--bt-line-2);background:none;color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-board-move[aria-pressed=true]{background:var(--bt-ink);border-color:var(--bt-ink);color:var(--bt-main)}
.bt-board-line{font-size:13px;line-height:19px;color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-board-reason{color:var(--bt-ink-3)}
.bt-board-links{display:flex;flex-direction:column;gap:4px}
.bt-board-link{font-size:13px;line-height:18px;color:var(--bt-accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-notes{display:flex;flex-direction:column;gap:6px}
.bt-board-note{display:flex;justify-content:space-between;gap:8px;padding-left:8px;border-left:2px solid var(--bt-line-2);font-size:13px;line-height:18px}
.bt-board-note-text{min-width:0;overflow-wrap:anywhere}
.bt-board-write{display:flex;gap:8px;align-items:center}
.bt-board-write>.bt-input{flex:1;min-width:0;height:40px}
.bt-board-cancel{align-self:flex-start}
.bt-board-cancel[data-confirm]{color:var(--bt-danger)}
@media (max-width:640px){
  .bt-board-layer{align-items:stretch;justify-content:stretch}
  .bt-board{width:100vw;height:100vh;height:100dvh;border-radius:0;border-width:0}
  .bt-board-head{padding:12px 12px 8px 16px}
  .bt-board-tabs{display:flex;gap:6px;overflow-x:auto;padding:0 12px 8px;scrollbar-width:none;flex:none}
  .bt-board-tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 12px;border-radius:999px;border:.5px solid var(--bt-line-2);background:none;color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
  .bt-board-tab[aria-selected=true]{background:var(--bt-ink);border-color:var(--bt-ink);color:var(--bt-main)}
  .bt-board-tab[aria-selected=true] .bt-board-count{color:inherit;opacity:.7}
  .bt-board-cols{display:block;padding:0 12px calc(12px + env(safe-area-inset-bottom,0px));overflow-y:auto}
  .bt-board-col{display:none;background:none;padding:0}
  .bt-board-col[data-shown]{display:flex}
  .bt-board-col-head{display:none}
  .bt-board-card{padding:12px}
  .bt-board-title{font-size:14px;line-height:20px}
  .bt-board-sheet{width:100%;border-left:0}
}
`
