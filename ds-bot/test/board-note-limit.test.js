import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { NOTE_MAX, REPLY_MAX, createBoard } from '../src/board/cards.ts'
import { charCount } from '../src/board/card-fields.ts'
import { install, ROUTE } from '../src/board/plugin.ts'
import { CARD_NOTE_MAX } from '../src/host/companions.ts'
import { fakeContext } from './fake-ctx.js'

async function host(t, assignee = 'user') {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-note-limit-'))
  const ctx = fakeContext()
  const boardCtx = fakeContext()
  const routes = new Map()
  boardCtx.connection.fetch.register = route => { routes.set(route.path, route); return () => routes.delete(route.path) }
  const prompts = []
  const file = join(home, 'board.json')
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', createdAt: 1 },
      writer: { id: 'writer', name: 'Writer', createdAt: 2 },
    },
  }))
  Object.assign(ctx, {
    workspaceRegistry: { resolveByPath: async () => ({ id: 'board-workspace' }) },
    sessionTitle: { rename: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'card-thread' }),
      resolveAgent: async id => ({ agent: { ...ctx.scopeAgent(id), session: { id, requestHeader: () => undefined } } }),
      prompt: async input => { prompts.push(input) },
    },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  const board = install(boardCtx, { file, adoptMs: -1, waitPollMs: -1, watchMs: -1, mergePollMs: -1 }, {
    ...rt.companions, identity: { ownerOfSession: rt.ownerOfSession }, tools: boardCtx.tools, connection: boardCtx.connection,
  })
  t.after(async () => {
    board.dispose()
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const added = await board.handle('add', { title: 'Release notes', assignee, brief: 'Describe the release.' })
  assert.equal(added.ok, true)
  const [id] = Object.keys(added.value.cards)
  return {
    id, prompts, board, rt,
    userNote: text => board.handle('note', { id, text }),
    botNote: text => board.tool.execute({ action: 'note', id, text }, { agent: { id: 'chief' } }),
    async snapshot() {
      const response = await routes.get(ROUTE).fetch(new Request(`http://dsh${ROUTE}`, {
        method: 'POST', body: JSON.stringify({ endpoint: 'state' }),
      }))
      assert.equal(response.status, 200)
      return response.json()
    },
    notes: () => JSON.parse(readFileSync(file, 'utf8')).cards[id].notes.map(note => note.text),
  }
}

test('a 20000 character note is stored whole', async (t) => {
  const h = await host(t)
  const text = 'a'.repeat(19_999) + 'z'
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Noted on /)
  assert.deepEqual(h.notes(), [text, text])
})

test('a note over the limit is refused with the limit in the error', async (t) => {
  const h = await host(t)
  const text = 'x'.repeat(20_001)
  const error = 'The note is 20001 characters; the limit is 20000. Shorten it and send it again.'
  assert.deepEqual((await h.userNote(text)).error, { code: 'board/refused', message: error })
  assert.equal(await h.botNote(text), error)
  assert.deepEqual(h.notes(), [])
})

test('a note keeps its line breaks', async (t) => {
  const h = await host(t)
  const text = '  first \t\r\n  second\r\n\r\n \t\r\n\r\n\r\nlast \t\n '
  const expected = '  first \t\n  second\n\n \t\n\n\nlast'
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Noted on /)
  assert.deepEqual(h.notes(), [expected, expected])
})

test('a note keeps what the user typed', async (t) => {
  const h = await host(t)
  const examples = [
    ['first\r\nsecond\rthird \t\n', 'first\nsecond\nthird'],
    ['    code()\n    more()', '    code()\n    more()'],
    ['line1  \nline2', 'line1  \nline2'],
    ['a\n\n\n\n\nb', 'a\n\n\n\n\nb'],
    ['a\u2028b', 'a\u2028b'],
    ['## Markdown\n<details>\n**Hello**\n</details>', '## Markdown\n<details>\n**Hello**\n</details>'],
  ]
  for (const [input] of examples) {
    assert.equal((await h.userNote(input)).ok, true)
    assert.match(await h.botNote(input), /^Noted on /)
  }
  assert.deepEqual(h.notes(), examples.flatMap(([, expected]) => [expected, expected]))
})

test('the limit counts code points', async (t) => {
  const h = await host(t)
  const text = '漢🙂'.repeat(10_000)
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Noted on /)
  assert.match((await h.userNote(text + '界')).error.message, /20001 characters; the limit is 20000/)
  assert.match(await h.botNote(text + '🙂'), /20001 characters; the limit is 20000/)
  assert.equal(charCount('🇻🇳'), 2)
  assert.equal(charCount('👨‍👩‍👧'), 5)
  const emoji = '🙂'.repeat(20_000)
  assert.equal((await h.userNote(emoji)).ok, true)
  assert.match((await h.userNote(emoji + '🙂')).error.message, /20001 characters; the limit is 20000/)
  const decomposed = 'a'.repeat(19_999) + 'e\u0301'
  assert.match((await h.userNote(decomposed)).error.message, /20001 characters; the limit is 20000/)
  assert.deepEqual(h.notes(), [text, text, emoji])
  for (const note of h.notes()) {
    assert.equal([...note].length, 20_000)
    assert.doesNotMatch(note, /[\uD800-\uDFFF\uFFFD]/u)
  }
})

test('a long note reaches the assignee Bot whole', async (t) => {
  const h = await host(t, 'writer')
  const text = '  ' + '漢🙂'.repeat(9_996) + '  \n\n\nZ'
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Passed on to Writer/)
  assert.deepEqual(h.notes(), [text, text])
  const [user, bot] = h.prompts.slice(-2)
  assert.equal(user.sessionId, 'card-thread')
  assert.equal(bot.sessionId, 'card-thread')
  assert.equal(user.content[0].text, `Note on card ${h.id} "Release notes": ${text}`)
  assert.equal(bot.content[0].text, `Note on card ${h.id} "Release notes" from Chief: ${text}`)
})

test('a note of only spaces or zero-width characters is empty', async (t) => {
  const h = await host(t, 'writer')
  const before = h.prompts.length
  for (const text of ['   \t\n \n ', '\u00a0\u00a0', '\u200b', '\u200b \u200c\u200d\ufeff']) {
    assert.equal((await h.userNote(text)).error.message, 'Write a note first.')
    assert.equal(await h.botNote(text), 'note needs the text to pass on.')
    assert.deepEqual(await h.rt.companions.notes.deliver({ botId: 'writer', cardId: h.id, text }), { error: 'Write a note first.' })
  }
  assert.deepEqual(h.notes(), [])
  assert.equal(h.prompts.length, before)
})

test('invisible characters alone are an empty note', async (t) => {
  const h = await host(t, 'writer')
  const before = h.prompts.length
  for (const text of ['\u2060', '\u3164', '\u00ad', '\u115f\u1160', ' \u2060\u3164\u00ad\n']) {
    assert.equal((await h.userNote(text)).error.message, 'Write a note first.')
    assert.equal(await h.botNote(text), 'note needs the text to pass on.')
    assert.deepEqual(await h.rt.companions.notes.deliver({ botId: 'writer', cardId: h.id, text }), { error: 'Write a note first.' })
  }
  assert.deepEqual(h.notes(), [])
  assert.equal(h.prompts.length, before)

  const text = 'use\u2060real\u00adtext\u3164'
  assert.equal((await h.userNote(text)).ok, true)
  assert.deepEqual(h.notes(), [text])
  assert.equal(h.prompts.at(-1).content[0].text, `Note on card ${h.id} "Release notes": ${text}`)
})

test('a bot note over the limit is refused by the tool', async (t) => {
  const h = await host(t, 'writer')
  const before = h.prompts.length
  const text = 'b'.repeat(20_001)
  const error = 'The note is 20001 characters; the limit is 20000. Shorten it and send it again.'
  const cards = structuredClone(h.board.store.read().cards)
  const board = createBoard({ roster: h.rt.companions.roster })
  assert.deepEqual(board.bot(cards, 'note', 'chief', undefined, { id: h.id, text }), { error })
  assert.equal(await h.botNote(text), error)
  assert.deepEqual(h.notes(), [])
  assert.equal(h.prompts.length, before)
})

test('a card note over the limit is refused before delivery', async (t) => {
  const h = await host(t, 'writer')
  const before = h.prompts.length
  assert.deepEqual(await h.rt.companions.notes.deliver({ botId: 'writer', cardId: h.id, text: '🙂'.repeat(20_001) }), {
    error: 'The note is 20001 characters; the limit is 20000. Shorten it and send it again.',
  })
  assert.deepEqual(h.notes(), [])
  assert.equal(h.prompts.length, before)
})

test('the host and the board share one note limit', () => {
  assert.equal(NOTE_MAX, 20_000)
  assert.equal(CARD_NOTE_MAX, NOTE_MAX)
})

test('200 long notes keep the board payload sound', async (t) => {
  const h = await host(t)
  const texts = Array.from({ length: 200 }, (_, index) => String(index).padEnd(20_000, 'x'))
  for (const text of texts) assert.equal((await h.userNote(text)).ok, true)
  assert.deepEqual(h.notes(), texts)
  const snapshot = await h.snapshot()
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.value.cards[h.id].notes.map(note => note.text), texts)
})

test('a long bot answer is mirrored without breaking a character', async (t) => {
  const h = await host(t, 'writer')
  assert.equal((await h.userNote('What changed?')).ok, true)
  const prefix = 'a'.repeat(REPLY_MAX - 3) + '🙂🙂'
  h.rt.botReplied({ sessionId: 'card-thread', cardId: h.id, botId: 'writer', since: Date.now(), text: prefix + '🙂 and more' })
  await h.board.store.change(() => ({ error: 'settled' }))
  const mirrored = h.notes().at(-1)
  assert.equal(mirrored, prefix + '…')
  assert.equal(charCount(mirrored), REPLY_MAX)
  assert.doesNotMatch(mirrored, /[\uD800-\uDFFF]/u)
})
