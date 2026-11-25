import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARM_MS, WAITS_PER_BOT, WAIT_MAX_MS, createPaneWaits } from '../src/board/waits.js'

function fixture({ wake, status, cardOfSession = () => undefined } = {}) {
  let data = { cards: { c_1: { id: 'c_1', status: 'active' } } }
  let clock = 0
  let readOnly = false
  const bots = new Set(['writer', 'coder'])
  const statuses = new Map()
  const statusCalls = []
  const reads = []
  const wakes = []
  const warnings = []
  const store = {
    read: () => data,
    readOnly: () => readOnly,
    async change(change) {
      const draft = structuredClone(data)
      const result = change(draft)
      if (result.error === undefined) data = draft
      return result
    },
  }
  const { tool, poll } = createPaneWaits({
    store,
    now: () => clock,
    identity: { ownerOfSession: session => ({ botId: session, roomId: 'ops' }) },
    roster: { ready: async () => {}, bot: id => bots.has(id) ? { id } : undefined },
    herdr: {
      async status(pane) {
        statusCalls.push(pane)
        return status ? status(pane) : statuses.get(pane) ?? { status: 'working' }
      },
      async read(pane) { reads.push(pane); return { text: 'Tests passed.' } },
    },
    notes: { async wake(message) { wakes.push(message); await wake?.(message) } },
    cardOfSession,
    every: () => () => {},
    warn: (...warning) => warnings.push(warning),
  })
  return {
    tool: (args, bot = 'writer') => tool.execute(args, { agent: { id: bot } }),
    poll, bots, statuses, statusCalls, reads, wakes, warnings,
    waits: () => Object.values(store.read().waits ?? {}),
    card: () => store.read().cards.c_1,
    setClock: value => { clock = value },
    setReadOnly: value => { readOnly = value },
  }
}

test('wait_pane adds, replaces and stops a wait and adds its pane to the card', async () => {
  const h = fixture({ cardOfSession: () => ({ id: 'c_1' }) })
  assert.match(await h.tool({ pane: 'w1:p1', until: ['done'], note: ' Check CI ' }), /^Waiting for herdr pane w1:p1 to be done\./)
  const [first] = h.waits()
  assert.deepEqual(first, { id: first.id, botId: 'writer', roomId: 'ops', cardId: 'c_1', pane: 'w1:p1', since: 0, until: ['done'], note: 'Check CI' })
  assert.deepEqual(h.card().panes, [{ id: 'w1:p1', at: 0 }])
  assert.match(await h.tool({ pane: 'w1:p1', until: ['blocked'] }), /takes the place of your earlier wait/)
  const [replacement] = h.waits()
  assert.notEqual(replacement.id, first.id)
  assert.deepEqual(h.waits().map(wait => [wait.pane, wait.until]), [['w1:p1', ['blocked']]])
  assert.equal(await h.tool({ pane: 'w1:p1', stop: true }), 'Stopped waiting on w1:p1.')
  assert.deepEqual(h.waits(), [])
  assert.equal(await h.tool({ pane: 'w1:p1', stop: true }), 'You do not wait on w1:p1.')
  h.statuses.set('w1:p1', { gone: true })
  assert.equal(await h.tool({ pane: 'w1:p1' }), 'herdr has no pane w1:p1.')
})

test('the cap is per Bot and allows replacing a wait at the cap', async () => {
  const h = fixture()
  for (let i = 0; i < WAITS_PER_BOT; i++) assert.match(await h.tool({ pane: `w1:p${i}` }), /^Waiting/)
  assert.match(await h.tool({ pane: 'w1:p99' }), /already wait on 10 panes/)
  assert.match(await h.tool({ pane: 'w1:p1', until: ['done'] }), /takes the place/)
  assert.match(await h.tool({ pane: 'w1:p99' }, 'coder'), /^Waiting/)
  assert.equal(h.waits().filter(wait => wait.botId === 'writer').length, WAITS_PER_BOT)
  assert.equal(h.waits().filter(wait => wait.botId === 'coder').length, 1)
})

test('poll stores armed and handles a match, a gone pane, expiry and a gone Bot', async () => {
  const h = fixture()
  const [match, gone, expired, orphan] = ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4']
  h.statuses.set(match, { status: 'idle' })
  for (const pane of [match, gone, expired]) await h.tool({ pane })
  await h.tool({ pane: orphan }, 'coder')
  const [first, second, third] = h.waits()
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.waits().map(wait => wait.armed), [undefined, true, true, true])
  h.statuses.set(match, { status: 'working' })
  assert.deepEqual(await h.poll(), [])
  assert.equal(h.waits()[0].armed, true)
  h.statuses.set(match, { status: 'done' })
  h.statuses.set(gone, { gone: true })
  h.bots.delete('coder')
  h.statusCalls.length = 0
  assert.deepEqual(await h.poll(), [first.id, second.id])
  assert.deepEqual(h.statusCalls, [match, gone, expired])
  assert.deepEqual(h.waits().map(wait => wait.id), [third.id])
  h.setClock(WAIT_MAX_MS)
  assert.deepEqual(await h.poll(), [third.id])
  assert.deepEqual(h.waits(), [])
  assert.deepEqual(h.reads, [match, expired])
  assert.deepEqual(h.wakes.map(wake => [wake.botId, wake.roomId, wake.pane]), [
    ['writer', 'ops', match], ['writer', 'ops', gone], ['writer', 'ops', expired],
  ])
  assert.match(h.wakes[0].text, /^herdr pane w1:p1 is done\.[\s\S]*Tests passed\./)
  assert.match(h.wakes[1].text, /^herdr pane w1:p2 is gone/)
  assert.match(h.wakes[2].text, /within 24 hours; it is working\. The wait ended\./)
})

test('tool and poll skip a read-only board', async () => {
  const h = fixture()
  await h.tool({ pane: 'w1:p1' })
  const before = h.waits()
  h.statusCalls.length = 0
  h.setReadOnly(true)
  assert.match(await h.tool({ pane: 'w1:p2' }), /board is read-only/)
  assert.match(await h.tool({ pane: 'w1:p1', stop: true }), /board is read-only/)
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.statusCalls, [])
  assert.deepEqual(h.wakes, [])
  assert.deepEqual(h.waits(), before)
})

test('wake before drop: a failed wake keeps the wait and the next pass retries', async () => {
  let reject = true
  const h = fixture({ wake: () => {
    assert.equal(h.waits().length, 1)
    if (reject) throw new Error('temporarily offline')
  } })
  await h.tool({ pane: 'w1:p1' })
  const [wait] = h.waits()
  h.setClock(ARM_MS)
  h.statuses.set(wait.pane, { status: 'done' })
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.waits(), [wait])
  assert.equal(h.warnings[0].at(-1), 'temporarily offline')
  reject = false
  assert.deepEqual(await h.poll(), [wait.id])
  assert.deepEqual(h.waits(), [])
  assert.deepEqual(h.wakes, [h.wakes[0], h.wakes[0]])
})

test('an expired wait drops even when its wake fails', async () => {
  const h = fixture({ wake: () => { throw new Error('offline') } })
  await h.tool({ pane: 'w1:p1' })
  h.setClock(WAIT_MAX_MS)
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.waits(), [])
  assert.equal(h.wakes.length, 1)
})

test('a direct poll cannot overlap another pass', async () => {
  const pending = Promise.withResolvers()
  const h = fixture({ status: () => pending.promise })
  pending.resolve({ status: 'working' })
  await h.tool({ pane: 'w1:p1' })
  h.statusCalls.length = 0
  const first = h.poll()
  assert.deepEqual(await h.poll(), [])
  await first
  assert.deepEqual(h.statusCalls, ['w1:p1'])
})
