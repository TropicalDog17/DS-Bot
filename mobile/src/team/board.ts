import { t } from '../ui/i18n.ts'

export const openColumns = ['todo', 'active', 'review', 'blocked'] as const
type OpenColumn = typeof openColumns[number]
type BoardColumn = OpenColumn | 'done'

export interface BoardNote {
  at: number
  by?: string
  text: string
  options?: string[]
}

export interface BoardCard {
  id: string
  title: string
  key?: string
  url?: string
  assignee: string
  status: BoardColumn | 'cancelled'
  createdAt: number
  updatedAt: number
  doneAt?: number
  progress: string
  brief?: string
  need?: string
  result?: string
  reason?: string
  unread?: boolean
  notes?: BoardNote[]
  links?: { url: string; at: number }[]
}

export interface BoardState {
  cards: Record<string, BoardCard>
  bots: { id: string; name: string }[]
  readOnly: boolean
  trace: string
  live: Record<string, unknown>
  revision: string
  liveKey?: string
}

export function boardColumns({ cards }: BoardState) {
  const ordered = Object.values(cards).sort((a, b) => a.createdAt - b.createdAt)
  const columns = openColumns.map(status => ({ status, cards: ordered.filter(card => card.status === status) }))
  const done = ordered.filter(card => card.status === 'done')
    .sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt))
  return { columns, done }
}

export function boardQuestion(notes: BoardNote[]) {
  const index = notes.findLastIndex(note => Array.isArray(note.options) && note.options.length > 0)
  if (index < 0) return undefined
  const question = notes[index]
  const answer = notes.slice(index + 1).find(note => note.by === 'user' || note.by === undefined)
  return { index, options: question.options ?? [], answer: answer?.text }
}

export function boardLinks(card: BoardCard) {
  const urls = new Set([card.url, ...(card.links ?? []).map(link => link.url)])
  return [...urls].flatMap(url => {
    if (url === undefined || !/^https?:\/\//i.test(url)) return []
    const pr = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url)
    const label = pr !== null ? `${pr[1]}#${pr[2]}` : (url === card.url ? card.key : undefined) ?? url
    return [{ url, label }]
  })
}

const note = (id: string, text: string) => ({ endpoint: 'note', payload: { id, text } } as const)

export const boardActions = {
  seen: (id: string) => ({ endpoint: 'seen', payload: { id } } as const),
  note,
  answer: note,
  move: (id: string, status: BoardColumn) => ({ endpoint: 'move', payload: { id, status } } as const),
  cancel: (id: string, reason?: string) => ({ endpoint: 'cancel', payload: { id, ...(reason === undefined ? {} : { reason }) } } as const),
}

export type BoardWrite = ReturnType<typeof boardActions[keyof typeof boardActions]>
type BoardCall = (endpoint: 'board', payload: { endpoint: 'state'; payload: Record<string, never> } | BoardWrite) => Promise<unknown>

function snapshot(value: unknown): BoardState {
  const state = value as Partial<BoardState> | null | undefined
  if (state?.cards === undefined || state.cards === null || typeof state.cards !== 'object' || Array.isArray(state.cards)
    || !Array.isArray(state.bots) || typeof state.readOnly !== 'boolean' || typeof state.revision !== 'string') {
    throw new Error(t('The computer sent an invalid board response.'))
  }
  return state as BoardState
}

export async function readBoard(call: BoardCall) {
  return snapshot(await call('board', { endpoint: 'state', payload: {} }))
}

export const boardReadOnlyText = () => t('This board is read-only.')

export async function writeBoard(call: BoardCall, state: Pick<BoardState, 'readOnly'>, action: BoardWrite) {
  if (state.readOnly) throw new Error(boardReadOnlyText())
  return snapshot(await call('board', action))
}

export function boardErrorText(error: unknown): string {
  const failure = error as { code?: string; message?: string } | null | undefined
  switch (failure?.code) {
    case 'board/off': return t('The board plugin is turned off on this computer.')
    case 'board/refused': return failure.message || t('The computer refused this board action.')
    case 'bot/not-found': return t('This computer does not support Board yet.')
    default: return failure?.message || t('Could not load or update the board.')
  }
}
