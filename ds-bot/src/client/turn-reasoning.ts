export function turnReasoning(steps, current) {
  const members = steps.length ? steps : [current]
  if (members.findLast(step => stepReasoning(step) !== '')?.step !== current.step) return ''
  return members.map(stepReasoning).filter(Boolean).join('\n\n')
}

export function opensReply(steps, current, withReasoning = true) {
  const members = steps.length ? steps : [current]
  const reasoner = withReasoning ? members.findLast(step => stepReasoning(step) !== '') : undefined
  return members.find(step => texts(step).length > 0 || step === reasoner)?.step === current.step
}

export const thinkingStep = steps => steps.find(thinkingLive)

const thinkingLive = step => step.status === 'running' && texts(step).length === 0 && step.blocks.some(block => block.kind === 'reasoning')

const texts = step => step.blocks.filter(block => block.kind === 'text' && block.text.trim() !== '')

// Reasoning can open with a `<signature>` block meant for the model, not the
// reader; DSH's chat hides it since 0.2.1-rc.5 and the Bot chat strips it the
// same way, keeping the raw record in the session.
const visibleReasoning = text => {
  if (text[0] !== '<') return text
  if ('<signature>'.startsWith(text)) return ''
  if (!text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}

const ACTIVITY = '▸ '
const isActivity = line => line.startsWith(ACTIVITY)
const reasoningText = step => step.blocks.filter(block => block.kind === 'reasoning').map(block => visibleReasoning(block.text)).join('\n')
const stepReasoning = step => reasoningText(step).split('\n').filter(line => !isActivity(line)).join('\n').trim()
export const stepActivity = step => reasoningText(step).split('\n').filter(isActivity).map(line => line.slice(ACTIVITY.length).trim()).filter(Boolean)
