import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POLL_MAX_MS, needsIdleSample, pollDelay } from '../src/client/polling.ts'

test('the state poll stretches while nothing changes and snaps back when something does', () => {
  assert.equal(pollDelay(1500, 0), 1500)
  assert.equal(pollDelay(1500, 1), 3000)
  assert.equal(pollDelay(1500, 2), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 3), POLL_MAX_MS)
  assert.equal(pollDelay(1500, 99), POLL_MAX_MS)
  assert.equal(pollDelay(10_000, 0), 10_000)
  assert.equal(pollDelay(10_000, 5), 10_000)
  assert.equal(pollDelay(1500, -3), 1500)
})

test('the OS idle time is read while a Bot has foreground control or waits for idle', () => {
  assert.equal(needsIdleSample(undefined, undefined), false)
  assert.equal(needsIdleSample({}, {}), false)
  assert.equal(needsIdleSample({ bots: {} }, { bots: { a: { level: 'background' }, b: { level: 'view' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { appName: 'Finder' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { waitingFor: 'window' } } }), false)
  assert.equal(needsIdleSample({ bots: { a: { waitingFor: 'user-idle' } } }), true)
  assert.equal(needsIdleSample({ bots: { a: {}, b: { waitingFor: 'user-idle' } } }), true)
  assert.equal(needsIdleSample({ bots: {} }, { bots: { a: { level: 'background' }, b: { level: 'foreground' } } }), true)
})
