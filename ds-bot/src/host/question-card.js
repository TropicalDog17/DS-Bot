// An ask_user card: one question, or up to four that the user answers with one Submit.
import { randomUUID } from 'node:crypto'

export const MAX_QUESTIONS = 4
export const HEADER_MAX = 16
const MAX_OPTIONS = 6

function optionsFrom(given) {
  return (Array.isArray(given) ? given : [])
    .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
    .map(option => ({
      label: String(option.label ?? '').trim(),
      ...(option.description ? { description: String(option.description).trim() } : {}),
    }))
    .filter(option => option.label !== '')
    .slice(0, MAX_OPTIONS)
}

function questionFrom(item) {
  const header = String(item?.header ?? '').trim()
  return {
    ...(header !== '' ? { header } : {}),
    question: String(item?.question ?? '').trim(),
    ...(item?.detail ? { detail: String(item.detail).trim() } : {}),
    options: optionsFrom(item?.options),
    multiSelect: item?.multiSelect === true,
  }
}

/**
 * The card an ask_user call asks for, or `{ error }` with the line that tells the Bot
 * what to change. A card with one question keeps the fields it always had; one with
 * several also lists them under `questions`, each with its own id, and repeats the
 * first one at the top for a reader that knows one question only.
 */
export function cardFromArgs(args) {
  const several = Array.isArray(args?.questions) && args.questions.length > 0
  const asked = (several ? args.questions : [args]).map(questionFrom)
  if (asked.length > MAX_QUESTIONS) return { error: `A card holds at most ${MAX_QUESTIONS} questions. Ask the first ${MAX_QUESTIONS} now and the rest after the answer.` }
  for (const [at, question] of asked.entries()) {
    const which = several ? `Question ${at + 1}: ` : ''
    if (several && question.question === '') return { error: `${which}write the question.` }
    if (question.options.length === 0) return { error: several ? `${which}give at least one option.` : 'Give at least one option.' }
    if ((question.header ?? '').length > HEADER_MAX) return { error: `${which}the header "${question.header}" is longer than ${HEADER_MAX} characters. Use a short tag such as "PR #1207".` }
  }
  const [first] = asked
  return {
    card: {
      id: randomUUID(),
      ...first,
      ...(args?.allowCustom === true ? { allowCustom: true } : {}),
      ...(asked.length > 1 ? { questions: asked.map(question => ({ id: randomUUID(), ...question })) } : {}),
    },
  }
}

/** The questions on a stored card, each with the id its answer names. */
export function questionsOf(card) {
  if (Array.isArray(card?.questions) && card.questions.length > 0) return card.questions
  if (card === undefined || card === null) return []
  return [{
    id: card.id,
    ...(card.header ? { header: card.header } : {}),
    question: card.question,
    ...(card.detail ? { detail: card.detail } : {}),
    options: card.options ?? [],
    multiSelect: card.multiSelect === true,
  }]
}

/** A question as a reply or a history line names it: its tag, then its text. */
export const questionTitle = question => [question?.header, question?.question].filter(part => typeof part === 'string' && part.trim() !== '').join(': ')
