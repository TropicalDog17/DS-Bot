import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPartView, toolLabel } from '../src/host/part-view.ts'
import { createSessionIndex } from '../src/host/session-index.ts'

function makeRuntime() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const sessionIndex = createSessionIndex()
  sessionIndex.registerChat('s1', 'a')
  const state = {
    exchangeTurns: {} as Record<string, number[]>,
    closedCards: {} as Record<string, Record<string, string>>,
  }
  const rt = {
    ctx: {
      on(name: string, fn: (...args: any[]) => void) {
        const list = listeners.get(name) ?? []
        list.push(fn)
        listeners.set(name, list)
      },
      sessionController: {
        page: async () => ({ records: [], hasMore: false }),
      },
    },
    state,
    sessionIndex,
    chatOwners: sessionIndex.chatOwners,
    groupOwners: sessionIndex.groupOwners,
    roomOwners: sessionIndex.roomOwners,
    pastOwners: sessionIndex.pastOwners,
    own: (table: any, key: string) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined),
    roomOf: () => undefined,
    groupRows: () => [],
    resolveAgent: async () => undefined,
    thinkingOf: async () => undefined,
  }
  const view = createPartView({
    rt,
    partsOf: () => [{ sessionId: 's1', number: 1, startedAt: 100 }],
    partsOfThread: () => [{ sessionId: 's1', number: 1, startedAt: 100 }],
  })
  const emit = (session: any, event: any) => {
    for (const fn of listeners.get('session/event') ?? []) fn(session, event)
  }
  return { rt, view, emit }
}

test('displayItems projects user, assistant, presented deliverables, and skips hidden exchange turns', () => {
  const { rt, view } = makeRuntime()
  rt.state.exchangeTurns.s1 = [2]
  const items = view.displayItems('s1', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', seq: 3, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'hi there' }] } } },
    { type: 'deliverables/presented', seq: 4, data: { turn: 1, files: [{ path: '/tmp/report.md' }] } },
    { type: 'turn/start', seq: 5, data: { turn: 2 } },
    { type: 'assistant/message', seq: 6, time: 12, data: { turn: 2, message: { content: [{ type: 'text', text: 'internal' }] } } },
  ])

  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { kind: 'user', text: 'hello', time: 10, seq: 2, turn: 1 })
  assert.deepEqual(items[1], {
    kind: 'bot',
    text: 'hi there',
    time: 11,
    seq: 3,
    turn: 1,
    files: [{ name: 'report.md', sessionId: 's1', seq: 4, index: 0 }],
  })
})

test('stepsItems tracks tool calls and results per turn while omitting card and relay tools', () => {
  const { view } = makeRuntime()
  const byTurn = view.stepsItems([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId: 'c1', name: 'message_bot' } },
    { type: 'tool/call', data: { callId: 'c2', name: 'ask_user' } },
    { type: 'tool/call', data: { callId: 'c3', name: 'bash_exec' } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', ok: true } } },
    { type: 'tool/result', data: { message: { toolCallId: 'c3', ok: false } } },
  ], 's1')

  assert.deepEqual(byTurn.get(1), [
    { name: 'message_bot', label: 'Asking another Bot', ok: true },
    { name: 'bash_exec', label: 'Running shell commands', ok: false },
  ])
  assert.equal(toolLabel('remember'), 'Saving to memory')
  assert.equal(toolLabel('web_search'), 'Searching online')
})

test('chatTail tracks live preview updates after initial observation', () => {
  const { view, emit } = makeRuntime()
  assert.equal(view.chatTail('s1'), undefined)
  emit({ id: 's1' }, { type: 'assistant/message', seq: 1, time: 500, data: { message: { content: [{ type: 'text', text: '  final   answer  ' }] } } })
  assert.deepEqual(view.chatTail('s1'), { lastAt: 500, preview: 'final answer' })
})
