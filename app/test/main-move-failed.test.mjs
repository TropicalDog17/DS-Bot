import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { messageBoxes, moveFromStart, startAct, startState, startWindows, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('a failed copy asks on a card whether to copy again or start where the data was', async () => {
  const parent = join(mkdtempSync(join(tmpdir(), 'ds-bot-move-')), 'a-file')
  const to = join(parent, 'data')
  const { home } = await moveFromStart(to, {
    picked: () => {
      rmSync(parent, { recursive: true, force: true })
      writeFileSync(parent, '')
    },
  })
  const failures = () => startWindows()[0].webContents.sent.filter(([channel, snapshot]) => channel === 'ds-bot:start-state' && snapshot.card?.kind === 'moveFailed' && snapshot.view === 'card').length
  const shown = () => startWindows()[0].webContents.sent.filter(([channel]) => channel === 'ds-bot:start-state').length
  await waitFor(() => startState().card?.kind === 'moveFailed', 'say that the copy failed')
  const { log, ...card } = startState().card
  assert.deepEqual(card, { kind: 'moveFailed', dataDir: home, why: 'copy', reason: 'other' })
  assert.ok(log.length > 0 && log.every(line => typeof line === 'string'), 'the error goes into the details')

  const before = shown()
  await startAct('answer', 'retry')
  await waitFor(() => shown() > before && startState().view === 'card', 'copy again')
  assert.ok(startWindows()[0].webContents.sent.slice(before).some(([, snapshot]) => snapshot.view === 'moving'), 'the card went while the copy ran')
  assert.ok(failures() >= 2)
  assert.equal(state.relaunches.length, 0)

  await startAct('answer', 'old')
  await waitFor(() => state.relaunches.length === 1, 'start again where the data was')
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')).dataDir, home)
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})
