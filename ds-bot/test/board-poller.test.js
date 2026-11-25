import assert from 'node:assert/strict'
import { test } from 'node:test'
import { every } from '../src/board/poller.js'

test('every skips overlapping passes and resumes when the slow job finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const pending = Promise.withResolvers()
  let calls = 0
  const dispose = every(10, () => { calls++; return pending.promise })
  t.after(dispose)
  t.mock.timers.tick(10)
  assert.equal(calls, 1)
  t.mock.timers.tick(10)
  assert.equal(calls, 1)
  pending.resolve()
  await pending.promise
  t.mock.timers.tick(10)
  assert.equal(calls, 2)
})

test('every skips read-only passes, reports failure and stops after disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const errors = []
  const failure = new Error('failed pass')
  let readOnly = true
  let calls = 0
  const dispose = every(10, () => {
    calls++
    if (calls === 1) throw failure
  }, { readOnly: () => readOnly, onError: error => errors.push(error) })
  t.after(dispose)
  t.mock.timers.tick(10)
  assert.equal(calls, 0)
  readOnly = false
  t.mock.timers.tick(10)
  assert.deepEqual(errors, [failure])
  t.mock.timers.tick(10)
  assert.equal(calls, 2)
  await Promise.resolve()
  dispose()
  t.mock.timers.tick(10)
  assert.equal(calls, 2)
})
