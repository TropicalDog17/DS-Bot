import { fileURLToPath } from 'node:url'
import { LEGACY_ENGINE } from './legacy.mjs'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

export const PROFILE = 'ds-bot'
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'ds-bot']
export const CHECK_PROFILE = 'import-check'
export const CHECK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const RETIRED_BUNDLES = [LEGACY_ENGINE, 'dsbot-engine']
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

export function claimBundles(dir) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const bundles = [...BUNDLES, ...listed.filter((name) => !BUNDLES.includes(name) && !RETIRED_BUNDLES.includes(name))]
  if (bundles.join('\n') !== listed.join('\n')) writeProfileBundles(dir, manifest, bundles)
}

export function loadAppProfile() {
  const dir = resolveProfileDir(PROFILE)
  initProfile(dir, BUNDLES)
  claimBundles(dir)
  return loadOwnBundles(dir, BUNDLES)
}

export function loadCheckProfile() {
  const dir = resolveProfileDir(CHECK_PROFILE)
  initProfile(dir, CHECK_BUNDLES)
  return loadOwnBundles(dir, CHECK_BUNDLES)
}

function loadOwnBundles(dir, bundles) {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => bundles.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}
