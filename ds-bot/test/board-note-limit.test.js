import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install } from '../src/board/plugin.ts'
import { fakeContext } from './fake-ctx.js'

async function host(t, assignee = 'user') {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-note-limit-'))
  const ctx = fakeContext()
  const boardCtx = fakeContext()
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
    id, prompts,
    userNote: text => board.handle('note', { id, text }),
    botNote: text => board.tool.execute({ action: 'note', id, text }, { agent: { id: 'chief' } }),
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
  const expected = 'first\n  second\n\nlast'
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Noted on /)
  assert.deepEqual(h.notes(), [expected, expected])
})

test('the limit counts code points', async (t) => {
  const h = await host(t)
  const text = '漢🙂'.repeat(10_000)
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Noted on /)
  assert.match((await h.userNote(text + '界')).error.message, /20001 characters; the limit is 20000/)
  assert.match(await h.botNote(text + '🙂'), /20001 characters; the limit is 20000/)
  assert.deepEqual(h.notes(), [text, text])
  for (const note of h.notes()) {
    assert.equal([...note].length, 20_000)
    assert.doesNotMatch(note, /[\uD800-\uDFFF\uFFFD]/u)
  }
})

test('a long note reaches the assignee Bot whole', async (t) => {
  const h = await host(t, 'writer')
  const text = '漢🙂'.repeat(9_999) + '\nZ'
  assert.equal((await h.userNote(text)).ok, true)
  assert.match(await h.botNote(text), /^Passed on to Writer/)
  assert.deepEqual(h.notes(), [text, text])
  const [user, bot] = h.prompts.slice(-2)
  assert.equal(user.sessionId, 'card-thread')
  assert.equal(bot.sessionId, 'card-thread')
  assert.equal(user.content[0].text, `Note on card ${h.id} "Release notes": ${text}`)
  assert.equal(bot.content[0].text, `Note on card ${h.id} "Release notes" from Chief: ${text}`)
})
