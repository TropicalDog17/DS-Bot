import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, state } from './fake-electron.mjs'
import { hold } from './fake-host-process.mjs'

export const waitFor = async (check, what, timeout = 10_000) => {
  const until = Date.now() + timeout
  for (;;) {
    if (check()) return
    if (Date.now() > until) throw new Error(`the app did not ${what}`)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

export const startApp = async ({ packaged = true, saved = {}, acknowledged = true, firstRun = false } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-main-home-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
  if (!firstRun) writeFileSync(join(paths.userData, 'locations.json'), JSON.stringify({ dataDir: home, workspace, ...saved }))
  if (acknowledged) writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  hold()
  if (process.platform === 'darwin') process.env.DS_BOT_UPDATE_URL ??= 'data:application/json,%5B%5D'
  await import('../../src/main.mjs')
  state.packaged = packaged
  if (process.platform === 'linux') process.env.APPIMAGE ??= '/tmp/ds-bot.AppImage'
  return { home, workspace }
}

const isStart = win => (win.options.webPreferences?.additionalArguments ?? []).some(arg => arg.startsWith('--ds-bot-start='))

export const startWindows = () => state.windows.filter(isStart)

export const teamWindows = () => state.windows.filter(win => !isStart(win))

export const window = () => teamWindows().at(-1)

export const handOff = async () => {
  const win = window()
  await waitFor(() => win.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'load the team view')
  win.webContents.mainFrame.url = win.url
  state.ipc.get('ds-bot:ready')({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  await waitFor(() => win.visible === true, 'show the team window')
  await waitFor(() => startWindows().every(start => start.destroyed), 'hand over to the team window')
}

export const trayMenu = () => state.tray.menu.template

export const startState = (start = startWindows().at(-1)) => start?.webContents.sent.filter(([channel]) => channel === 'ds-bot:start-state').at(-1)?.[1]

export const startAct = async (name, value, start = startWindows().at(-1)) => {
  await new Promise((resolve) => { setImmediate(resolve) })
  start.webContents.mainFrame.url = start.url
  return state.ipc.get('ds-bot:start-act')({ sender: start.webContents, senderFrame: start.webContents.mainFrame }, name, value === undefined ? undefined : { value })
}

export const windowCards = (win = window()) => win.webContents.sent.filter(([channel]) => channel === 'ds-bot:app-card').map(([, card]) => card)

export const answerCard = (index, win = window()) => {
  const card = windowCards(win).at(-1)
  win.webContents.mainFrame.url = win.url
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  state.ipc.get('ds-bot:app-card-shown')(event, card.id)
  state.ipc.get('ds-bot:app-card-answer')(event, card.id, index)
  return card
}

export const messageBoxes = () => state.dialogs.filter(options => 'message' in options)

export const moveFromStart = async (to, { before = () => {}, picked = () => {} } = {}) => {
  const places = await startApp({ saved: { freeAtStart: Number.MAX_SAFE_INTEGER } })
  before(places)
  await waitFor(() => startState()?.place !== undefined, 'show the place line')
  state.openAnswer = { canceled: false, filePaths: [to] }
  await startAct('pick', 'changePlace')
  await waitFor(() => startState().card?.kind === 'move', 'ask about the move')
  picked()
  await startAct('answer', 'move')
  await waitFor(() => startWindows()[0].url.endsWith('?start=moving'), 'turn the start window into the move\'s')
  return places
}
