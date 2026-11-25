// Waits on herdr panes that outlive a restart. A Bot hands work to an agent in a pane,
// names the states it waits for and ends its turn. The wait is kept in board.json, not
// in a job of DSH (which a restart or a new part of the chat stops), and the board polls
// the pane and wakes the Bot where it asked once the pane gets there.

import { randomUUID } from 'node:crypto'
import { defineTool } from '../host/tool-schema.js'
import { createBoard, paneTarget } from './cards.js'
import { oneLine } from './card-fields.js'
import { every as schedule } from './poller.js'

export const WAIT_STATES = ['idle', 'done', 'blocked']
const WAIT_POLL_MS = 15_000
// A pane still idle right after the prompt has not started: it counts only once it was
// seen in another state, or after this long.
export const ARM_MS = 120_000
export const WAIT_MAX_MS = 24 * 60 * 60_000
export const WAITS_PER_BOT = 10
export const WAIT_NOTE_MAX = 500
export const SHOWN_LINES = 40

const states = until => (until.length === 1 ? until[0] : `${until.slice(0, -1).join(', ')} or ${until.at(-1)}`)

// { waits, pane, until?, botId, roomId?, cardId?, note?, id, at } -> { wait, replaced } | { error }.
// A Bot has one wait per pane: a new one for the same pane takes its place.
export function addWait(waits, { pane, until, botId, roomId, cardId, note, id, at }) {
  const wanted = Array.isArray(until) && until.length > 0 ? [...new Set(until)] : WAIT_STATES
  const unknown = wanted.find(state => !WAIT_STATES.includes(state))
  if (unknown !== undefined) return { error: `until is one or more of ${WAIT_STATES.join(', ')}.` }
  const earlier = Object.values(waits).find(wait => wait.botId === botId && wait.pane === pane)
  if (earlier === undefined && Object.values(waits).filter(wait => wait.botId === botId).length >= WAITS_PER_BOT) {
    return { error: `You already wait on ${WAITS_PER_BOT} panes. Stop one first (wait_pane with stop).` }
  }
  if (earlier !== undefined) delete waits[earlier.id]
  const text = oneLine(note, WAIT_NOTE_MAX)
  const wait = {
    id, pane, until: wanted, botId, since: at,
    ...(roomId === undefined ? {} : { roomId }),
    ...(cardId === undefined ? {} : { cardId }),
    ...(text === '' ? {} : { note: text }),
  }
  waits[id] = wait
  return { wait, replaced: earlier !== undefined }
}

// What a poll of the pane means for the wait: { kind: 'match' | 'gone' | 'expired' } wakes
// the Bot, { armed: true } notes that the pane was seen working, undefined waits on.
// `seen` is herdr.status(): { status } | { error, gone? }.
export function check(wait, seen, at) {
  if (seen?.gone === true) return { kind: 'gone' }
  if (at - wait.since >= WAIT_MAX_MS) return { kind: 'expired', ...(seen?.status ? { status: seen.status } : {}) }
  const status = seen?.status
  if (typeof status !== 'string') return undefined
  if (!wait.until.includes(status)) return wait.armed === true ? undefined : { armed: true }
  if (wait.armed === true || at - wait.since >= ARM_MS) return { kind: 'match', status }
  return undefined
}

// The message that wakes the Bot: what happened, the pane's last lines, its own note.
export function wakeText(wait, outcome, shown) {
  const head = outcome.kind === 'match'
    ? `herdr pane ${wait.pane} is ${outcome.status}.`
    : outcome.kind === 'gone'
      ? `herdr pane ${wait.pane} is gone (closed, or its agent left).`
      : `herdr pane ${wait.pane} did not get to ${states(wait.until)} within ${WAIT_MAX_MS / 3_600_000} hours${outcome.status ? `; it is ${outcome.status}` : ''}. The wait ended.`
  const lines = typeof shown === 'string' && shown.trim() !== '' ? shown.replace(/\s+$/, '').split('\n').slice(-SHOWN_LINES).join('\n') : ''
  return [
    head,
    ...(wait.cardId === undefined ? [] : [`It is the work of card ${wait.cardId}.`]),
    ...(wait.note === undefined ? [] : [`Your note when you started waiting: ${wait.note}`]),
    ...(lines === '' ? [] : ['What it shows last:', '```', lines.replaceAll('```', '`​``'), '```']),
    wait.cardId === undefined ? 'Check the result in the pane, then go on with the work.' : 'Check the result in the pane, board update the card\'s progress in one line, then go on with the work.',
  ].join('\n')
}

export const waitingText = wait => `Waiting for herdr pane ${wait.pane} to be ${states(wait.until)}. When it gets there you are woken here with what it shows, also after a restart. End your turn now; do not wait for it with herdr agent wait, --wait or a background job.`

export function createPaneWaits({ store, herdr, notes, now = Date.now, identity, roster, every = schedule, warn = console.warn }) {
  const board = createBoard({ roster, now })
  const tool = defineTool({
    name: 'wait_pane',
    description: 'Wait for the agent in a herdr pane to finish, stop or need input, without holding your turn. Call it once you handed the work to the pane, then end your turn: when the pane gets to one of the states you name, you are woken in this conversation with what it shows. The wait is kept by DS Bot, so a restart or a new part of your chat does not lose it. stop: true ends your wait on that pane.',
    parameters: {
      pane: { type: 'string', required: true, description: 'The herdr pane id, like w1:p1T' },
      until: { type: 'array', items: { type: 'string', enum: WAIT_STATES }, description: `States to wake on; default ${WAIT_STATES.join(', ')}. done: it finished a task; idle: it waits for a prompt; blocked: it needs input or approval` },
      note: { type: 'string', description: 'What to do once it is over, in one line; it comes back with the wake' },
      stop: { type: 'boolean', description: 'true ends your wait on this pane' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      await roster.ready()
      const sessionId = exec?.agent?.id
      const owner = identity.ownerOfSession(sessionId)
      if (owner === undefined || roster.bot(owner.botId) === undefined) return 'Only Bots on the team can use wait_pane.'
      const pane = paneTarget(args.pane)
      if (pane === undefined) return 'pane is a herdr pane id, like w1:p1T.'
      if (store.readOnly()) return 'The board is read-only in this dsh, so a wait cannot be kept here.'
      if (args.stop === true) {
        const stopped = await store.change((data) => {
          const wait = Object.values(data.waits ?? {}).find(entry => entry.botId === owner.botId && entry.pane === pane)
          if (wait === undefined) return { error: `You do not wait on ${pane}.` }
          dropWait(data, wait.id)
          return {}
        })
        return stopped.error ?? `Stopped waiting on ${pane}.`
      }
      const seen = await herdr.status(pane)
      if (seen.gone === true) return `herdr has no pane ${pane}.`
      if (seen.error !== undefined && seen.status === undefined && /not installed/.test(seen.error)) return seen.error
      const { cardId } = owner
      const result = await store.change((data) => {
        const added = addWait(data.waits ??= {}, { pane, until: args.until, botId: owner.botId, roomId: owner.roomId, cardId, note: args.note, id: `w_${randomUUID().slice(0, 8)}`, at: now() })
        if (added.error === undefined && cardId !== undefined) board.panes(data.cards, cardId, [pane])
        return added
      })
      if (result.error !== undefined) return result.error
      return [waitingText(result.wait), result.replaced ? 'It takes the place of your earlier wait on this pane.' : '', seen.status ? `It is ${seen.status} now.` : ''].filter(Boolean).join(' ')
    },
  })
  const dropWait = (data, id) => {
    delete data.waits?.[id]
    if (data.waits !== undefined && Object.keys(data.waits).length === 0) delete data.waits
  }
  // Each wait's pane, once per poll: a wait that is over wakes its Bot, and is dropped
  // only after the wake went out (a wake twice beats a wake lost to a crash).
  let polling = false
  let disposed = false
  const changeWait = (id, change) => store.change(data => {
    const wait = data.waits?.[id]
    if (disposed || wait === undefined) return { error: 'The wait is no longer being polled.' }
    change(wait, data)
    return {}
  })
  const removeWait = id => changeWait(id, (_wait, data) => dropWait(data, id))
  async function poll() {
    if (disposed || polling || store.readOnly()) return []
    polling = true
    const woken = []
    try {
      await roster.ready()
      for (const wait of Object.values(store.read().waits ?? {})) {
        if (disposed) break
        const outcome = roster.bot(wait.botId) === undefined ? { kind: 'gone-bot' } : check(wait, await herdr.status(wait.pane), now())
        if (disposed) break
        if (outcome === undefined) continue
        if (outcome.armed === true) {
          await changeWait(wait.id, entry => { entry.armed = true })
          continue
        }
        if (outcome.kind !== 'gone-bot') {
          const shown = outcome.kind === 'gone' ? undefined : await herdr.read(wait.pane)
          if (disposed) break
          if (store.read().waits?.[wait.id] === undefined) continue
          const sent = await Promise.resolve().then(() => notes.wake({ botId: wait.botId, pane: wait.pane, ...(wait.cardId ? { cardId: wait.cardId } : {}), ...(wait.roomId ? { roomId: wait.roomId } : {}), text: wakeText(wait, outcome, shown?.text) }))
            .catch(error => ({ error: error?.message ?? String(error) }))
          if (disposed) break
          if (sent?.error !== undefined) {
            const warned = wait.warned === true
            const expired = outcome.kind === 'expired'
            if (warned && !expired) continue
            const saved = expired
              ? await removeWait(wait.id)
              : await changeWait(wait.id, entry => { entry.warned = true })
            if (!warned && saved.error === undefined) warn('ds-bot-board: waking %s for %s failed: %s', wait.botId, wait.pane, sent.error)
            continue
          }
          woken.push(wait.id)
        }
        await removeWait(wait.id)
      }
    } finally {
      polling = false
    }
    return woken
  }
  const stop = every(WAIT_POLL_MS, poll, {
    readOnly: () => store.readOnly(),
    onError: error => warn('ds-bot-board: polling herdr waits failed: %s', error),
  })
  const dispose = () => { disposed = true; stop() }
  return Object.freeze({ tool, poll, dispose })
}
