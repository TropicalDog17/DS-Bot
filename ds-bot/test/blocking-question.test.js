import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const QUESTION = 'ask_user_question'
const AGENT_TEAMS = ['spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
const DELEGATION = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', ...AGENT_TEAMS]
const DELEGATION_REFUSAL = 'Bots do not start subagents, teammates or workflows. Do the work yourself, or hand it to another Bot with message_bot.'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { writer: 'room-writer' }, admin: 'chief', mode: 'everyone' } },
  agents: { dsh: { id: 'dsh', name: 'DSH Agent', sessions: ['plain'], createdAt: 3 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

async function setup({ served = ['read', 'ask_user', QUESTION], goals, throwOn } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-blocking-question-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext({ services: goals === undefined ? {} : { goals } })
  const agents = new Map()
  const hidden = []
  const sent = []
  const scopedListeners = []
  let sessions = 0
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id },
      ctx: {
        tools: {
          register: () => () => {},
          restrict: (filter) => {
            if (throwOn !== undefined && filter.deny.includes(throwOn)) throw new Error(`"${throwOn}" is registered in this scope`)
            hidden.push([id, [...filter.deny]])
            return () => {}
          },
        },
        on: (event, listener) => {
          const record = { sessionId: id, event, listener, disposed: false }
          scopedListeners.push(record)
          return () => { record.disposed = true }
        },
        effect: execute => execute(),
      },
      followup: message => sent.push({ sessionId: id, message }),
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
  const guard = (name, sessionId) => ctx.guards.map(check => check({ name, agent: sessionId === undefined ? undefined : { id: sessionId } })).find(reason => reason !== undefined)
  const hiddenIn = id => hidden.filter(([sessionId, deny]) => sessionId === id && deny.includes(QUESTION))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, agentFor, hidden, hiddenIn, guard, sent, scopedListeners, stop }
}

function goalService() {
  const current = new Map()
  const blocked = []
  return {
    current,
    blocked,
    get: agent => current.get(agent.id),
    block(agent, ref, reason) {
      const goal = current.get(agent.id)
      assert.deepEqual(ref, { id: goal.id, revision: goal.revision })
      blocked.push({ sessionId: agent.id, ...reason })
      current.set(agent.id, { ...goal, revision: goal.revision + 1, phase: 'blocked' })
    },
  }
}

const startGoal = (ctx, goals, sessionId) => {
  const goal = { id: `goal-${sessionId}`, revision: 1, objective: 'Ship it', phase: 'active', maxGoalRounds: 256 }
  goals?.current.set(sessionId, goal)
  const event = { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 } }
  for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
}

const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('a Bot\'s own chat and its group Session lose dsh\'s blocking question tool; other Sessions keep it', async (t) => {
  const { agentFor, hidden, hiddenIn, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) await agentFor(id)
  assert.equal(hiddenIn('chief').length, 1)
  assert.equal(hiddenIn('writer').length, 1)
  assert.equal(hiddenIn('room-writer').length, 1)
  assert.deepEqual(hiddenIn('plain'), [])
  assert.deepEqual(hiddenIn('elsewhere'), [])
  for (const [sessionId, deny] of hidden.filter(([id]) => id !== 'plain')) assert.deepEqual([sessionId, deny], [sessionId, [QUESTION]])
})

test('ds-bot resolving a Bot\'s Agent again does not hide the tool twice', async (t) => {
  const { rt, hiddenIn, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('writer')
  await rt.resolveAgent('writer')
  await rt.dispatch.sendBotRequest({ fromId: 'chief', toId: 'writer', rawMessage: 'hi', text: 'hi', when: 'queue', formatReceipt: () => 'ok' })
  assert.equal(hiddenIn('writer').length, 1)
})

test('a profile without the tool gets no mask, which restrict() would refuse', async (t) => {
  const { agentFor, hidden, guard, stop } = await setup({ served: ['read', 'ask_user'] })
  t.after(stop)
  await agentFor('writer')
  assert.deepEqual(hidden, [])
  assert.match(guard(QUESTION, 'writer'), /Bots cannot use ask_user_question/)
})

test('the guard refuses the blocking question tool in Bot Sessions only', async (t) => {
  const { guard, stop } = await setup()
  t.after(stop)
  for (const sessionId of ['chief', 'writer', 'room-writer']) assert.match(guard(QUESTION, sessionId), /Ask with ask_user in your own chat, or ask in your reply\./)
  for (const sessionId of ['plain', 'elsewhere', undefined]) assert.equal(guard(QUESTION, sessionId), undefined)
  assert.equal(guard('ask_user', 'writer'), undefined)
  assert.equal(guard('read', 'writer'), undefined)
})

test('a new Bot that rules out question tools opens without one and cannot block on dsh\'s', async (t) => {
  const { rt, hiddenIn, guard, sent, stop } = await setup()
  t.after(stop)
  const receiver = await rt.createBot({ name: 'Receiver', instructions: 'Never use ask_user or any question tool.', createdBy: 'chief' })
  await until(() => sent.some(entry => entry.sessionId === receiver.id))
  const kickoff = sent.find(entry => entry.sessionId === receiver.id).message.content[0].text
  assert.doesNotMatch(kickoff, /ask_user|allowCustom/)
  assert.match(kickoff, /Where your instructions say otherwise, follow them\./)
  assert.equal(hiddenIn(receiver.id).length, 1)
  assert.match(guard(QUESTION, receiver.id), /Bots cannot use ask_user_question/)
})

test('a Bot\'s chat and its group Sessions lose the goal tools; other Sessions keep them', async (t) => {
  const { agentFor, hidden, stop } = await setup({ served: ['read', 'ask_user', QUESTION, 'create_goal', 'update_goal', 'get_goal'] })
  t.after(stop)
  for (const id of ['chief', 'room-writer', 'plain']) await agentFor(id)
  assert.deepEqual(hidden.filter(([, deny]) => deny.includes('create_goal')), [
    ['chief', [QUESTION, 'create_goal', 'update_goal', 'get_goal']],
    ['room-writer', [QUESTION, 'create_goal', 'update_goal', 'get_goal']],
  ])
})

test('a goal started in a Bot chat or a group is blocked; one elsewhere runs', async (t) => {
  const goals = goalService()
  const { ctx, agentFor, stop } = await setup({ goals })
  t.after(stop)
  const ids = ['writer', 'room', 'room-writer', 'plain']
  for (const id of ids) await agentFor(id)
  for (const id of ids) startGoal(ctx, goals, id)
  assert.deepEqual(goals.blocked, [])
  await until(() => goals.blocked.length === 3)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(goals.blocked.map(entry => entry.sessionId), ['writer', 'room', 'room-writer'])
  for (const entry of goals.blocked) assert.deepEqual([entry.code, entry.message], ['not-supported', 'Bot chats do not run /goal. Track the work as a card on the board.'])
  assert.equal(goals.current.get('plain').phase, 'active')
})

test('without DSH\'s goal service a goal change is left alone', async (t) => {
  const { ctx, rt, agentFor, stop } = await setup()
  t.after(stop)
  const warnings = []
  rt.warn = (...args) => warnings.push(args)
  await agentFor('writer')
  startGoal(ctx, undefined, 'writer')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(warnings, [])
})

test('a Bot\'s chat and its group Sessions lose the delegation tools; other Sessions keep them', async (t) => {
  const servedDelegation = ['subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow']
  const { agentFor, hidden, stop } = await setup({ served: ['read', 'ask_user', QUESTION, ...servedDelegation] })
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) await agentFor(id)
  for (const id of ['chief', 'writer', 'room-writer']) assert.deepEqual(hidden.filter(([sessionId]) => sessionId === id), [[id, [QUESTION]], [id, servedDelegation]])
  assert.deepEqual(hidden.filter(([sessionId]) => sessionId === 'plain' || sessionId === 'elsewhere'), [])
})

test('a Bot\'s chat and its group Sessions mask the Agent Teams tools; other Sessions keep them', async (t) => {
  const { agentFor, hidden, stop } = await setup({ served: ['read', 'ask_user', 'send_message', 'list_agents', ...AGENT_TEAMS] })
  t.after(stop)
  for (const id of ['chief', 'room-writer', 'plain']) await agentFor(id)
  for (const id of ['chief', 'room-writer']) assert.deepEqual(hidden.filter(([sessionId]) => sessionId === id), [[id, ['send_message', 'list_agents', ...AGENT_TEAMS]]])
  assert.deepEqual(hidden.filter(([sessionId]) => sessionId === 'plain'), [])
})

test('the guard refuses the delegation tools in Bot Sessions only', async (t) => {
  const { guard, stop } = await setup()
  t.after(stop)
  for (const name of DELEGATION) {
    for (const sessionId of ['chief', 'writer', 'room-writer']) assert.equal(guard(name, sessionId), DELEGATION_REFUSAL)
    for (const sessionId of ['plain', 'elsewhere', undefined]) assert.equal(guard(name, sessionId), undefined)
  }
  assert.equal(guard('read', 'writer'), undefined)
  assert.equal(guard('message_bot', 'writer'), undefined)
})

test('a delegation name restrict() cannot mask keeps the other masks and stays refused', async (t) => {
  const { rt, agentFor, hidden, guard, stop } = await setup({ served: ['read', 'ask_user', QUESTION, 'subagent', 'send_message'], throwOn: 'send_message' })
  t.after(stop)
  const warnings = []
  rt.warn = (...args) => warnings.push(args)
  await agentFor('chief')
  assert.deepEqual(hidden, [['chief', [QUESTION]], ['chief', ['subagent']]])
  assert.deepEqual(warnings, [])
  await rt.resolveAgent('chief')
  assert.deepEqual(hidden, [['chief', [QUESTION]], ['chief', ['subagent']]])
  assert.equal(guard('send_message', 'chief'), DELEGATION_REFUSAL)
})

test('Bot Sessions filter the hidden tools and their guidance out of the prompt assembly', async (t) => {
  const { rt, agentFor, scopedListeners, stop } = await setup({ served: ['read'] })
  t.after(stop)
  for (const id of ['chief', 'room-writer', 'plain']) await agentFor(id)
  const filters = scopedListeners.filter(record => record.event === 'system-prompt/assemble')
  assert.deepEqual(filters.map(record => record.sessionId), ['chief', 'chief', 'room-writer', 'room-writer'])
  await rt.resolveAgent('chief')
  assert.equal(scopedListeners.length, 4)
  const filtered = await filters[0].listener({}, {}, async () => ({
    sections: [{ name: 'bot-identity' }, { name: 'tool:goal' }, { name: 'tool:workflow' }, { name: 'tool:subagent' }, { name: 'tool:bash' }],
    contexts: [{ name: 'x' }],
    tools: [{ name: 'read' }, { name: 'subagent' }, { name: 'workflow' }, { name: 'send_message' }, { name: 'message_bot' }, { name: 'ask_user_question' }],
    variables: { a: 1 },
  }))
  assert.deepEqual(filtered.sections.map(section => section.name), ['bot-identity', 'tool:bash'])
  assert.deepEqual(filtered.tools.map(tool => tool.name), ['read', 'message_bot'])
  assert.deepEqual(filtered.contexts, [{ name: 'x' }])
  assert.deepEqual(filtered.variables, { a: 1 })
  // Fei2411/DS-Bot#814: DSH 0.2.2 adds the tool list after this waterfall, so the
  // assembly it passes has none; the guidance is still filtered and no tools appear.
  const current = await filters[0].listener({}, {}, async () => ({
    sections: [{ name: 'bot-identity' }, { name: 'tool:subagent' }],
    contexts: [],
    variables: {},
  }))
  assert.deepEqual(current, { sections: [{ name: 'bot-identity' }], contexts: [], variables: {} })
  const team = await filters[0].listener({}, {}, async () => ({
    sections: [{ name: 'bot-identity' }, { name: 'team:policy' }, { name: 'tool:spawn_teammate' }],
    contexts: [],
    variables: {},
  }))
  assert.deepEqual(team.sections.map(section => section.name), ['bot-identity'])
  const computer = await filters[1].listener({}, {}, async () => ({
    sections: [{ name: 'bot-identity' }, { name: 'computer-use:dsh-cua' }],
    contexts: [],
    variables: {},
  }))
  assert.deepEqual(computer, { sections: [{ name: 'bot-identity' }], contexts: [], variables: {} })
  await stop()
  for (const record of scopedListeners) assert.equal(record.disposed, true)
})

test('a Bot schedules only into its own chat', async (t) => {
  const { ctx, stop } = await setup()
  t.after(stop)
  const guard = (name, sessionId, args) => ctx.guards.map(check => check({ name, arguments: args, agent: { id: sessionId } })).find(reason => reason !== undefined)
  for (const target of ['new_once', 'new']) {
    assert.match(guard('schedule_create', 'writer', { target }), /this_session/)
    assert.match(guard('schedule_edit', 'room-writer', { id: 's1', action: 'update', target }), /this_session/)
    assert.equal(guard('schedule_create', 'plain', { target }), undefined)
  }
  assert.equal(guard('schedule_create', 'writer', { target: 'this_session' }), undefined)
  assert.equal(guard('schedule_edit', 'writer', { id: 's1', action: 'delete' }), undefined)
})
