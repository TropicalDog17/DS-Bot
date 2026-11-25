import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { messageBoxes, startAct, startApp, startState, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

Object.defineProperty(process, 'platform', { value: 'win32' })

const MB = 1024 * 1024

test('a failed start offers the downloading update on its banner and installs it', async () => {
  const downloads = []
  updater.checkForUpdates = () => {
    updaterState.checks += 1
    const download = {}
    download.promise = new Promise((resolve, reject) => { Object.assign(download, { resolve, reject }) })
    downloads.push(download)
    return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' }, downloadPromise: download.promise })
  }
  await startApp()
  await waitFor(() => updaterState.checks === 1, 'check for an update')
  updater.emit('download-progress', { percent: 37.4, transferred: 78 * MB, total: 212 * MB })

  hostState.fail = true
  hostState.release()
  await waitFor(() => startState()?.view === 'failed', 'show the failure page')
  await waitFor(() => startState().update !== undefined, 'offer the update')
  assert.deepEqual(startState().update, { state: 'downloading', version: '9.9.9', percent: 37, received: 78, total: 212 })

  downloads[0].reject(new Error('download failed'))
  updater.emit('error', new Error('download failed'))
  await waitFor(() => startState().update?.state === 'failed', 'say that the download failed')
  assert.equal(await startAct('installUpdate'), true)
  await waitFor(() => updaterState.checks === 2, 'check again')
  updater.emit('update-available', { version: '9.9.9' })
  updater.emit('download-progress', { percent: 64.2, transferred: 136 * MB, total: 212 * MB })
  await waitFor(() => startState().update?.percent === 64, 'show the new download')
  assert.equal(startState().update.state, 'downloading')

  assert.equal(await startAct('manualDownload'), true)
  await waitFor(() => (state.opened ?? []).length === 1, 'open the release page')
  assert.deepEqual(state.opened, ['https://github.com/Fei2411/DS-Bot/releases/latest'])

  downloads[1].resolve()
  await waitFor(() => updaterState.quitAndInstall.length === 1, 'install the update')
  assert.equal(startState().update.state, 'installing')
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})

test('the app ends after the update', async () => {
  let left = false
  app.once('will-quit', () => { left = true })
  app.quit()
  await waitFor(() => left, 'leave')
})
