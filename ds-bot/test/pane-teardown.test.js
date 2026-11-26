import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createdPane } from '../src/board/herdr.ts'
import { openBoardStore } from '../src/board/store.ts'
import { createPaneTeardown } from '../src/board/teardown.ts'
import { createPaneWaits } from '../src/board/waits.ts'

const pane = 'w2:p3'
const terminal = 'term-w2:p3'
const owner = 'writer'
const roster = { ready: async () => {}, bot: id => ({ id }) }
const every = () => () => {}

function board(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-teardown-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = openBoardStore(join(dir, 'board.json'))
  t.after(store.dispose)
  return store
}

test('creation output accepts a successful bash exit trailer and rejects unrelated or compound commands', () => {
  const output = JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: pane, terminal_id: terminal } } })
  const create = 'herdr tab create --label "Build tests"'
  assert.deepEqual(createdPane(create, `${output}\n[Command finished with exit code 0]`), { pane, terminal })
  assert.equal(createdPane(create, `${output}\n[Command finished with exit code 1]`), undefined)
  assert.equal(createdPane('herdr workspace create', output), undefined)
  assert.equal(createdPane('printf "herdr tab create"', output), undefined)
  assert.equal(createdPane(`${create} > /dev/null; cat saved.json`, output), undefined)
})

test('the evidence is durable before close and is recovered if herdr later reports the pane gone', async (t) => {
  const store = board(t)
  await store.change(data => {
    data.owned = { [pane]: { pane, terminal, botId: owner, sessionId: 'chat', at: 100, released: true } }
  })
  const evidence = { text: 'Tests passed.', status: 'idle', agent: 'codex', session: 'worker' }
  let closeAttempts = 0
  const warnings = []
  const herdr = {
    status: async () => ({ status: 'idle' }),
    processes: async () => ({ foreground: [{ name: 'zsh', argv: ['-zsh'] }] }),
    read: async () => ({ text: evidence.text }),
    info: async () => ({ status: evidence.status, agent: evidence.agent, session: evidence.session, terminal, focused: false }),
    close: async () => {
      closeAttempts++
      const saved = JSON.parse(readFileSync(store.file, 'utf8')).owned[pane]
      assert.deepEqual(saved.evidence, evidence)
      assert.equal(saved.closed, undefined)
      return { error: 'close timed out' }
    },
  }
  const teardown = createPaneTeardown({ store, roster, herdr, every, now: () => 200, warn: (...args) => warnings.push(args) })
  t.after(teardown.dispose)
  assert.deepEqual(await teardown.poll(), [])
  assert.equal(store.read().owned[pane].closed, undefined)
  assert.equal(warnings[0].at(-1), 'close timed out')
  assert.deepEqual(await teardown.poll(), [])
  assert.equal(warnings.length, 1)
  herdr.processes = async () => ({ error: 'pane not found', gone: true })
  assert.deepEqual(await teardown.poll(), [pane])
  assert.deepEqual(store.read().owned[pane].closed, { ...evidence, at: 200 })
  assert.equal(closeAttempts, 2)
})

test('the final focus check runs after evidence is saved', async (t) => {
  const store = board(t)
  await store.change(data => {
    data.owned = { [pane]: { pane, terminal, botId: owner, sessionId: 'chat', at: 100, released: true } }
  })
  let attempts = 0
  const teardown = createPaneTeardown({
    store, roster, every,
    herdr: {
      processes: async () => ({ foreground: [{ name: 'codex-bin', argv: ['/opt/bin/codex'] }] }),
      info: async () => ({ status: 'done', agent: 'codex', terminal, focused: store.read().owned[pane].evidence !== undefined }),
      read: async () => ({ text: 'All checks passed.' }),
      close: async () => { attempts++; return { ok: true } },
    },
  })
  t.after(teardown.dispose)
  assert.deepEqual(await teardown.poll(), [])
  assert.equal(store.read().owned[pane].evidence.text, 'All checks passed.')
  assert.equal(attempts, 0)
})

test('closing keeps the 200 newest closed entries and every open entry', async (t) => {
  const store = board(t)
  await store.change(data => {
    data.owned = Object.fromEntries(Array.from({ length: 201 }, (_, index) => {
      const pane = `w3:p${index}`
      return [pane, { pane, botId: owner, at: index, closed: { text: '', at: index } }]
    }))
    data.owned[pane] = { pane, terminal, botId: owner, sessionId: 'chat', at: 100, released: true }
    data.owned['w2:p4'] = { pane: 'w2:p4', botId: owner, sessionId: 'chat', at: 100 }
  })
  const teardown = createPaneTeardown({
    store, roster, every, now: () => 500,
    herdr: { processes: async () => ({ gone: true }) },
  })
  t.after(teardown.dispose)
  assert.deepEqual(await teardown.poll(), [pane])
  const { owned } = store.read()
  assert.equal(Object.values(owned).filter(entry => entry.closed).length, 200)
  assert.equal(owned['w3:p0'], undefined)
  assert.equal(owned['w3:p1'], undefined)
  assert.ok(owned['w3:p2'].closed)
  assert.ok(owned[pane].closed)
  assert.ok(owned['w2:p4'])
})

test('releasing a pane removes only the owner’s wait', async (t) => {
  const store = board(t)
  await store.change(data => {
    data.owned = { [pane]: { pane, botId: owner, sessionId: 'chat', at: 100 } }
  })
  const waits = createPaneWaits({
    store, roster, every, herdr: { status: async () => ({ status: 'working' }) },
    identity: { ownerOfSession: botId => ({ botId }) },
  })
  t.after(waits.dispose)
  await waits.tool.execute({ pane }, { agent: { id: owner } })
  await waits.tool.execute({ pane }, { agent: { id: 'coder' } })
  assert.match(await waits.tool.execute({ pane, release: true }, { agent: { id: owner } }), /Released/)
  assert.equal(store.read().owned[pane].released, true)
  assert.deepEqual(Object.values(store.read().waits).map(wait => wait.botId), ['coder'])
})
