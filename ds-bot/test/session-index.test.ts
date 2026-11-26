import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionIndex, ensureSessionIndex } from '../src/host/session-index.ts'
import { activateSegmentPart, type BotThreadState } from '../src/host/threads.ts'

test('reindex indexes bot main chats, open parts, closed cards, groups, and past segments', () => {
  const index = createSessionIndex()
  index.reindex({
    bots: {
      a: {
        id: 'a',
        sessionId: 'a-cur',
        segments: [{ sessionId: 'a-old' }],
        openParts: [{ sessionId: 'a-card', segments: [{ sessionId: 'a-card-old' }] }],
        closedCards: [{ sessionId: 'a-closed', segments: [{ sessionId: 'a-closed-1' }] }],
      },
    },
    rooms: {
      r1: {
        id: 'r1',
        sessionId: 'r1-cur',
        parts: [{ sessionId: 'r1-old' }],
        sessions: { a: 'ga-cur' },
        segments: { a: [{ sessionId: 'ga-old' }] },
      },
    },
  })

  assert.equal(index.selfOf('a-cur'), 'a')
  assert.equal(index.selfOf('a-card'), 'a')
  assert.equal(index.selfOf('a-old'), 'a')
  assert.equal(index.selfOf('a-card-old'), 'a')
  assert.equal(index.selfOf('a-closed'), 'a')
  assert.equal(index.selfOf('a-closed-1'), 'a')
  assert.equal(index.selfOf('ga-cur'), 'a')
  assert.equal(index.selfOf('ga-old'), 'a')
  assert.equal(index.selfOf('r1-cur'), undefined)

  assert.equal(index.isBotSession('a-cur'), true)
  assert.equal(index.isBotSession('a-card'), true)
  assert.equal(index.isBotSession('ga-cur'), true)
  assert.equal(index.isBotSession('a-old'), false)
  assert.equal(index.isBotSession('r1-cur'), false)

  assert.equal(index.roomOwnerOf('r1-cur'), 'r1')
  assert.deepEqual(index.placeOf('a-cur'), { botId: 'a' })
  assert.deepEqual(index.placeOf('ga-cur'), { botId: 'a', roomId: 'r1' })
  assert.deepEqual(index.placeOf('r1-cur'), { roomId: 'r1' })
  assert.equal(index.placeOf('a-old'), undefined)
  assert.deepEqual(index.pastOwners.get('r1-old'), { roomId: 'r1' })
  assert.deepEqual(index.currentSessionIds().sort(), ['a-card', 'a-cur', 'ga-cur', 'r1-cur'])
})

test('semantic transitions keep chat, group, and past indexes consistent and notify listeners', () => {
  const index = createSessionIndex()
  let notifications = 0
  const stop = index.onChange(() => { notifications += 1 })

  index.registerChat('s1', 'a')
  assert.equal(index.chatOwners.get('s1'), 'a')

  index.archiveChat('s1', 'a')
  assert.equal(index.chatOwners.has('s1'), false)
  assert.deepEqual(index.pastOwners.get('s1'), { botId: 'a' })

  index.registerChat('s2', 'a')
  index.swapChatPart('s2', 's1', 'a')
  assert.equal(index.chatOwners.get('s1'), 'a')
  assert.equal(index.chatOwners.has('s2'), false)
  assert.deepEqual(index.pastOwners.get('s2'), { botId: 'a' })
  assert.equal(index.pastOwners.has('s1'), false)

  index.registerGroupMember('g1', 'a', 'r1')
  assert.deepEqual(index.placeOf('g1'), { botId: 'a', roomId: 'r1' })
  index.removeGroupMember('g1')
  assert.equal(index.groupOwners.has('g1'), false)
  assert.equal(notifications, 1)

  index.removeChat('s1')
  assert.equal(index.chatOwners.has('s1'), false)

  stop()
  index.notifyChanged()
  assert.equal(notifications, 1)
})

test('ensureSessionIndex wraps existing maps without replacing references', () => {
  const chatOwners = new Map<string, string>([['a', 'a']])
  const pastOwners = new Map<string, { botId?: string; roomId?: string }>()
  const rt: { chatOwners: typeof chatOwners; pastOwners: typeof pastOwners } = { chatOwners, pastOwners }
  const index = ensureSessionIndex(rt)

  index.archiveChat('a', 'a')
  assert.equal(chatOwners.has('a'), false)
  assert.deepEqual(pastOwners.get('a'), { botId: 'a' })
})

test('activateSegmentPart swaps a segment into current session and records previous endedAt', () => {
  const bot: BotThreadState = {
    id: 'a',
    sessionId: 'a-2',
    segments: [{ sessionId: 'a-1', endedAt: 100 }],
  }
  assert.equal(activateSegmentPart(bot, 'missing', 500), undefined)
  const prev = activateSegmentPart(bot, 'a-1', 500)
  assert.equal(prev, 'a-2')
  assert.equal(bot.sessionId, 'a-1')
  assert.deepEqual(bot.segments, [{ sessionId: 'a-2', endedAt: 500 }])
})
