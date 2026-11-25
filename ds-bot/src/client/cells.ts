import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText, writeClipboard } from './dsh-primitives.ts'
import { inkText } from './inks.ts'
import { linkTexts, linkTarget, textLinks } from './text-links.ts'
import { linkMentions, mentionTarget, dayLabel, contentText, stripHeader, stripToolCallTags, isHiddenTurn, isRelayContext, relaysBefore, relayPart, commRunOf, toolName, toolArgs, reminderPrompts, elapsedLabel, clockLabel, messageClock } from './text.ts'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon, MemoryIcon } from './icons.ts'
import { ChangesCard } from './changes-card.ts'
import { colorOf, toolState, BotMark, RoomAvatar } from './mark.ts'
import { CellEmpty } from './cell-empty.ts'
import { AskUserCell, SettledQuestion } from './questions.ts'
import { AnsweredReply, ClosedView, WidgetCell } from './widget-cell.ts'
import { SecretToolCell } from './secret-card.ts'
import { ConnectorToolCell, MailToolCell } from './connectors.ts'
import { HandoffCall } from './handoff-card.ts'
import { AppAccessCall, ComputerCallRow, ComputerHandoffCall } from './computer.ts'
import { mdLabels, t } from './i18n.ts'
import { call } from './api.ts'
import { failureLabel } from './diagnostics.ts'
import { turnReasoning, thinkingStep, opensReply, stepActivity } from './turn-reasoning.ts'
import { parseReplies, relayRange, stackReplies } from '../shared/group-replies.ts'
import { FOLD_AT, FOLD_HUGE, stripLongNote, useFold } from './fold.ts'
import { ReplyGuide } from './reading.ts'
import { noHover, useViewport, viewBottom } from './motion.ts'
import { BtwCardView } from './btw.ts'
import { partIndexOf, withBtwRows } from './btw-model.ts'
import { ViaTag } from './user-message.ts'
import { layoutOf, thinkingShown } from './themes.ts'

export { clockLabel }


export function Bubbles({ texts, roster, selfId, actions, streaming, sessionId, msgKey, useUi, lead, mentions, fold = FOLD_AT, whole, time, textInteractionSource }) {
  const links = useSyncExternalStore(textLinks.subscribe, textLinks.getSnapshot)
  const onClick = (event) => {
    const link = linkTarget(event, links)
    if (link !== null) {
      event.preventDefault()
      event.stopPropagation()
      link.entry.open(link.id)
      if (link.entry.page) actions.openPage(link.entry.page)
      return
    }
    const target = mentionTarget(event)
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    actions.openSession(target)
  }
  const cleaned = texts.map(stripToolCallTags).filter(text => text.trim() !== '')
  const reactions = useUi ? useUi(state => (msgKey ? state.reactions?.[msgKey] ?? null : null)) : null
  return h('div', { className: 'bt-astack', 'data-lead': lead ? '' : undefined, onClickCapture: onClick },
    cleaned.map((text, index) => {
      const last = index === cleaned.length - 1
      return h(Bubble, {
        key: index, text, index, roster, selfId, actions, sessionId, msgKey, mentions, fold, textInteractionSource, links,
        picked: msgKey ? reactions?.[index] ?? [] : [],
        live: streaming && last,
        lead: lead && last ? lead : null,
        whole: last ? whole : undefined,
      })
    }),
    Number.isFinite(time) ? h('div', { className: 'bt-utime', title: clockLabel(time) }, messageClock(time)) : null)
}

// A folded message's last code block shows only its start; DS Bot draws its own
// copy control for it, bound to the whole block. DSH's and the app's copy
// buttons live in the block's banner and their markup differs, so none of
// theirs is intercepted or cloned.
function FoldCodeCopy({ code, actions }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      if (typeof code === 'function' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        // Safari needs the clipboard write inside the click, before the attachment loads.
        const text = Promise.resolve().then(code).then((value: any) => new Blob([value], { type: 'text/plain' }))
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })])
      } else {
        const text = typeof code === 'function' ? await code() : code
        if (!await writeClipboard(text)) throw new Error('Could not copy the code block')
      }
      setCopied(true); setTimeout(() => setCopied(false), 1000)
    } catch (error) { actions?.reportError?.(error, 'copy') }
  }
  return h('button', { type: 'button', className: 'bt-tool bt-fold-copy', 'aria-label': copied ? t('Copied') : t('Copy'), title: copied ? t('Copied') : t('Copy'), onClick: copy }, copied ? h(CheckIcon) : h(CopyIcon))
}

const foldArea = (body, code, codeHead, actions) => (code === undefined ? body
  : h('div', { className: 'bt-fold-code' },
    body,
    h('pre', { className: 'bt-fold-pre' }, h('code', null, codeHead)),
    h(FoldCodeCopy, { code, actions })))

function Bubble({ text, index, roster, selfId, actions, sessionId, msgKey, mentions, fold, picked, live, lead, whole, textInteractionSource, links = [] }) {
  const { shown, folded, control, code, codeHead } = useFold(text, { limit: fold, whole, live })
  const key = msgKey ? `${msgKey}:${index}` : undefined
  const body = shown === '' ? null : h(MarkdownText, { text: linkMentions(linkTexts(shown, links), roster.bots, selfId), streaming: live, labels: mdLabels(), variant: 'compact', fileMentions: mentions })
  const row = useRef(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  useDismiss(toolsOpen, () => setToolsOpen(false), [row])
  const tapTools = (event) => {
    if (!noHover() || event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]')) return
    setToolsOpen(value => !value)
  }
  const bubble = useRef(null)
  const area = foldArea(body, code, codeHead, actions)
  return h('div', { ref: row, className: 'bt-msg', onClick: tapTools },
    h('div', { className: 'bt-msg-line' },
      lead,
      h('div', { ref: bubble, className: 'bt-bubble', 'data-folded': folded || undefined, 'data-text-interaction-source': textInteractionSource ? '' : undefined },
        control ? h('div', { className: 'bt-fold-body' }, area) : area,
        control),
      h(ReplyGuide, { box: bubble, active: !live && !folded }),
      live ? null : h(MessageTools, { text: folded ? text : shown, name: roster.byId[selfId]?.name ?? t('Bot'), sessionId, react: key ? emoji => actions.toggleReaction(msgKey, index, emoji) : undefined, actions, open: toolsOpen })),
    picked.length ? h('div', { className: 'bt-reacts' }, picked.map(emoji => h('button', {
      key: emoji, type: 'button', className: 'bt-react', 'aria-label': t('Remove reaction {emoji}', { emoji }), onClick: () => actions.toggleReaction(msgKey, index, emoji),
    }, emoji))) : null)
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const STRIP_HALF = (REACTIONS.length * 34 + 10) / 2 + 8

function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (refs.some(ref => ref.current?.contains(event.target))) return
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
}

function MessageTools({ text, name, sessionId, react, actions, open: tapped }) {
  const [panel, setPanel] = useState(null)
  const [copied, setCopied] = useState(false)
  const tools = useRef(null)
  const pop = useRef(null)
  const tick = useViewport()
  const close = () => setPanel(null)
  useDismiss(panel !== null, close, [tools, pop])
  const open = (kind, event) => { if (panel?.kind === kind) { close(); return } setPanel({ kind, node: event.currentTarget }) }
  const place = useMemo(() => {
    if (!panel) return null
    const rect = panel.node.getBoundingClientRect()
    const below = rect.bottom + 220 < viewBottom()
    return panel.kind === 'react'
      ? { left: Math.min(Math.max(rect.left + rect.width / 2, STRIP_HALF), window.innerWidth - STRIP_HALF), top: rect.top - 6, '--bt-origin': 'bottom center' }
      : { left: Math.min(rect.left, window.innerWidth - 208), ...(below ? { top: rect.bottom + 4 } : { bottom: viewBottom() - rect.top + 4, '--bt-origin': 'bottom left' }) }
  }, [panel, tick])
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const item = (label, Icon, run) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { close(); run() } }, h(Icon), label)
  return h('div', { ref: tools, className: 'bt-tools', 'data-open': panel !== null || tapped || undefined },
    react ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': panel?.kind === 'react', onClick: event => open('react', event) }, h(SmileIcon)) : null,
    sessionId ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: () => actions.quote(sessionId, text) }, h(ReplyIcon)) : null,
    h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': panel?.kind === 'more', onClick: event => open('more', event) }, copied ? h(CheckIcon) : h(DotsIcon)),
    panel?.kind === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: place },
      REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    panel?.kind === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: place },
      item(t('Copy'), CopyIcon, copy), item(t('Download'), DownloadIcon, download)), document.body) : null)
}

const thinkingTimes = new Map()
function useThinkingMs({ sessionId, turn, settledSteps, skip }) {
  const key = `${sessionId}:${turn}:${settledSteps}`
  const [ms, setMs] = useState(() => thinkingTimes.get(key))
  useEffect(() => {
    if (skip || thinkingTimes.has(key)) { setMs(thinkingTimes.get(key)); return undefined }
    const control = new AbortController()
    call('thinking', { sessionId, turn }, control.signal)
      .then(value => { thinkingTimes.set(key, value?.ms); setMs(value?.ms) })
      .catch(() => {})
    return () => control.abort()
  }, [key, skip])
  return ms
}

const rowViews = new Map()
export function ThinkingRow({ text, live, at, ms, viewKey, textInteractionSource }) {
  const box = useRef(null)
  const view = useRef(rowViews.get(viewKey))
  const atEnd = useRef(view.current?.atEnd ?? true)
  const [open, setOpen] = useState(view.current?.open ?? false)
  const [fade, setFade] = useState(undefined)
  const remember = patch => { if (viewKey !== undefined) rowViews.set(viewKey, { ...rowViews.get(viewKey), ...patch }) }
  const measure = () => {
    const el = box.current
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2
    remember({ atEnd: atEnd.current, top: el.scrollTop })
    const above = el.scrollTop > 0
    setFade(above && !atEnd.current ? 'both' : above ? 'top' : !atEnd.current ? 'bottom' : undefined)
  }
  const toggle = event => {
    const next = event.currentTarget.open
    if (next) atEnd.current = true
    remember({ open: next })
    setOpen(next)
  }
  useLayoutEffect(() => {
    if (!open) return
    const el = box.current
    const restore = view.current
    view.current = undefined
    if (atEnd.current) el.scrollTop = el.scrollHeight
    else if (restore?.top !== undefined) el.scrollTop = restore.top
    measure()
  }, [text, open])
  const title = live ? t('Thinking') : t('Thought it through')
  return h('details', { className: 'bt-think', open, onToggle: toggle },
    h('summary', null, title,
      live && at !== undefined ? h(Elapsed, { at, className: 'bt-think-time' }) : null,
      !live && ms !== undefined ? h('span', { className: 'bt-think-time' }, `· ${elapsedLabel(Math.max(1000, ms))}`) : null),
    h('div', { ref: box, className: 'bt-think-text', role: 'region', 'aria-label': title, tabIndex: 0, 'data-fade': fade, 'data-text-interaction-source': textInteractionSource && !live ? '' : undefined, onScroll: measure }, text))
}

function useFileMentions({ node, openFile, fileMentions, useTurnData }) {
  const tail = useTurnData?.('turn-tail')
  const location = node.location
  const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
  const seq = node.data.finalNode?.seq
  return useMemo(() => {
    if (typeof fileMentions !== 'function' || turn?.status !== 'closed' || seq === undefined) return undefined
    return tail?.closing?.finalNode.seq === seq ? fileMentions({ turn, seq, openFile }) : undefined
  }, [fileMentions, openFile, seq, tail, turn])
}

export function AssistantCell({ node, groupPart, sessionId, openFile, fileMentions, useTurnData, useRoster, useUi, useTurnSteps, useTurnContext, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const steps = useTurnSteps(String(data.turn))
  const contexts = useTurnContext(String(data.turn))
  const mentions = useFileMentions({ node, openFile, fileMentions, useTurnData })
  const hidden = Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, data.turn)
  const texts = groupPart === 'reasoning' ? [] : data.blocks
    .filter(block => block.kind === 'text')
    .map(block => stripToolCallTags(block.text))
    .filter(text => text.trim() !== '')
  const running = data.status === 'running'
  const textInteractionSource = data.status === 'settled' && data.finalNode?.messageId !== undefined
  const members = steps.length ? steps : [data]
  const shown = thinkingShown(roster.prefs)
  const reasoning = groupPart === 'response' || !shown ? '' : turnReasoning(steps, data)
  const thinking = groupPart === 'response' || !shown ? undefined : thinkingStep(members)
  const ms = useThinkingMs({ sessionId, turn: data.turn, settledSteps: members.filter(step => step.status !== 'running').length, skip: hidden || reasoning === '' })
  useLiveNote(actions, sessionId, `text:${node.key ?? data.seq}`, !hidden && running && texts.length > 0 ? { text: true } : null)
  if (hidden) return h(CellEmpty)
  // A relay spliced mid-turn is a 'context' node, hidden from the chat flow on
  // DSH 0.2; the step that answers it shows the event line where it was read,
  // once, in the step's first cell.
  const relays = relayPart(data, groupPart) ? relaysBefore(contexts, steps, data) : []
  const activity = groupPart === 'response' ? [] : stepActivity(data)
  if (texts.length === 0 && !reasoning && relays.length === 0 && activity.length === 0) return h(CellEmpty)
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[sessionId] : undefined
  const head = speaker !== undefined && opensReply(steps, data, shown)
    && (reasoning !== '' || (texts.length > 0 && !(groupPart === 'response' && shown && turnReasoning(steps, data) !== '')))
  return h(Fragment, null,
    relays.map(relay => {
      const source = relay.source
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      return h(EventLine, {
        key: relay.seq,
        prefix: source.role === 'stopped' ? t('Stopped by') : source.role === 'reply' ? t('Reply from') : t('Message from'),
        bots: [sender],
        onOpen: () => { if (sender.id) actions.openExchange(selfId, sender.id) },
        whole: true,
      })
    }),
    head ? h(SpeakerHead, { bot: speaker, time: data.time }) : null,
    activity.length ? h('div', { className: 'bt-agent-activity' }, activity.map((line, index) => h('div', { key: index, className: 'bt-agent-act', title: line }, h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }), h('span', { className: 'bt-agent-act-text' }, activityParts(line))))) : null,
    reasoning ? h(ThinkingRow, {
      text: reasoning, live: thinking !== undefined, viewKey: `${sessionId}:${data.turn}`, textInteractionSource,
      ...(thinking !== undefined ? { at: typeof thinking.time === 'number' ? thinking.time - (ms ?? 0) : undefined } : { ms }),
    }) : null,
    texts.length ? h(Bubbles, { texts, roster, selfId, actions, streaming: running, sessionId, msgKey: `${sessionId}:${data.turn}:${node.key ?? data.seq ?? ''}`, useUi, mentions, fold: FOLD_HUGE, time: speaker === undefined ? data.time : undefined, textInteractionSource }) : null)
}

const activityParts = line => line.split('`').map((part, index) => (index % 2 === 1 ? h('code', { key: index }, part) : part))

function EventLine({ prefix, bots, joiner = t('and'), onOpen, whole = false }) {
  if (whole && bots.length === 1) {
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', title: bots[0].name, onClick: () => onOpen?.(bots[0]) },
        h('span', null, prefix), h(BotMark, { bot: bots[0], size: 16 }), h('span', { className: 'bt-event-name' }, bots[0].name)))
  }
  const parts = []
  parts.push(h('span', { key: 'p' }, prefix))
  bots.forEach((bot, index) => {
    if (index > 0) parts.push(h('span', { key: `j${index}` }, joiner))
    parts.push(h('button', { key: bot.id ?? index, type: 'button', onClick: () => onOpen?.(bot) },
      h(BotMark, { bot, size: 16 }), bot.name))
  })
  return h('div', { className: 'bt-event' }, parts)
}

function SpeakerHead({ bot, time }) {
  return h('div', { className: 'bt-group-name' },
    h('span', { className: 'bt-lead' }, h(BotMark, { bot, size: 22 })), bot.name,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null)
}

const CHAIN_BREAK_SEL = '.bt-group-msg, .bt-umsg, .bt-urow, [data-chat-flow-kind=user], [data-chat-flow-kind=command-input], .bt-q-inline, .bt-event, .bt-time-sep, .bt-new-sep, .bt-part-line, .bt-btw-card, .bt-learn-card'
export function syncGroupChains(flow) {
  const items = [...flow.querySelectorAll(CHAIN_BREAK_SEL)]
  for (let i = 0; i < items.length; i += 1) {
    const curr = items[i]
    if (!curr.classList.contains('bt-group-msg')) continue
    const prev = items[i - 1]
    const next = items[i + 1]
    const botId = curr.dataset.botId
    const chainPrev = Boolean(botId && prev?.classList.contains('bt-group-msg') && prev.dataset.botId === botId)
    const chainNext = Boolean(botId && next?.classList.contains('bt-group-msg') && next.dataset.botId === botId)
    if (chainPrev) curr.dataset.chainPrev = ''; else delete curr.dataset.chainPrev
    if (chainNext) curr.dataset.chainNext = ''; else delete curr.dataset.chainNext
    const turn = curr.closest('[data-chat-group-key]')
    if (turn) {
      if (chainPrev) turn.dataset.btChainPrev = ''; else delete turn.dataset.btChainPrev
      if (chainNext) turn.dataset.btChainNext = ''; else delete turn.dataset.btChainNext
    }
  }
}

const pendingFlows = new WeakSet()
function scheduleGroupChains(flow) {
  if (!flow || pendingFlows.has(flow)) return
  pendingFlows.add(flow)
  queueMicrotask(() => {
    pendingFlows.delete(flow)
    if (flow.isConnected !== false) syncGroupChains(flow)
  })
}

export function claimLines(claims) {
  if (claims === undefined || claims === null) return []
  const lines = []
  if (claims.inProgress === true) {
    lines.push({
      kind: 'inProgress',
      text: t('No background work detected'),
      detail: t('DS Bot has no recorded tool call or active background task for this reply.'),
    })
  }
  for (const path of claims.missingFiles ?? []) lines.push({ kind: 'file', text: t('File not found: {path}', { path }) })
  return lines
}

export function GroupMessage({ bot, text, texts = [text], room, sessionId, roster, actions, msgKey, useUi, whole, time, duration, claims, changes }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.closest) return undefined
    const flow = el.closest('[data-chat-flow]')
    if (!flow) return undefined
    scheduleGroupChains(flow)
    return () => scheduleGroupChains(flow)
  }, [bot.id])
  const lead = h('button', { type: 'button', className: 'bt-lead', 'aria-label': t("Open {name}'s chat", { name: bot.name }), onClick: () => actions.openSession(bot.id) },
    h(BotMark, { bot, size: 22 }))
  const flat = layoutOf(roster.prefs) === 'flat'
  const took = Number.isFinite(duration) && duration >= 1000 ? elapsedLabel(duration) : undefined
  const quoteSession = sessionId ?? room?.sessionId ?? room?.id
  return h('div', { ref, className: 'bt-group-msg', 'data-bot-id': bot.id },
    h('span', { className: 'bt-group-name', style: flat ? undefined : { color: inkText(colorOf(bot)) } }, flat ? lead : null, bot.name,
      room?.admin === bot.id ? h('span', { className: 'bt-group-role' }, t('Admin')) : null,
      Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null,
      took ? h('span', { className: 'bt-group-took', title: t('Ran for {duration}', { duration: took }) }, took) : null),
    h(Bubbles, { texts, roster, selfId: bot.id, actions, sessionId: quoteSession, msgKey, useUi, lead: flat ? null : lead, whole, textInteractionSource: true }),
    changes === undefined ? null : h(ChangesCard, { changes, actions }),
    claimLines(claims).map(line => h('div', { key: line.kind + line.text, className: `bt-claim bt-claim-${line.kind}`, role: 'status', title: line.detail ?? undefined }, line.text)))
}

function GroupEvent({ prefix, room, name, roster, actions }) {
  return h('div', { className: 'bt-event' },
    h('span', null, prefix),
    room ? h('button', { type: 'button', onClick: () => actions.openSession(room.id) }, h(RoomAvatar, { room, roster, size: 16 }), room.name)
      : name ? h('span', null, name) : null)
}

const MEMORY_SAVED = /^(Saved to|Updated in|Removed from) /
const MEMORY_ALREADY = /^Already in /

const MEMORY_TEAM = /^(team|团队|共享)$/i
const MEMORY_OWN = /^(own|me|mine|self|yours?|自己|我)$/i
const MEMORY_GROUP = /^(group|this group|群|本群|群聊)$/i

function memoryFailure(code) {
  if (!code) return undefined
  switch (code) {
    case 'memory/empty': return t('Write something to save')
    case 'memory/no-match': return t('No saved entry matched')
    case 'memory/refused':
    case 'memory/denied': return t('The memory refused this change')
    default: return t('The memory could not be changed')
  }
}

function MemoryEvent({ sessionId, scope, tool, result, failed, code, roster, actions, findBot }) {
  const self = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const named = String(scope ?? '').trim()
  const team = MEMORY_TEAM.test(named)
  const other = team || named === '' ? undefined : findBot(named)
  const target = other && other.id !== self?.id ? other : self
  const panel = team ? self?.id
    : MEMORY_OWN.test(named) ? self?.id
      : MEMORY_GROUP.test(named) ? room?.id
        : named === '' ? (room?.id ?? self?.id)
          : other?.id
  if (!failed && MEMORY_ALREADY.test(result)) {
    return h('div', { className: 'bt-event' },
      panel === undefined ? h('span', null, h(MemoryIcon), t('Already saved')) : h('button', { type: 'button', onClick: () => actions.openMemory(panel) }, h(MemoryIcon), t('Already saved')))
  }
  if (!failed && MEMORY_SAVED.test(result)) {
    if (!target) return h(CellEmpty)
    const label = team ? t('Team memory updated') : target === self ? t('Memory updated') : t("Updated {name}'s memory", { name: target.name })
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', title: result, onClick: () => actions.openMemory(target.id) }, h(MemoryIcon), label))
  }
  const reason = memoryFailure(code)
  const label = failed
    ? (tool === 'forget' ? t("Couldn't remove from memory") : t("Couldn't save to memory"))
    : t('Memory not changed')
  return h('div', { className: 'bt-event bt-event-error', role: 'status', title: code },
    h('span', null, h(MemoryIcon), label),
    reason ? h('span', null, ` · ${reason}`) : null,
    panel === undefined ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openMemory(panel) }, t('Manage')))
}

function PartLine({ time }) {
  return h('div', { className: 'bt-part-line', role: 'separator' }, Number.isFinite(time) ? h('span', null, dayLabel(time)) : null)
}

const scrollParent = (node) => {
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return null
}

function EarlierUser({ row, actions }) {
  const { shown, folded, control, code, codeHead } = useFold(row.text ?? '')
  const body = row.text && shown !== '' ? h(MarkdownText, { text: shown, labels: mdLabels(), variant: 'compact' }) : null
  const area = foldArea(body, code, codeHead, actions)
  return h('div', { className: 'bt-urow' }, h('div', { className: 'bt-ububble', 'data-folded': folded || undefined, 'data-text-interaction-source': body || code !== undefined ? '' : undefined },
    control ? h('div', { className: 'bt-fold-body' }, area) : area,
    control,
    row.images ? h('span', { className: 'bt-uimages', 'data-text-interaction-exclude': '' }, row.images === 1 ? t('1 image') : t('{count} images', { count: row.images })) : null),
    row.via ? h('div', { className: 'bt-utime' }, h(ViaTag, { via: row.via }), Number.isFinite(row.time) ? messageClock(row.time) : null) : null)
}

function EarlierParts({ sessionId, roster, actions }) {
  const [view, setView] = useState({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null })
  const top = useRef(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const restore = useRef(null)
  const load = (cursor) => {
    if (busy.current) return
    const mine = generation.current
    const room = roster.roomsById[sessionId]
    const owner = roster.byId[sessionId] ?? (room === undefined ? undefined : { parts: room.ownParts, sessionId: room.sessionId })
    const partIndex = partIndexOf(owner, sessionId, cursor)
    busy.current = true
    setView(current => ({ ...current, loading: true, failed: false }))
    actions.earlier(sessionId, cursor).then((page) => {
      if (mine !== generation.current) return
      busy.current = false
      // The chat's scroller does not anchor content prepended above the viewport,
      // so the page keeps its distance from the end by hand.
      const scroller = top.current && scrollParent(top.current)
      if (scroller) restore.current = { scroller, fromEnd: scroller.scrollHeight - scroller.scrollTop }
      const incoming = Array.isArray(page.items) ? page.items : []
      setView(current => {
        const pages = current.pages.slice()
        const at = pages.findIndex(entry => entry.partIndex === partIndex)
        const btw = Array.isArray(page.btw) ? page.btw : (at >= 0 ? pages[at].btw : [])
        if (at >= 0) pages[at] = { partIndex, items: [...incoming, ...pages[at].items], btw }
        else pages.push({ partIndex, items: incoming, btw })
        pages.sort((a, b) => a.partIndex - b.partIndex)
        return { pages, cursor: page.cursor, loading: false, failed: false, startedAt: page.startedAt ?? current.startedAt }
      })
    }, () => {
      if (mine !== generation.current) return
      busy.current = false
      setView(current => ({ ...current, loading: false, failed: true }))
    })
  }
  const closedEarlier = JSON.stringify((roster.byId[sessionId]?.parts ?? []).map(part => roster.closedCards?.[part] ?? null))
  useEffect(() => {
    generation.current += 1
    busy.current = false
    setView({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null })
    load(undefined)
    return () => { generation.current += 1 }
  }, [sessionId, closedEarlier])
  useLayoutEffect(() => {
    const pending = restore.current
    restore.current = null
    if (pending) pending.scroller.scrollTop = pending.scroller.scrollHeight - pending.fromEnd
  }, [view.pages])
  useEffect(() => {
    const node = top.current
    if (!node || view.loading || view.failed || !view.cursor || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) load(view.cursor)
    }, { root: scrollParent(node), rootMargin: '600px 0px 0px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [view.cursor, view.loading, view.failed])
  const removeBtw = cardId => setView(current => ({
    ...current,
    pages: current.pages.map(page => ({ ...page, btw: page.btw.filter(card => card?.id !== cardId) })),
  }))
  const items = []
  for (const page of view.pages) items.push(...withBtwRows(page.items, page.btw))
  return h('div', { className: 'bt-earlier', role: 'feed', 'aria-label': t('Earlier messages'), 'aria-busy': view.loading },
    h('div', { ref: top, className: 'bt-earlier-top' },
      view.loading ? h(Shimmer, null, t('Loading earlier messages…'))
        : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Couldn’t load earlier messages · Retry'))
          : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Load earlier')) : null),
    h(ChatRows, { items, sessionId, roster, actions, onBtwDelete: removeBtw }),
    h(PartLine, { time: view.startedAt }))
}

export function ChatRows({ items, sessionId, roster, actions, useUi, clock = false, onBtwDelete }) {
  const selfId = roster.byId[sessionId]?.id
  const rows = []
  for (const item of items) {
    const last = rows.at(-1)
    if (item.kind === 'bot' && last?.kind === 'bot') {
      last.texts.push(item.text)
      last.end = item.time
    } else rows.push(item.kind === 'bot' ? { kind: 'bot', texts: [item.text], time: item.time, end: item.time } : item)
  }
  let before
  return rows.flatMap((row, index) => {
    const key = rows.length - index
    const shown = chatRow(row, key, { sessionId, selfId, roster, actions, useUi, onBtwDelete })
    if (row.kind === 'divider') {
      before = undefined
      return [shown]
    }
    const pause = clock && Number.isFinite(row.time) && (before === undefined || row.time - before >= SEPARATOR_GAP_MS)
    if (Number.isFinite(row.end ?? row.time)) before = row.end ?? row.time
    return pause ? [h('div', { key: `${key}:clock`, className: 'bt-time-sep', role: 'separator' }, clockLabel(row.time)), shown] : [shown]
  })
}

function chatRow(row, key, { sessionId, selfId, roster, actions, useUi, onBtwDelete }) {
  switch (row.kind) {
    case 'divider': return h(PartLine, { key, time: row.time })
    case 'user': return h(EarlierUser, { key, row, actions })
    case 'answer': return h(AnsweredReply, { key, node: { data: row } })
    case 'closed': return row.view === undefined
      ? h('div', { key, className: 'bt-q-inline' }, h(SettledQuestion, { question: row.question, closed: row.closed }))
      : h(ClosedView, { key, title: row.title, view: row.view, closed: row.closed })
    case 'view': return h(WidgetCell, { key, sessionId, callId: row.callId, args: { text: name => name === 'title' ? row.title : undefined, value: name => name === 'view' ? row.view : undefined }, done: true, isError: false, roster, actions })
    case 'bot': {
      const bubbles = h(Bubbles, { key, texts: row.texts, roster, selfId, actions, sessionId: useUi ? sessionId : undefined, msgKey: useUi ? `${sessionId}:${row.time}` : undefined, useUi, fold: FOLD_HUGE, textInteractionSource: true })
      const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[selfId] : undefined
      return speaker ? h(Fragment, { key }, h(SpeakerHead, { bot: speaker, time: row.time }), bubbles) : bubbles
    }
    case 'btw': return h(BtwCardView, { key, card: row.card, sessionId, actions, onDeleted: onBtwDelete })
    case 'post': {
      const poster = roster.byId[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
      return h(GroupMessage, {
        key, bot: poster, text: row.file ? stripLongNote(row.text) : row.text, texts: row.texts, room: roster.roomsById[sessionId], sessionId, roster, actions,
        msgKey: `${sessionId}:post:${row.seq ?? row.time}`, time: row.time, duration: row.duration, claims: row.claims, changes: row.changes,
        whole: row.file ? { length: row.length, load: () => actions.fileText(row.file) } : undefined,
      })
    }
    case 'relay': {
      const reply = row.reply
      const speaker = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name ?? t('a Bot'), color: reply.color ?? 'gray' }
      return h(RelayEvent, { key, reply, bot: speaker, sessionId, actions })
    }
    case 'event': {
      if (row.role === 'report') return h(GroupEvent, { key, prefix: t('Replies from'), room: roster.roomsById[row.roomId], name: t('a group chat'), roster, actions })
      const other = roster.byId[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
      const prefix = { stopped: t('Stopped by'), reply: t('Reply from') }[row.role] ?? t('Message from')
      return h(EventLine, { key, prefix, bots: [other], onOpen: () => { if (selfId && other.id) actions.openExchange(selfId, other.id) }, whole: true })
    }
    default: return null
  }
}

export function TriggerCell({ node, sessionId, useRoster, useSessions, useTurnClock, useUi, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  const deferred = source.kind === 'bot' && source.deferred === true
  const relayed = isRelayContext(data)
  const turn = node.location?.turn?.turn ?? data.turn
  useLayoutEffect(() => {
    if (relayed) actions.noteTurnPeer(sessionId, turn, source.senderSessionId)
  }, [relayed, sessionId, turn, source.senderSessionId])
  const order = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.map(entry => entry.turn).join(',') : ''
  })
  const peers = useTurnClock((state) => {
    if (!relayed) return ''
    const turns = state[sessionId] ?? {}
    return Object.keys(turns).filter(key => turns[key].peer !== undefined).map(key => `${key}:${turns[key].peer}`).join(',')
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const hiddenTurns = roster.exchangeTurns[sessionId]
  const unreadOpening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], order, hiddenTurns)
    return first?.turn === turn && unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  const body = triggerBody()
  return unreadOpening
    ? h(Fragment, null, h('div', { className: 'bt-open-new' }, h(NewDivider), h('div', { className: 'bt-time-sep', role: 'separator' }, unreadOpening)), body)
    : (body ?? h(CellEmpty))

  function triggerBody() {
    if (source.kind === 'bot') {
      if (source.handoff === true) return h(EarlierParts, { sessionId, roster, actions })
      if (source.role === 'kickoff' || source.role === 'room' || source.role === 'goal') return null
      if (source.role === 'secret' || deferred) return null
      if (source.role === 'update') return h('div', { className: 'bt-event' }, t('Profile updated'))
      if (source.role === 'post') {
        if (source.logged !== undefined) return null
        if (source.failed !== undefined || source.resumed === true || source.stopped === true || source.done === true) return null
        const room = roster.roomsById[sessionId]
        const poster = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
        const file = source.length === undefined ? undefined : (data.content ?? []).find(block => block?.type === 'file')?.attachment
        const text = stripHeader(contentText(data.content))
        return h(GroupMessage, {
          bot: poster, text: file ? stripLongNote(text) : text, room, sessionId, roster, actions, msgKey: `${sessionId}:post:${data.seq ?? node.key}`, useUi, time: data.time,
          claims: source.claims,
          changes: source.changes,
          whole: file ? { length: source.length, load: () => actions.fileText(file) } : undefined,
        })
      }
      if (source.role === 'report') {
        return h(GroupEvent, { prefix: t('Replies from'), room: roster.roomsById[source.roomId], name: t('a group chat'), roster, actions })
      }
      if (source.role === 'card' || source.role === 'wake') return h('div', { className: 'bt-event' }, stripHeader(contentText(data.content)).split('\n')[0].slice(0, 120))
      if (source.role === 'resume' || source.resumed === true) return h('div', { className: 'bt-event' }, t('Picked up its work after a restart'))
      if (source.role === 'retry' || source.retried === true) return h('div', { className: 'bt-event' }, t('Asked to make the tool call it wrote as text'))
      if (source.role === 'continue') return h('div', { className: 'bt-event' }, t('Went on after the failed turn'))
      const run = relayed ? commRunOf(
        order.split(',').filter(Boolean).map(Number),
        Object.fromEntries(peers.split(',').filter(Boolean).map(pair => [Number(pair.slice(0, pair.indexOf(':'))), pair.slice(pair.indexOf(':') + 1)])),
        turn,
        hiddenTurns,
      ) : null
      if (run === 'folded') return null
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      const count = run?.count ?? (isHiddenTurn(roster, sessionId, turn) ? 2 : 1)
      const bots = [sender]
      for (const peer of (run?.peerIds ?? []).map(id => roster.byId[id]).filter(Boolean)) {
        if (!bots.some(bot => bot.id === peer.id)) bots.push(peer)
      }
      return h(EventLine, {
        prefix: source.role === 'stopped' ? t('Stopped by') : count > 1 ? t('{count} messages with', { count }) : t('Message from'),
        bots,
        onOpen: bot => actions.openExchange(selfId, bot.id),
        whole: true,
      })
    }
    if (source.kind === 'schedule') {
      const prompts = reminderPrompts(contentText(data.content))
      return h('div', { className: 'bt-event' }, prompts.length > 0 ? t('Scheduled task: {text}', { text: prompts.join(' · ').slice(0, 80) }) : t('Routine started'))
    }
    if (source.kind === 'user-question-reply' || source.kind === 'goal') return null
    return h('div', { className: 'bt-event' }, contentText(data.content).slice(0, 80) || t('Update'))
  }
}

function NewDivider() {
  return h('div', { className: 'bt-new-sep', role: 'separator', 'aria-label': t('New messages') }, h('span', null, t('New')))
}

export function TurnProcessCell({ node, sessionId, turnProcess, useRoster, useUi, useTurnClock, actions }) {
  const open = turnProcess === undefined || !turnProcess.foldable || turnProcess.open
  useEffect(() => {
    if (!open) turnProcess.setOpen(true)
  }, [open, turnProcess])
  const turn = node?.location?.turn?.turn ?? node?.data?.turn
  const start = node?.location?.turn?.start?.time
  const hidden = useRoster(roster => isHiddenTurn(roster, sessionId, turn))
  useEffect(() => {
    actions.noteTurnTime(sessionId, turn, 'first', start)
  }, [sessionId, turn, start])
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    const own = state[sessionId]?.[turn]
    return !hidden && typeof visit?.seen === 'number' && own?.first !== undefined && own.first <= visit.seen
      && own.end !== undefined && own.end > visit.seen && own.end <= visit.entered
  })
  return fresh ? h(NewDivider) : h(CellEmpty)
}

export function Nothing() { return null }

export { CellEmpty }

const SEPARATOR_GAP_MS = 30 * 60 * 1000
function nextTurnStart(turns, turn) {
  let next
  for (const key in turns) {
    const candidate = Number(key)
    if (candidate > turn && turns[key].first !== undefined && (next === undefined || candidate < next)) next = candidate
  }
  return next === undefined ? undefined : turns[next].first
}
export function openingTurn(turns, firstTurns, hiddenTurns) {
  if (!turns || !firstTurns) return null
  const start = nextTurnStart(turns, -Infinity)
  if (start === undefined) return null
  const turn = Number(Object.keys(turns).filter(key => turns[key].first === start)[0])
  const listed = firstTurns.split(',').map(Number)
  const earlier = listed.filter(entry => entry < turn)
  return listed.includes(turn) && earlier.every(entry => hiddenTurns?.includes(entry)) ? { turn, start } : null
}
export const unseenSince = (visit, time) => typeof visit?.seen === 'number' && time > visit.seen && time <= visit.entered

export function TurnTailCell({ turn: location, sessionId, useTurnClock, useUi, actions }) {
  const turn = location.turn
  // DSH builds the tail from the turn's end, so it is there.
  const time = location.end.time
  useEffect(() => { actions.noteTurnTime(sessionId, turn, 'end', time) }, [sessionId, turn, time])
  const label = useTurnClock((state) => {
    const start = nextTurnStart(state[sessionId] ?? {}, turn)
    return start !== undefined && start - time >= SEPARATOR_GAP_MS ? clockLabel(start) : ''
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number' || time > visit.seen) return false
    const start = nextTurnStart(state[sessionId] ?? {}, turn)
    return start !== undefined && start > visit.seen && start <= visit.entered
  })
  if (!label && !fresh) return null
  return h(Fragment, null,
    label ? h('div', { className: 'bt-time-sep', role: 'separator' }, label) : null,
    fresh ? h(NewDivider) : null)
}

export function Shimmer({ children }) {
  return h('span', { className: 'bt-shimmer' }, children)
}

export function Elapsed({ at, className }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | number = 0
    const tick = () => {
      const time = Date.now()
      setNow(time)
      timer = setTimeout(tick, 1000 - (((time - at) % 1000) + 1000) % 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [at])
  return h('span', { className }, `· ${elapsedLabel(Math.max(1000, now - at))}`)
}

export const PHRASES = {
  thinking: ['Thinking about it', 'Weighing the options', 'Working out a plan', 'Sorting out the details'],
  working: ['On it', 'Busy with it', 'Moving ahead', 'Taking care of it', 'Making headway'],
}
const TOOL_PHRASES: [RegExp, string][] = [
  [/^cua(_driver_native__|$)|^computer_/, 'Using the computer'],
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/grep|glob|list_dir|^ls$|find|search/i, 'Looking through files'],
  [/write|edit|patch|apply|replace/i, 'Writing changes'],
  [/image|photo|draw/i, 'Working on an image'],
]
const GROUP_PHRASES = { create_group: 'Creating a group', update_group: 'Updating the group', delete_group: 'Deleting the group', post_to_group: 'Posting in the group' }
function toolActivity(name, arg, findBot, self?) {
  switch (name) {
    case 'ask_user': return null
    case 'request_secret': return null
    case 'list_secrets': return { label: t('Checking the keys'), state: 'searching' }
    case 'ask_user_question': return { label: t('Waiting for your answer'), state: 'alert' }
    case 'group_relay': return { relay: true, state: 'orbit' }
    case 'message_bot': {
      const target = findBot(arg('to'))
      return { label: target ? t('Asking {name}', { name: target.name }) : t('Asking another Bot'), state: 'sending' }
    }
    case 'stop_bot': {
      const target = findBot(arg('bot'))
      return { label: target ? t('Stopping {name}', { name: target.name }) : t('Stopping another Bot'), state: 'sending' }
    }
    case 'create_bot': return { label: t('Creating {name}', { name: arg('name') ?? t('a Bot') }), state: 'sending' }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return { label: t('Updating {name}', { name: target?.name ?? t('a Bot') }), state: 'sending' }
    }
    case 'list_bots': return { label: t('Checking the team'), state: 'searching' }
    case 'read_group_chat': return { label: t('Reading {name}', { name: arg('group') ?? t('a group chat') }), state: 'searching' }
    case 'read_own_chat': return { label: t('Looking back through the chat'), state: 'searching' }
    case 'remember': return { label: t('Saving to memory'), state: 'working' }
    case 'forget': return { label: t('Updating memory'), state: 'working' }
    case 'recall': return { label: t('Checking memory'), state: 'searching' }
    default:
      if (GROUP_PHRASES[name]) return { label: t(GROUP_PHRASES[name]), state: 'sending' }
      const phrase = TOOL_PHRASES.find(([pattern]) => pattern.test(name))?.[1]
      return { label: phrase ? t(phrase) : null, state: toolState(name) }
  }
}

export function workPhrase(doing) {
  const { tool, said, note, target, switching, folder } = typeof doing === 'string' ? { tool: doing } : doing ?? {}
  if (switching) return folder === true ? t('Switching working folder') : t('Moving to a fresh conversation')
  const own = (said || note)?.replace(/[\s.。…]+$/u, '')
  if (own) return own
  if (!tool) return t('Thinking about it')
  const label = toolActivity(tool, () => undefined, () => undefined)?.label ?? t('On it')
  return target ? `${label} · ${target}` : label
}

function useLiveNote(actions, sessionId, id, entry) {
  const key = entry ? JSON.stringify(entry) : ''
  useEffect(() => {
    if (!key) return undefined
    actions.noteLive(sessionId, id, JSON.parse(key))
    return () => actions.noteLive(sessionId, id, null)
  }, [sessionId, id, key])
}

function helperFailureReason(reply) {
  let why
  switch (reply.stopReason) {
    case 'max-tokens': why = t('Reached the output limit'); break
    case 'aborted': why = t('Stopped before finishing'); break
    case 'refusal': why = t('Declined the task'); break
    case 'error': why = t('Run failed'); break
    default: why = reply.stopReason ? `${t('Run failed')} (${reply.stopReason})` : (reply.text || t('Run failed')); break
  }
  return reply.helper ? `${reply.helper} (${why})` : why
}

function RelayEvent({ reply, bot, sessionId, actions }) {
  if (reply.kind === 'failed') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: [reply.code, reply.status, reply.text].filter(Boolean).join(' · ') },
      t('{name} stopped: {reason}. Switch its model or ask it to go on.', { name: bot.name, reason: failureLabel(reply.code, reply.text) }))
  }
  if (reply.kind === 'helper-failed') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: reply.text || undefined },
      t("{name}'s background helper did not finish: {reason}. Ask it to go on if it still matters.", { name: bot.name, reason: helperFailureReason(reply) }))
  }
  if (reply.kind === 'lookup') {
    return h('div', { className: 'bt-event' },
      reply.text ? t('{name} looked up its own chat for “{text}”', { name: bot.name, text: reply.text }) : t('{name} looked up its own chat', { name: bot.name }))
  }
  if (reply.kind === 'missed') {
    return h('div', { className: 'bt-event' }, t("{name} didn't answer in time", { name: bot.name }))
  }
  if (reply.kind === 'admin-passed') {
    return h('div', { className: 'bt-event' },
      t('{name} did not answer or call anyone; call a member with @Name', { name: bot.name }))
  }
  if (reply.kind === 'paused') {
    return h('div', { className: 'bt-event' }, reply.idle
      ? t('{names} went back and forth {count} times without progress and paused. Write here to go on', { count: reply.count, names: [bot.name, ...(reply.names ?? [])].join(t(' and ')) })
      : t('Paused after {count} Bot relays. Waiting: {names}', { count: reply.count, names: (reply.names ?? []).join(t(' and ')) }))
  }
  if (reply.kind === 'resumed') {
    return h('div', { className: 'bt-event' }, t('{name} was cut off by a restart and picked its work back up', { name: bot.name }))
  }
  if (reply.kind === 'cut') {
    return h('div', { className: 'bt-event' }, t('{name} was cut off by a restart again and stopped', { name: bot.name }))
  }
  if (reply.kind === 'approval' || reply.kind === 'working') {
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', onClick: () => actions.showDetails(sessionId) },
        h(BotMark, { bot, size: 16 }), h('span', { className: 'bt-event-name' }, t(reply.kind === 'working' ? '{name} started on it' : '{name} paused for your approval', { name: bot.name }))))
  }
  if (reply.kind === 'folder') {
    return h('div', { className: 'bt-event' }, reply.text)
  }
  if (reply.kind === 'stopped') {
    return h('div', { className: 'bt-event' }, t("You stopped {name}'s work", { name: bot.name }))
  }
  if (reply.kind === 'done') {
    const line = h('div', { className: 'bt-event' }, t('{name} finished its work', { name: bot.name }))
    return reply.changes === undefined ? line : h(Fragment, null, line, h(ChangesCard, { changes: reply.changes, actions }))
  }
  return null
}

const settledRows = new Map()

function GroupReplies({ sessionId, callId, done, content, roster, actions, useUi, useWork }) {
  const [live, setLive] = useState({ replies: [], speaking: [] })
  useEffect(() => {
    if (done) return undefined
    let stop = false
    let timer
    let seen = ''
    const tick = async () => {
      const result = await actions.roomProgress(sessionId)
      if (stop) return
      const entry = (result ?? []).find(item => item.callId === callId) ?? (result ?? [])[0]
      const key = entry ? JSON.stringify([entry.replies, entry.speaking]) : ''
      if (entry && key !== seen) { seen = key; setLive({ replies: entry.replies ?? [], speaking: [entry.speaking ?? []].flat() }) }
      timer = setTimeout(tick, document.hidden ? 5000 : 1000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [done, sessionId, callId])
  const resultText = done ? contentText(content) : ''
  const range = done ? relayRange(resultText) : undefined
  const rowsKey = range === undefined ? undefined : `${sessionId}:${range.from}:${range.to ?? ''}:${range.anchor ?? ''}`
  const [view, setView] = useState(() => (rowsKey === undefined ? null : settledRows.get(rowsKey) ?? null))
  const quietKey = view?.open === true && view.active !== true ? roster.revision : undefined
  useEffect(() => {
    if (rowsKey === undefined) return undefined
    const known = settledRows.get(rowsKey)
    if (known !== undefined) { setView(known); return undefined }
    let stop = false
    let timer
    let seen = ''
    const tick = async () => {
      const next = await actions.groupRows(sessionId, range.from, range.to, range.anchor)
      if (stop) return
      if (next !== null && Array.isArray(next?.rows)) {
        if (!next.open) settledRows.set(rowsKey, next)
        const key = JSON.stringify(next)
        if (key !== seen) { seen = key; setView(next) }
        if (!next.open || next.active !== true) return
      }
      timer = setTimeout(tick, document.hidden ? 5000 : 1000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [rowsKey, quietKey])
  let replies = live.replies
  let broken = false
  if (range !== undefined) {
    replies = view?.rows ?? live.replies
  } else if (done) {
    const parsed = parseReplies(resultText)
    replies = parsed.replies.length ? parsed.replies : live.replies
    broken = parsed.broken
  }
  const pending = range !== undefined ? (view?.open ? view.speaking ?? [] : []) : done ? [] : live.speaking
  const doing = JSON.parse(useWork?.(work => JSON.stringify(pending.map((id) => {
    const tool = work.bots?.[id]?.tool
    return tool ? [tool, workPhrase(work.bots[id])] : []
  }))) ?? '[]')
  if (replies.length === 0 && pending.length === 0) {
    return broken ? h('div', { className: 'bt-group-replies' }, h('div', { className: 'bt-event' }, t('The group replies could not be shown'))) : h(CellEmpty)
  }
  const room = roster.roomsById[sessionId]
  return h('div', { className: 'bt-group-replies' },
    stackReplies(replies).map(({ reply, index, texts, time, duration, claims, changes }) => {
      const bot = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name, color: reply.color ?? 'gray' }
      if (reply.kind === 'user') {
        return h('div', { key: `user-${index}`, className: 'bt-urow' },
          h('div', { className: 'bt-ububble', 'data-text-interaction-source': '' }, h(MarkdownText, { text: reply.text, labels: mdLabels(), variant: 'compact' })),
          (reply.via !== undefined || Number.isFinite(time)) ? h('div', { className: 'bt-utime', title: clockLabel(time) }, ...(reply.via !== undefined ? [h(ViaTag, { key: 'via', via: reply.via })] : []), Number.isFinite(time) ? messageClock(time) : null) : null)
      }
      if (reply.kind !== undefined) {
        return h(RelayEvent, { key: `${reply.botId ?? reply.kind}-${index}`, reply, bot, sessionId, actions })
      }

      return h(GroupMessage, { key: `${reply.botId}-${index}`, bot, texts, room, sessionId, roster, actions, msgKey: callId ? `${sessionId}:${callId}:${index}` : undefined, useUi, time, duration, claims, changes })
    }),
    pending.map((id, at) => {
      const bot = roster.byId[id]
      if (!bot) return null
      const [tool, phrase] = doing[at] ?? []
      return h('div', { key: `pending-${id}`, className: 'bt-activity' },
        h(BotMark, { bot: bot, size: 22, state: tool ? toolState(tool) : 'thinking' }),
        h(Shimmer, null, phrase ? `${bot.name} · ${phrase}…` : t('{name} is typing…', { name: bot.name })))
    }))
}

const isComputerCall = name => name === 'cua' || name?.startsWith('cua_driver_native__') === true
const DRAWN = new Set(['message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret', 'request_connector', 'mail_send', 'ask_user_question', 'show_view', 'browser_handoff', 'read_group_chat', 'remember', 'forget'])
const CARDS = new Set(['ask_user', 'request_secret', 'request_connector', 'mail_send', 'show_view', 'browser_handoff', 'computer_handoff'])

export function callTree(root) {
  const calls = []
  const seen = new Set()
  const visit = (call) => {
    const id = call.callId ?? call
    if (seen.has(id)) return
    seen.add(id)
    calls.push(call)
    for (const child of call.subCalls ?? []) visit(child)
  }
  visit(root)
  return calls
}

function useShownCards(actions, sessionId, callIds) {
  const key = JSON.stringify(callIds)
  useLayoutEffect(() => {
    const ids = JSON.parse(key)
    if (ids.length === 0 || !actions.noteCards) return undefined
    actions.noteCards(sessionId, ids, 1)
    return () => actions.noteCards(sessionId, ids, -1)
  }, [sessionId, key])
}

function renderCall(call, { sessionId, roster, actions, useUi, useWork, findBot, heldCards, hooks }) {
  const tool = toolName(call)
  const done = call.kind === 'tool-result'
  const { text: arg, value: argValue } = toolArgs(call)
  const self = roster.byId[sessionId]
  switch (tool) {
    case 'message_bot': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't message {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Messaged'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'stop_bot': {
      const target = findBot(arg('bot')) ?? { name: arg('bot') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't stop {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Stopped'), bots: [target], onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'create_bot': {
      const created = findBot(arg('name'))
      if (!done || created === undefined) return h(CellEmpty)
      return h(EventLine, { prefix: t('Created'), bots: [created], onOpen: bot => actions.openSession(bot.id) })
    }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return done && target ? h(EventLine, { prefix: t('Updated'), bots: [target], onOpen: bot => actions.openSession(bot.id) }) : h(CellEmpty)
    }
    case 'group_relay':
      return h(GroupReplies, { sessionId, callId: call.callId, done, content: call.content, roster, actions, useUi, useWork })
    case 'create_group':
    case 'update_group':
    case 'delete_group':
    case 'post_to_group': {
      const verbs = {
        create_group: ['Created group', "Couldn't create the group"],
        update_group: ['Updated group', "Couldn't update the group"],
        delete_group: ['Deleted group', "Couldn't delete the group"],
        post_to_group: ['Posted in', "Couldn't post in the group"],
      }[tool]
      if (!done) return h(CellEmpty)
      const result = contentText(call.content)
      const named = /^(Created group|Updated|Nothing changed in|Deleted|Posted in) "([^"]+)"/.exec(result)
      if (call.isError || !named) return h('div', { className: 'bt-event', title: result }, t(verbs[1]))
      const name = named[2]
      const room = roster.rooms.find(entry => entry.name === name)
      return h(GroupEvent, { prefix: t(verbs[0]), room: tool === 'delete_group' ? undefined : room, name, roster, actions })
    }
    case 'ask_user':
      return h(AskUserCell, { sessionId, callId: call.callId, arg, argValue, roster, actions, heldCards })
    case 'show_view':
      return h(WidgetCell, { sessionId, callId: call.callId, args: { text: arg, value: argValue }, done, isError: call.isError, roster, actions, heldCards })
    case 'request_secret':
      return h(SecretToolCell, { sessionId, callId: call.callId, name: arg('name'), done, content: call.content, roster, actions, heldCards })
    case 'request_connector':
      return h(ConnectorToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'mail_send':
      return h(MailToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'browser_handoff':
      return h(HandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'computer_handoff':
      return h(ComputerHandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'ask_user_question': {
      if (!done) return h(CellEmpty)
      let parsed = null
      try { parsed = JSON.parse(contentText(call.content)) } catch { parsed = null }
      const answer = parsed?.answers?.[0]
      const question = argValue('questions')?.[0]
      if (!answer) return h(CellEmpty)
      return h('div', { className: 'bt-q-inline' }, h(SettledQuestion, { question, answer }))
    }
    case 'read_group_chat': {
      if (!done) return h(CellEmpty)
      const room = roster.rooms.find(entry => entry.name === arg('group'))
      return room ? h(GroupEvent, { prefix: t('Read'), room, roster, actions }) : h(CellEmpty)
    }
    case 'remember':
    case 'forget':
      return done ? h(MemoryEvent, { sessionId, scope: arg('scope'), tool, result: contentText(call.content), failed: call.isError === true, code: call.error?.code, roster, actions, findBot }) : h(CellEmpty)
    default:
      if (isComputerCall(tool)) {
        return h(Fragment, null,
          h(ComputerCallRow, { sessionId, call, roster, actions, hooks }),
          h(AppAccessCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks }))
      }
      return h(CellEmpty)
  }
}

export function ToolCell({ node, sessionId, useRoster, useUi, useWork, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, actions }) {
  const roster = useRoster(value => value)
  const heldCards = useHeldCards?.(state => state[sessionId])
  const root = node.data.root
  const turn = node.location?.turn?.turn ?? root.turn
  const hidden = isHiddenTurn(roster, sessionId, turn)
  const findBot = nameOrId => roster.byId[nameOrId] ?? roster.bots.find(bot => bot.name.toLowerCase() === String(nameOrId ?? '').toLowerCase())
  const closed = roster.closedCards?.[sessionId]
  const calls = hidden
    ? callTree(root).filter(call => (toolName(call) === 'ask_user' || toolName(call) === 'show_view') && call.callId && closed?.[call.callId] !== undefined)
    : callTree(root)
  const drawn = calls.filter(call => DRAWN.has(toolName(call)) || isComputerCall(toolName(call)))
  const running = root.kind === 'tool-result' ? undefined : calls.findLast(call => call.kind !== 'tool-result')
  const note = running ? toolActivity(toolName(running), toolArgs(running).text, findBot, roster.byId[sessionId]) : null
  useLiveNote(actions, sessionId, `tool:${root.callId ?? node.key}`, note)
  useShownCards(actions, sessionId, drawn.filter(call => (CARDS.has(toolName(call)) || isComputerCall(toolName(call))) && call.callId).map(call => call.callId))
  if (drawn.length === 0) return h(CellEmpty)
  const env = { sessionId, roster, actions, useUi, useWork, findBot, heldCards, hooks: { useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer } }
  return h(Fragment, null, drawn.map((call, index) => h(Fragment, { key: call.callId ?? index }, renderCall(call, env))))
}
