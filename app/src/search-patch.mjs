import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { stringify } from 'yaml'

export const SEARCH_PATCH_NAME = 'search-selector.patch.yml'

export function searchSelectorPatch(profile) {
  const layers = profile.layers
  const entries = composeEntries([...layers.map(layer => layer.patches), profile.patches])
  if (entries.find(entry => entry.id === 'web-search-auto')?.disabled !== true) return undefined
  const web = entries.find(entry => entry.id === 'web')
  if (web?.config?.searchProvider !== 'auto') return undefined
  const base = layers.filter(({ packageName }) => packageName !== 'ds-bot')
  const original = composeEntries(base.map(layer => layer.patches)).find(entry => entry.id === 'web')
  if (original?.config?.searchProvider === undefined || original.config.searchProvider === 'auto') return undefined
  return [{ id: 'web', name: original.name, config: original.config }]
}

export function reconcileSearchSelector(profile) {
  const file = join(dirname(profile.dir), SEARCH_PATCH_NAME)
  const rows = searchSelectorPatch(profile)
  if (rows === undefined) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, stringify(rows), 'utf8')
  return [file]
}
