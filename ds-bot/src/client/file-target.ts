export function presentedFileTarget(actionUrl) {
  if (typeof actionUrl !== 'string' || !actionUrl.includes('?')) return null
  const params = new URLSearchParams(actionUrl.slice(actionUrl.indexOf('?') + 1))
  const sessionId = params.get('sessionId')
  const seqText = params.get('seq')
  const indexText = params.get('index')
  const seq = seqText === null ? NaN : Number(seqText)
  const index = indexText === null ? NaN : Number(indexText)
  if (typeof sessionId !== 'string' || sessionId === '' || !Number.isInteger(seq) || !Number.isInteger(index)) return null
  return { sessionId, seq, index }
}
