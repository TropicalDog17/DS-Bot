import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/chat-index.ts'
import { fromOptChat, importedChatFile, parseImportedChat } from '../src/host/imported-chat.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'dsb-imported-chat-'))
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

function writeImported(home, botId, rows) {
  const file = importedChatFile(home, botId)
  mkdirSync(join(home, 'imported-chat'), { recursive: true })
  writeFileSync(file, jsonl(rows))
}

const OLD = [
  { seq: 0, time: Date.parse('2026-10-31T03:53:00Z'), who: 'user', text: 'how should I split the 600 a month' },
  { seq: 1, time: Date.parse('2026-10-31T03:54:00Z'), who: 'you', text: 'DCA plan: 480 into VOO/QQQ, 90 crypto, 30 gold' },
  { seq: 2, time: Date.parse('2026-11-02T00:30:00Z'), who: 'user', text: 'drop the Vietnamese stocks' },
]

function runtime(home) {
  const events = [{ seq: 0, type: 'user/message', time: Date.parse('2026-11-20T02:44:00Z'), text: 'what about the DCA plan' }]
  const rt = {
    home,
    ctx: {
      effect: () => {},
      sessionController: { page: async () => ({ records: events.map(event => ({ event })), hasMore: false }) },
    },
    resolveAgent: async () => ({ session: { seq: events.length } }),
    historyEntry: event => ({ text: event.text, who: 'user', keepAnswers: false }),
    partsOf: () => [{ sessionId: 's1', number: 1, startedAt: events[0].time }],
    partsOfThread: () => rt.partsOf(),
    partLines: async function* () { for (const event of [...events].reverse()) yield { seq: event.seq, time: event.time, who: 'user', text: event.text } },
    clock: time => new Date(time).toISOString().slice(5, 10),
    warn: () => {},
  }
  install(rt)
  return rt
}

test('an OptChat store gives only what the user and the assistant said, in order', () => {
  const dir = temp()
  mkdirSync(join(dir, 'main'))
  writeFileSync(join(dir, 'main', '2026-10-31.jsonl'), jsonl([
    { i: 0, kind: 'user', text: 'hello', date: '2026-10-31T10:00:00+07:00' },
    { i: 1, kind: 'tool', text: 'shell ls', date: '2026-10-31T10:00:01+07:00' },
    { i: 2, kind: 'echo', text: 'a.txt', date: '2026-10-31T10:00:02+07:00' },
    { i: 3, kind: 'talk', text: 'Hi!', date: '2026-10-31T10:00:03+07:00' },
  ]))
  writeFileSync(join(dir, 'main', '2026-11-01.jsonl'), jsonl([{ i: 4, kind: 'talk', text: '   ', date: '2026-11-01T10:00:00+07:00' }]))
  assert.deepEqual(fromOptChat(dir), [
    { seq: 0, time: Date.parse('2026-10-31T03:00:00Z'), who: 'user', text: 'hello' },
    { seq: 3, time: Date.parse('2026-10-31T03:00:03Z'), who: 'you', text: 'Hi!' },
  ])
  assert.throws(() => fromOptChat(join(dir, 'missing')), /main\/ is missing/)
})

test('a damaged imported chat file is refused, not half read', () => {
  assert.throws(() => parseImportedChat('{"seq":0,"time":1,"who":"user","text":"a"}\nnot json\n'), /bad JSON at line 2/)
  assert.throws(() => parseImportedChat('{"seq":0,"time":1,"who":"tool","text":"a"}\n'), /invalid message at line 1/)
})

test('read_own_chat searches the imported chat as part 0, next to the current part', async () => {
  const home = temp()
  writeImported(home, 'b1', OLD)
  const rt = runtime(home)
  const { lines, every } = await rt.searchOwnChat('b1', 'DCA')
  assert.equal(every, true)
  assert.deepEqual(lines, [
    '[part 0 #1 · 10-31] You: DCA plan: 480 into VOO/QQQ, 90 crypto, 30 gold',
    '[part 1 #0 · 11-20] User: what about the DCA plan',
  ])
  const around = await rt.aroundOwnChat('b1', 'part 0 #1')
  assert.equal(around.exact, true)
  assert.equal(around.lines.length, 3)
  assert.match(around.lines[2], /^\[part 0 #2 · 11-02\] User: drop the Vietnamese stocks/)
  assert.match((await rt.aroundOwnChat('b1', '#0')).lines[0], /^\[part 1 #0/)
  assert.equal(rt.partIndex([rt.importedPart('b1'), ...rt.partsOf()]), 'part 0 (an earlier chat imported from before you existed, 10-31 – 11-02), part 1 (11-20 – now)')
})

test('an imported chat written again replaces the old one in the index', async () => {
  const home = temp()
  writeImported(home, 'b1', OLD)
  const rt = runtime(home)
  assert.equal((await rt.searchOwnChat('b1', 'gold')).lines.length, 1)
  writeImported(home, 'b1', [{ seq: 0, time: OLD[0].time, who: 'user', text: 'only silver now, a longer line to change the size' }])
  assert.deepEqual((await rt.searchOwnChat('b1', 'gold')).lines, [])
  assert.equal((await rt.searchOwnChat('b1', 'silver')).lines.length, 1)
})

test('a Bot without an imported chat has no part 0', async () => {
  const rt = runtime(temp())
  assert.equal(rt.importedPart('b1'), undefined)
  assert.deepEqual((await rt.searchOwnChat('b1', 'DCA')).lines, ['[#0 · 11-20] User: what about the DCA plan'])
})

test('without the index, the log scan reads the imported chat too', async () => {
  const home = temp()
  mkdirSync(join(home, 'chat-index.sqlite'), { recursive: true })
  writeImported(home, 'b1', OLD)
  const rt = runtime(home)
  const { lines } = await rt.searchOwnChat('b1', 'dca')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[part 0 · 10-31\] DCA plan/)
  assert.match(lines[1], /^\[part 1 · 11-20\] what about the DCA plan/)
})
