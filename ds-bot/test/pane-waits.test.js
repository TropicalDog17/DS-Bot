import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARM_MS, WAITS_PER_BOT, WAIT_MAX_MS, createPaneWaits } from '../src/board/waits.js'

function fixture({ wake, wakeAvailable = true, status, cardId } = {}) {
  let data = { cards: { c_1: { id: 'c_1', status: 'active' } } }
  let clock = 0
  let readOnly = false
  const bots = new Set(['writer', 'coder'])
  const statuses = new Map()
  const statusCalls = []
  const reads = []
  const wakes = []
  const warnings = []
  let writeCount = 0
  const store = {
    read: () => data,
    readOnly: () => readOnly,
    async change(change) {
      writeCount++
      const draft = structuredClone(data)
      const result = change(draft)
      if (result.error === undefined) data = draft
      return result
    },
  }
  const { tool, poll, dispose } = createPaneWaits({
    store,
    now: () => clock,
    identity: { ownerOfSession: session => ({ botId: session, roomId: 'ops', ...(cardId === undefined ? {} : { cardId }) }) },
    roster: { ready: async () => {}, bot: id => bots.has(id) ? { id } : undefined },
    herdr: {
      async status(pane) {
        statusCalls.push(pane)
        return status ? status(pane) : statuses.get(pane) ?? { status: 'working' }
      },
      async read(pane) { reads.push(pane); return { text: 'Tests passed.' } },
    },
    notes: wakeAvailable ? { async wake(message) { wakes.push(message); await wake?.(message) } } : {},
    every: () => () => {},
    warn: (...warning) => warnings.push(warning),
  })
  const storedWaits = () => Object.values(store.read().waits ?? {})
  return {
    tool: (args, bot = 'writer') => tool.execute(args, { agent: { id: bot } }),
    poll, dispose, bots, statuses, statusCalls, reads, wakes, warnings, storedWaits,
    // Existing wait assertions compare the wait fields apart from warning bookkeeping.
    waits: () => storedWaits().map(({ warned: _warned, ...wait }) => wait),
    writes: () => writeCount,
    card: () => store.read().cards.c_1,
    setClock: value => { clock = value },
    setReadOnly: value => { readOnly = value },
  }
}

test('wait_pane adds, replaces and stops a wait and adds its pane to the card', async () => {
  const h = fixture({ cardId: 'c_1' })
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

test('two failed wakes warn once and the next poll still retries', async () => {
  let attempts = 0
  const h = fixture({ wake: () => {
    attempts++
    if (attempts <= 2) throw new Error('offline')
  } })
  await h.tool({ pane: 'w1:p1' })
  const [wait] = h.storedWaits()
  h.statuses.set(wait.pane, { status: 'done' })
  h.setClock(ARM_MS)
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.storedWaits(), [{ ...wait, warned: true }])
  const writes = h.writes()
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.storedWaits(), [{ ...wait, warned: true }])
  assert.equal(h.writes(), writes)
  assert.equal(attempts, 2)
  assert.deepEqual(h.warnings.map(warning => warning.at(-1)), ['offline'])
  assert.deepEqual(await h.poll(), [wait.id])
  assert.equal(attempts, 3)
  assert.deepEqual(h.storedWaits(), [])
})

test('an unavailable wake method warns once and leaves the wait pending', async () => {
  const h = fixture({ wakeAvailable: false })
  await h.tool({ pane: 'w1:p1' })
  h.statuses.set('w1:p1', { status: 'done' })
  h.setClock(ARM_MS)
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(await h.poll(), [])
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0].at(-1), /wake is not a function/)
  assert.equal(h.storedWaits().length, 1)
  assert.equal(h.storedWaits()[0].warned, true)
})

test('a previously warned wait still tries to wake on expiry and drops on failure', async () => {
  const h = fixture({ wake: () => { throw new Error('offline') } })
  await h.tool({ pane: 'w1:p1' })
  h.statuses.set('w1:p1', { status: 'done' })
  h.setClock(ARM_MS)
  assert.deepEqual(await h.poll(), [])
  assert.equal(h.storedWaits()[0].warned, true)
  h.setClock(WAIT_MAX_MS)
  assert.deepEqual(await h.poll(), [])
  assert.equal(h.wakes.length, 2)
  assert.match(h.wakes[1].text, /The wait ended\./)
  assert.equal(h.warnings.length, 1)
  assert.deepEqual(h.storedWaits(), [])
})

test('poll performs no wake, drop or write on a read-only store', async () => {
  const h = fixture()
  await h.tool({ pane: 'w1:p1' })
  await h.tool({ pane: 'w1:p2' }, 'coder')
  h.statuses.set('w1:p1', { status: 'done' })
  h.bots.delete('coder')
  h.setClock(ARM_MS)
  h.setReadOnly(true)
  const before = h.storedWaits()
  const writes = h.writes()
  assert.deepEqual(await h.poll(), [])
  assert.deepEqual(h.wakes, [])
  assert.deepEqual(h.storedWaits(), before)
  assert.equal(h.writes(), writes)
})

test('replacing the same pane keeps only the new wait for that pane', async () => {
  const h = fixture()
  await h.tool({ pane: 'w1:p1', until: ['done'] })
  await h.tool({ pane: 'w1:p2' })
  const [first, other] = h.storedWaits()
  await h.tool({ pane: first.pane, until: ['blocked'], note: 'Ask for approval' })
  const [unchanged, replacement] = h.storedWaits()
  assert.deepEqual(unchanged, other)
  assert.notEqual(replacement.id, first.id)
  assert.deepEqual(h.storedWaits().filter(wait => wait.pane === first.pane), [
    { ...first, id: replacement.id, until: ['blocked'], note: 'Ask for approval' },
  ])
})

test('a wake in flight can finish after dispose without writing the store', async () => {
  const started = Promise.withResolvers()
  const pending = Promise.withResolvers()
  const h = fixture({ wake: async () => {
    started.resolve()
    await pending.promise
  } })
  await h.tool({ pane: 'w1:p1' })
  h.statuses.set('w1:p1', { status: 'done' })
  h.setClock(ARM_MS)
  const before = h.storedWaits()
  const writes = h.writes()
  const pass = h.poll()
  await started.promise
  h.dispose()
  pending.resolve()
  await pass
  assert.deepEqual(await h.poll(), [])
  assert.equal(h.wakes.length, 1)
  assert.equal(h.writes(), writes)
  assert.deepEqual(h.storedWaits(), before)
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
