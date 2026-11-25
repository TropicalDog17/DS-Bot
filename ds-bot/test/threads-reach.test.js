import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addCardThread, closeCardThread, reach, sessionsOf } from '../src/host/threads.js'

test('reach prefers the card thread, then the group, then the Bot’s own chat', () => {
  const bot = { id: 'writer', sessionId: 'own' }
  const room = { id: 'ops', members: ['writer'], sessions: { writer: 'group' } }
  const target = { cardId: 'card', roomId: room.id, room }
  addCardThread(bot, 'thread', 'card')
  assert.deepEqual(reach(bot, target), { sessionId: 'thread', where: 'card' })
  closeCardThread(bot, 'card')
  assert.deepEqual(reach(bot, target), { sessionId: 'group', where: 'group' })
  room.members = []
  assert.deepEqual(reach(bot, target), { sessionId: 'own', where: 'own' })
  assert.deepEqual(reach({ id: 'new' }), { sessionId: 'new', where: 'own' })
  assert.equal(reach(undefined, target).sessionId, undefined)
})

test('sessionsOf lists the Bot’s current, earlier, open and card sessions once each', () => {
  const bot = {
    id: 'writer',
    sessionId: 'own',
    segments: [{ sessionId: 'earlier' }],
    openParts: [{ sessionId: 'open', segments: [{ sessionId: 'earlier' }, { sessionId: 'open-earlier' }] }],
  }
  addCardThread(bot, 'thread', 'card')
  assert.deepEqual(sessionsOf(bot), ['own', 'earlier', 'open', 'open-earlier', 'thread'])
  assert.deepEqual(sessionsOf(undefined), [])
})
