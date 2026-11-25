import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp({ firstRun: true }) })

after(() => { app.emit('will-quit') })

const isStart = win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start='))

test('a quit while the first run is up ends the app', async () => {
  await waitFor(() => state.windows.some(isStart), 'the start window')
  app.quit()
  await waitFor(() => state.windows.every(win => win.destroyed), 'leave anyway')
})
