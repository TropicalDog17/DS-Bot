import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardActions, boardColumns, boardErrorText, boardLinks, boardQuestion, readBoard, writeBoard, type BoardCard, type BoardState } from './board.ts'

function card(id: string, status: BoardCard['status'], time: number, fields: Partial<BoardCard> = {}): BoardCard {
  return { id, title: id, status, assignee: 'writer', progress: '', createdAt: time, updatedAt: time, notes: [], ...fields }
}

const pr = 'https://github.com/example/project/pull/42'
const review = card('review', 'review', 4, {
  brief: 'Make the release ready to publish.',
  progress: 'PR open',
  links: [{ url: pr, at: 5 }],
  notes: [
    { by: 'writer', at: 5, text: 'Which version?', options: ['Patch', 'Minor'] },
    { by: 'writer', at: 6, text: 'Both are ready.' },
  ],
})
const state: BoardState = {
  cards: {
    later: card('later', 'todo', 6),
    finished: card('finished', 'done', 1, { doneAt: 8 }),
    active: card('active', 'active', 3),
    review,
    earlier: card('earlier', 'todo', 2),
    cancelled: card('cancelled', 'cancelled', 7),
    blocked: card('blocked', 'blocked', 5),
    doneEarlier: card('doneEarlier', 'done', 0, { doneAt: 3, updatedAt: 10 }),
  },
  bots: [{ id: 'writer', name: 'Writer' }],
  readOnly: false,
  trace: 'off',
  live: {},
  revision: 'board-revision',
}

test('board state maps open columns, keeps Done separate, and reads the card details', async () => {
  const answer = await readBoard(async (endpoint, payload) => {
    assert.equal(endpoint, 'board')
    assert.deepEqual(payload, { endpoint: 'state', payload: {} })
    return state
  })
  const { columns, done } = boardColumns(answer)
  assert.deepEqual(columns.map(column => [column.status, column.cards.map(item => item.id)]), [
    ['todo', ['earlier', 'later']], ['active', ['active']], ['review', ['review']], ['blocked', ['blocked']],
  ])
  assert.deepEqual(done.map(item => item.id), ['finished', 'doneEarlier'])
  assert.equal(columns[2].cards[0].brief, review.brief)
  assert.deepEqual(boardLinks(review), [{ label: 'example/project#42', url: pr }])

  const notes = review.notes ?? []
  assert.deepEqual(boardQuestion(notes), { index: 0, options: ['Patch', 'Minor'], answer: undefined })
  assert.deepEqual(boardQuestion([...notes, { by: 'user', at: 7, text: 'Minor' }]), { index: 0, options: ['Patch', 'Minor'], answer: 'Minor' })
})

test('board actions send note, move, cancel and seen payloads and answer a question with note', async () => {
  const requests: unknown[] = []
  const call = async (endpoint: string, payload: unknown) => {
    requests.push({ endpoint, payload })
    return state
  }
  for (const action of [
    boardActions.note('review', 'Please check again.\nThanks!'),
    boardActions.move('review', 'done'),
    boardActions.cancel('review', 'Superseded'),
    boardActions.cancel('review'),
    boardActions.seen('review'),
    boardActions.answer('review', 'Minor'),
  ]) {
    assert.equal(await writeBoard(call, state, action), state)
  }
  assert.deepEqual(requests, [
    { endpoint: 'board', payload: { endpoint: 'note', payload: { id: 'review', text: 'Please check again.\nThanks!' } } },
    { endpoint: 'board', payload: { endpoint: 'move', payload: { id: 'review', status: 'done' } } },
    { endpoint: 'board', payload: { endpoint: 'cancel', payload: { id: 'review', reason: 'Superseded' } } },
    { endpoint: 'board', payload: { endpoint: 'cancel', payload: { id: 'review' } } },
    { endpoint: 'board', payload: { endpoint: 'seen', payload: { id: 'review' } } },
    { endpoint: 'board', payload: { endpoint: 'note', payload: { id: 'review', text: 'Minor' } } },
  ])
})

test('board guarded skips writes in read-only mode and explains server errors', async () => {
  const readOnly = { ...state, readOnly: true }
  let requests = 0
  const call = async () => { requests += 1; return readOnly }
  assert.equal((await readBoard(call)).readOnly, true)
  for (const action of [boardActions.note('review', 'Note'), boardActions.answer('review', 'Minor'),
    boardActions.move('review', 'done'), boardActions.cancel('review'), boardActions.seen('review')]) {
    await assert.rejects(writeBoard(call, readOnly, action), /board is read-only/)
  }
  assert.equal(requests, 1)
  const fail = (code: string, message: string) => async () => { throw Object.assign(new Error(message), { code }) }
  await assert.rejects(readBoard(fail('board/off', 'The board plugin is off')), error => {
    assert.equal(boardErrorText(error), 'The board plugin is turned off on this computer.')
    return true
  })
  await assert.rejects(writeBoard(fail('board/refused', 'That card is already finished.'), state, boardActions.cancel('review')), error => {
    assert.equal(boardErrorText(error), 'That card is already finished.')
    return true
  })
})
