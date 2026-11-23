import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { chief: 'room-chief', writer: 'room-writer' }, admin: 'chief', mode: 'admin' } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

// One Agent per Session, as dsh keeps them; restrict() calls are recorded with their
// lifts, so a test can read what each Session has masked right now.
async function setup({ served = ['read', 'bash', 'write', 'edit', 'web_search'], state = team() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-main-router-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const agents = new Map()
  const masks = []
  const registered = new Map()
  let sessions = 0
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const names = new Set()
    registered.set(id, names)
    const agent = {
      id,
      session: { id },
      ctx: {
        tools: {
          register: (def) => {
            names.add(def.name)
            return () => names.delete(def.name)
          },
          restrict: (filter) => {
            const mask = { id, deny: [...filter.deny], lifted: false }
            masks.push(mask)
            return () => { mask.lifted = true }
          },
        },
        on: () => () => {},
        effect: execute => execute(),
      },
      followup: () => {},
    }
    agents.set(id, agent)
    await created(agent)
    return agent
  }
  ctx.tools.schemas = () => served.map(name => ({ name }))
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `new${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentFor(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  const guard = (name, sessionId) => ctx.guards.map(check => check({ name, agent: { id: sessionId } })).find(reason => reason !== undefined)
  const masked = id => masks.filter(mask => mask.id === id && !mask.lifted).flatMap(mask => mask.deny)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, agentFor, masked, registered, guard, stop }
}

test('the Main Bot loses the tools that do work in its chat and its group Sessions; other Bots keep them', async (t) => {
  const { agentFor, masked, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'room-chief', 'writer', 'room-writer']) await agentFor(id)
  for (const id of ['chief', 'room-chief']) assert.deepEqual(masked(id).sort(), ['bash', 'edit', 'write'])
  for (const id of ['writer', 'room-writer']) assert.deepEqual(masked(id), [])
})

test('the guard refuses work tools to the Main Bot only, and reading stays', async (t) => {
  const { guard, stop } = await setup()
  t.after(stop)
  assert.match(guard('bash', 'chief'), /The Main Bot does not do the work itself/)
  assert.match(guard('apply_patch', 'room-chief'), /Open a card on the board/)
  assert.match(guard('browser_click', 'chief'), /does not do the work itself/)
  assert.equal(guard('read', 'chief'), undefined)
  assert.equal(guard('web_search', 'chief'), undefined)
  assert.equal(guard('bash', 'writer'), undefined)
})

test('handing the Main Bot role over lifts the mask on the old one and puts it on the new one', async (t) => {
  const { rt, agentFor, masked, guard, registered, stop } = await setup()
  t.after(stop)
  await agentFor('chief')
  await agentFor('writer')
  assert.equal(registered.get('chief').has('message_bot'), true)
  await rt.setMain('writer', true)
  assert.deepEqual(masked('chief'), [])
  assert.deepEqual(masked('writer').sort(), ['bash', 'edit', 'write'])
  assert.equal(guard('bash', 'chief'), undefined)
  assert.match(guard('bash', 'writer'), /does not do the work itself/)
  // The team tools stay with both.
  assert.equal(registered.get('writer').has('message_bot'), true)
  assert.equal(registered.get('chief').has('message_bot'), true)
})

test('a team saved with several Main Bots keeps only the first', async (t) => {
  const state = team()
  state.mainBotIds = ['writer', 'chief']
  const { rt, stop } = await setup({ state })
  t.after(stop)
  assert.deepEqual(rt.state.mainBotIds, ['writer'])
})

const digest = (ctx, sessionId) => ctx.contexts.get('ds-bot-routing-digest').text({ agent: { id: sessionId } })

test('the routing digest reaches only the Main Bot, lists the others with their role and whether they work', async (t) => {
  const state = team()
  state.bots.writer.instructions = 'Writes the newsletter and blog posts.\nSecond line stays out.'
  const { ctx, rt, stop } = await setup({ state })
  t.after(stop)
  const text = digest(ctx, 'chief')
  assert.match(text, /^\[Team right now · for routing\]/)
  assert.match(text, /- Writer \(Write\) — Writes the newsletter and blog posts\. · idle/)
  assert.doesNotMatch(text, /Second line|Chief/)
  assert.equal(digest(ctx, 'room-chief'), text)
  assert.equal(digest(ctx, 'writer'), '')
  assert.equal(digest(ctx, 'room-writer'), '')
  assert.equal(digest(ctx, 'nobody'), '')
  rt.live.set('room-writer', { turn: {} })
  assert.match(digest(ctx, 'chief'), /Writer .* · working/)
})

test('a companion adds its part to the digest, and a part that throws is left out', async (t) => {
  const { ctx, rt, stop } = await setup()
  t.after(stop)
  const remove = rt.routingParts(self => `Open cards for ${self}`)
  rt.routingParts(() => { throw new Error('broken') })
  assert.match(digest(ctx, 'chief'), /\nOpen cards for chief$/)
  remove()
  assert.doesNotMatch(digest(ctx, 'chief'), /Open cards/)
})

test('only the Main Bot gets the routing rules', async (t) => {
  const { ctx, stop } = await setup()
  t.after(stop)
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  assert.match(prompt('chief'), /## You are the Main Bot\n- Every request from the user reaches you first/)
  assert.match(prompt('chief'), /You do no work yourself/)
  assert.doesNotMatch(prompt('chief'), /group_goal|more than one Main Bot/)
  assert.doesNotMatch(prompt('writer'), /You are the Main Bot/)
  assert.match(prompt('writer'), /ask the Main Bot/)
})
