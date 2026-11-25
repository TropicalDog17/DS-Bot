import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { HostProcess } from './helpers/fake-host-process.mjs'
import { messageBoxes, moveFromStart, startAct, startState, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

test('a folder that cannot be used after the engine stopped is refused on a card', async () => {
  const to = join(mkdtempSync(join(tmpdir(), 'ds-bot-move-')), 'data')
  const stop = HostProcess.prototype.stop
  HostProcess.prototype.stop = async function (...args) {
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'notes.txt'), '')
    return stop.apply(this, args)
  }
  const { home } = await moveFromStart(to)
  await waitFor(() => startState().card?.kind === 'moveFailed', 'refuse the folder')
  assert.deepEqual(startState().card, { kind: 'moveFailed', dataDir: home, why: 'place', place: 'foreign', path: to })
  assert.equal(state.relaunches.length, 0, 'the card waits for the user')

  await startAct('answer', 'old')
  await waitFor(() => state.relaunches.length === 1, 'start again where the data was')
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')).dataDir, home)
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})
