export function seqNum(value) {
  const seq = value !== null && typeof value === 'object' ? value.seq : value
  if (typeof seq === 'bigint') return Number(seq)
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined
}

function turnClosed(turn) {
  return seqNum(turn?.end) !== undefined
}

function anchorOf(card) {
  if (card == null || card.anchorSeq == null) return undefined
  return seqNum(card.anchorSeq)
}

function turnContaining(seq, turns) {
  let closed
  let closedStart = -Infinity
  let open
  let openStart = -Infinity
  for (const turn of turns.values()) {
    const start = seqNum(turn?.start)
    if (start === undefined || seq < start) continue
    const end = seqNum(turn?.end)
    if (end !== undefined) {
      if (seq > end || start < closedStart) continue
      closed = turn
      closedStart = start
      continue
    }
    if (start < openStart) continue
    open = turn
    openStart = start
  }
  return closed ?? open
}

function turnStartedBy(seq, turns) {
  let best
  let bestStart = -Infinity
  for (const turn of turns.values()) {
    const start = seqNum(turn?.start)
    if (start === undefined || start > seq || start < bestStart) continue
    best = turn
    bestStart = start
  }
  return best
}

export function owningTurn(card, turns) {
  if (!turns || typeof turns.values !== 'function') return undefined
  const anchor = anchorOf(card)
  if (anchor !== undefined) return turnContaining(anchor, turns)
  const at = seqNum(card?.atSeq)
  if (at === undefined) return undefined
  return turnStartedBy(at, turns)
}

function sameTurn(owner, turn) {
  if (!owner || !turn) return false
  if (typeof owner.turn === 'number' && typeof turn.turn === 'number') return owner.turn === turn.turn
  return owner === turn
}

export function dockCards(cards, facts) {
  const turns = facts?.turns
  return (Array.isArray(cards) ? cards : []).filter(card => {
    const owner = owningTurn(card, turns)
    return owner === undefined || !turnClosed(owner)
  })
}

export function tailCards(cards, turn, turns) {
  if (!turn || !turnClosed(turn) || !turns) return []
  return (Array.isArray(cards) ? cards : []).filter(card => sameTurn(owningTurn(card, turns), turn))
}

export function sessionCards(roster, sessionId) {
  if (!roster?.ready || roster.roomsById?.[sessionId]) return []
  const bot = roster.byId?.[sessionId]
  if (!bot) return []
  const cards = roster.btwCards?.[bot.id]
  return (Array.isArray(cards) ? cards : []).filter(card => card?.partId === sessionId)
}

function partChain(bot) {
  return [...(bot?.parts ?? []), bot?.sessionId].filter(id => typeof id === 'string' && id !== '')
}

export function partIndexOf(bot, sessionId, cursor) {
  if (Number.isInteger(cursor?.part)) return cursor.part
  return partChain(bot).indexOf(sessionId) - 1
}

function rowTurn(item) {
  return typeof item?.turn === 'number' && Number.isInteger(item.turn) ? item.turn : undefined
}

function rowSeq(item) {
  return seqNum(item?.seq ?? item?.atSeq)
}

function segmentsOf(items) {
  const segments = []
  let current = null
  const close = () => {
    if (current) segments.push(current)
    current = null
  }
  for (const item of items) {
    if (item?.kind === 'divider') {
      close()
      segments.push({ kind: 'divider', items: [item] })
      continue
    }
    const turn = rowTurn(item)
    if (!current || current.turn !== turn) {
      close()
      current = { kind: 'rows', items: [], turn, startSeq: undefined }
    }
    current.items.push(item)
    const seq = rowSeq(item)
    if (seq !== undefined && (current.startSeq === undefined || seq < current.startSeq)) current.startSeq = seq
  }
  close()
  return segments
}

function segmentAt(seq, content) {
  let best
  let bestSeq = Infinity
  for (const segment of content) {
    for (const item of segment.items) {
      const row = rowSeq(item)
      if (row === undefined || row < seq || row >= bestSeq) continue
      best = segment
      bestSeq = row
    }
  }
  return best
}

function segmentStartedBy(seq, content) {
  let best
  let bestStart = -Infinity
  for (const segment of content) {
    const start = segment.startSeq
    if (start === undefined || start > seq || start < bestStart) continue
    best = segment
    bestStart = start
  }
  return best
}

function cardTurn(card) {
  if (card == null || typeof card !== 'object') return undefined
  const value = 'turn' in card ? card.turn : card.atTurn
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function segmentByTurn(turn, content) {
  let match
  for (const segment of content) if (segment.turn === turn) match = segment
  return match
}

function ownerSegment(card, content) {
  const turn = cardTurn(card)
  if (turn !== undefined) return segmentByTurn(turn, content)
  const anchor = anchorOf(card)
  if (anchor !== undefined) return segmentAt(anchor, content)
  const at = seqNum(card?.atSeq)
  if (at === undefined) return undefined
  return segmentStartedBy(at, content)
}

const btwRow = card => ({ kind: 'btw', card })

export function withBtwRows(items, cards) {
  const list = Array.isArray(items) ? items : []
  const pending = (Array.isArray(cards) ? cards : []).filter(card => card && card.id !== undefined && card.id !== null)
  if (pending.length === 0) return list
  const segments = segmentsOf(list)
  const content = segments.filter(segment => segment.kind === 'rows')
  let floor
  for (const segment of content) {
    if (segment.startSeq === undefined) continue
    if (floor === undefined || segment.startSeq < floor) floor = segment.startSeq
  }
  const buckets = new Map()
  const aside = []
  for (const card of pending) {
    const owner = ownerSegment(card, content)
    if (owner) {
      const bucket = buckets.get(owner) ?? []
      bucket.push(card)
      buckets.set(owner, bucket)
      continue
    }
    if (cardTurn(card) !== undefined) {
      aside.push(card)
      continue
    }
    const at = seqNum(card?.atSeq)
    if (floor !== undefined && at !== undefined && at < floor) continue
    aside.push(card)
  }
  if (content.length === 0) return [...list, ...aside.map(btwRow)]
  const out = []
  for (const segment of segments) {
    out.push(...segment.items)
    const bucket = buckets.get(segment)
    if (bucket) for (const card of bucket) out.push(btwRow(card))
  }
  for (const card of aside) out.push(btwRow(card))
  return out
}
