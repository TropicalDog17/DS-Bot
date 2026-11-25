import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { answerCard, handOff, startApp, trayMenu, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

Object.defineProperty(process, 'platform', { value: 'win32' })

before(async () => { await startApp() })

test('the update waits for the window and is installed when the window comes back', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  await handOff()
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  updater.emit('update-downloaded', { version: '9.9.9' })
  await new Promise(resolve => { setTimeout(resolve, 50) })
  assert.equal(windowCards(win).length, 0, 'the card waits for the window')

  trayMenu()[0].click()
  await waitFor(() => windowCards(win).length === 1, 'ask on a card in the team window')
  assert.match(windowCards(win)[0].message, /9\.9\.9/u)
  assert.equal(windowCards(win)[0].cancel, 1, 'Escape is "Not now"')
  answerCard(0, win)
  await waitFor(() => updaterState.quitAndInstall.length === 1, 'install the update')
  assert.equal(hostState.stops, 1, 'the Host stops for the installer')
  assert.equal(updaterState.quitAndInstall[0].length, 2, 'the installer takes over')
  assert.equal(state.dialogs.length, 0, 'no message box')
})

test('the app ends after the update', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
