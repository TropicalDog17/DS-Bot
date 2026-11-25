import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

Object.defineProperty(process, 'platform', { value: 'darwin' })

before(async () => { await startApp({ packaged: false }) })

test('the application menu of macOS has no Quit', async () => {
  await waitFor(() => state.menus.length > 0, 'set the menu')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const menu = state.menus.at(-1).template
  const items = menu[0].submenu
  assert.equal(menu[0].label, 'DS Bot', 'the menu of the app')
  assert.equal(items.some(item => item.role === 'quit'), false, 'no Quit of its own')
  assert.equal(items.some(item => item.accelerator === 'CmdOrCtrl+Q' || item.accelerator === 'Command+Q'), false, 'no shortcut for it')
  assert.equal(items.some(item => item.label === 'Quit DS Bot'), false, 'no entry for it')
  const roles = items.map(item => item.role).filter(Boolean)
  for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide']) assert.ok(roles.includes(role), `the menu keeps ${role}`)
})

test('the app ends', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
