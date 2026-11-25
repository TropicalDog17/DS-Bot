import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'

export const GOAL_PATCH_NAME = 'goal.patch.yml'

const PRESET = '@deepseek-ai/dsh-agent-preset'
const GOAL_ROWS = new Set(['@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal'])

const hasGoalRow = (rows) => rows.some(row => GOAL_ROWS.has(row?.name)
  || (row?.group === true && Array.isArray(row.config) && hasGoalRow(row.config)))

const stripGoalRows = (rows) => rows
  .map(row => (row?.group === true && Array.isArray(row.config)
    ? { ...row, config: stripGoalRows(row.config) }
    : row))
  .filter(row => GOAL_ROWS.has(row?.name) === false)

export function goalPatch(profile) {
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const rows = entries
    .filter(entry => entry.name === PRESET && Array.isArray(entry.config?.plugins) && hasGoalRow(entry.config.plugins))
    .map(entry => ({ id: entry.id, name: entry.name, config: { ...entry.config, plugins: stripGoalRows(entry.config.plugins) } }))
  return rows.length === 0 ? undefined : rows
}

export function reconcileGoal(profile) {
  const file = join(dirname(profile.dir), GOAL_PATCH_NAME)
  const rows = goalPatch(profile)
  if (rows === undefined) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, dump(rows, { schema: entryListSchema }), 'utf8')
  return [file]
}
