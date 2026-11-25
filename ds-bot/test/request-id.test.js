import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function boot(home, seed) {
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose() }
  await tool('list_bots', {}, 'a')
  return { ctx, rt, agents, agentOf, tool, stop }
}

const freshSends = agent => agent.calls.filter(([, message]) => !message?.content?.[0]?.text?.includes('restarted before it could reach you'))
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-request-'))
const cleanup = home => rmSync(home, { recursive: true, force: true, maxRetries: 5 })

test('a repeat after a restart gives the saved receipt back and sends nothing', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  const out = await again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(out, receipt)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a request that was in the air when DS Bot stopped is not sent again', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  first.ctx.sessions.flush = async () => new Promise(() => {})
  const inFlight = first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  inFlight.catch(() => {})
  for (let count = 0; count < 200 && Object.keys(first.rt.state.requests ?? {}).length === 0; count += 1) await delay(10)
  assert.equal(Object.values(first.rt.state.requests)[0].outcome, 'pending')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  await assert.rejects(again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

for (const reason of ['stopped', 'lock lost']) {
  test(`a named request is not delivered when its state save is skipped: ${reason}`, async (t) => {
    const home = tempHome()
    const host = await boot(home, team())
    t.after(async () => { await host.stop(); cleanup(home) })
    const args = { to: 'Writer', message: 'do the thing', request_id: 'r-1' }
    let attempt
    let closing
    if (reason === 'stopped') {
      attempt = host.tool('message_bot', args, 'a')
      closing = host.stop()
    } else {
      writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: `${hostname()}-other`, token: 'other-writer', since: Date.now() }))
      attempt = host.tool('message_bot', args, 'a')
    }
    await assert.rejects(attempt, /cannot save|cannot be saved/i)
    await closing
    assert.equal(host.agentOf('b').calls.length, 0)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).requests ?? {}).length, 0)
  })
}
