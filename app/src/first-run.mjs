import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findTeam, userDshHome } from './import.mjs'
import { installFolder } from './move-data.mjs'
import { freeSpace } from './place.mjs'
import { t } from './start/text.mjs'

export const tx = (key, vars) => t(key, vars)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

const PICKER_LABELS = ['places', 'drives', 'home', 'desktop', 'documents', 'downloads', 'path', 'go', 'up', 'newFolder', 'newName', 'create', 'name', 'cancel', 'chooseFolder', 'open', 'save', 'replace', 'loading']
const PICKER_LINES = ['empty', 'noFolders', 'more']
const PICKER_ERRORS = ['missing', 'drive', 'denied', 'notFolder', 'notFile', 'tooLong', 'unreadable', 'name', 'exists', 'isFolder', 'replace']

export function pickerLabels() {
  return Object.fromEntries([
    ...PICKER_LABELS.map(key => [key, tx(`picker.${key}`)]),
    ...PICKER_LINES.map(key => [key, tx(`dialog.picker.${key}`)]),
    ...PICKER_ERRORS.map(key => [`error.${key}`, tx(`dialog.picker.${key}`)]),
  ])
}

class Quit extends Error {}

async function pick(title, from, signal, ui) {
  const picked = await ui.asking(ui.pick({ mode: 'folder', title, start: existsSync(from) ? from : dirname(from) }))
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return picked ?? undefined
}

export const programFolder = () => installFolder(app.getPath('exe'))

export async function pickRoot(from, signal, ui) {
  try {
    return await pick(tx('dialog.pickRoot'), from, signal, ui)
  } catch (error) {
    if (error instanceof Quit) return undefined
    throw error
  }
}

export const defaultPlaces = () => ({ dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DS Bot') })

export function teamIn(dataDir) {
  try {
    return findTeam(dataDir)
  } catch {
    return undefined
  }
}

export function teamsAt(dataDir = defaultPlaces().dataDir) {
  const team = teamIn(dataDir)
  return { team, offered: team === undefined && teamIn(userDshHome()) !== undefined }
}

function offerOf(dataDir) {
  try {
    return teamIn(dataDir) === undefined ? findTeam(userDshHome()) : undefined
  } catch (error) {
    console.error(error)
    return undefined
  }
}

export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  const saved = readSaved(file)
  const kept = saved !== undefined && typeof saved.dataDir === 'string' && resolve(saved.dataDir) === resolve(dataDir) && roomOf(saved.freeAtStart) !== undefined
  const freeAtStart = kept ? saved.freeAtStart : roomOf(freeSpace(dataDir))
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace, freeAtStart }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const roomOf = bytes => (Number.isFinite(bytes) && bytes > 0 ? bytes : undefined)

function readSaved(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function chooseLocations() {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace, freeAtStart: roomOf(saved.freeAtStart) }
  }
  const { dataDir, workspace } = defaultPlaces()
  const offer = offerOf(dataDir)
  if (offer !== undefined) return { dataDir, workspace, offer }
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace }
}
