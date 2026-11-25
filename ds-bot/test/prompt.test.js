import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.ts'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('private and group Bot prompts share the same prefix; group relay and non-Bot sessions stay separate', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.equal(prompt('group-worker'), prompt('worker'))
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})
