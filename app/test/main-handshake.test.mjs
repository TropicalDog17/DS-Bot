import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => {
  state.rejectLoads = true
  await startApp()
})

test('a first load that never came through does not carry the token again', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const first = window()
  hostState.release()
  await waitFor(() => first.loaded.some(url => url.includes('token=')), 'try the Host')
  assert.equal(state.cookies.length, 0, 'the Host left no cookie')

  first.destroy()
  trayMenu()[0].click()
  await waitFor(() => teamWindows().length === 2, 'build a new window')
  const second = window()
  await waitFor(() => second.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the Host')
  assert.equal(second.loaded.filter(url => url.includes('token=')).length, 0, 'the token is not used again')
  assert.equal(hostState.starts, 1, 'no second Host was started')
})

test('the app ends', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
