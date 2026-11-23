// Waits on herdr panes that outlive a restart. A Bot hands work to an agent in a pane,
// names the states it waits for and ends its turn. The wait is kept in board.json, not
// in a job of DSH (which a restart or a new part of the chat stops), and the board polls
// the pane and wakes the Bot where it asked once the pane gets there.

export const WAIT_STATES = ['idle', 'done', 'blocked']
export const WAIT_POLL_MS = 15_000
// A pane still idle right after the prompt has not started: it counts only once it was
// seen in another state, or after this long.
export const ARM_MS = 120_000
export const WAIT_MAX_MS = 24 * 60 * 60_000
export const WAITS_PER_BOT = 10
export const WAIT_NOTE_MAX = 500
export const SHOWN_LINES = 40

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
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
    'Check the result in the pane, then go on with the work.',
  ].join('\n')
}

export const waitingText = wait => `Waiting for herdr pane ${wait.pane} to be ${states(wait.until)}. When it gets there you are woken here with what it shows, also after a restart. End your turn now; do not wait for it with herdr agent wait, --wait or a background job.`
