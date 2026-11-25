const roomOf = (rt, sessionId) => rt.roomOf(sessionId)?.id ?? sessionId
export const withRows = (rt, sessionId, result) => (Number.isInteger(result?.from)
  ? { ...result, replies: rt.groupRows(roomOf(rt, sessionId), result.from, result.to) }
  : result)
const busy = (rt, roomId) => [...rt.roomProgress.values()].some(round => round.roomId === roomId)
export async function afterRound(rt, sessionId, value) {
  const result = JSON.parse(value)
  const roomId = roomOf(rt, sessionId)
  while (busy(rt, roomId) || rt.roomRounds(roomId).length > 0) {
    await Promise.all(rt.roomRounds(roomId))
    await new Promise(resolve => setImmediate(resolve))
  }
  const round = rt.ledger.records(`group-${roomId}`).filter(record => record.event === 'round' && record.to >= result.from - 1).at(-1)
  return { ...withRows(rt, sessionId, result), ...(round === undefined ? {} : { passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) }) }
}
