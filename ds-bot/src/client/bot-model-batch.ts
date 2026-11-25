import { isLocalRoute } from './agent-routes.ts'

export const SKIP_LOCAL_AGENT = 'local-agent'
export const SKIP_UNAVAILABLE = 'unavailable'

export const modelRefOf = bot => bot?.model ?? bot?.appliedModel

export function planModelChange(bots, ref, models) {
  const served = (models ?? []).some(model => model.ref === ref)
  return (bots ?? []).map((bot) => {
    const current = modelRefOf(bot)
    if (isLocalRoute(current)) return { bot, action: 'skip', reason: SKIP_LOCAL_AGENT }
    if (!served) return { bot, action: 'skip', reason: SKIP_UNAVAILABLE }
    if (bot.model === ref) return { bot, action: 'keep' }
    return { bot, action: 'change' }
  })
}

export async function runModelChange({ bots, ref, models, updateBot }) {
  const results = []
  for (const entry of planModelChange(bots, ref, models)) {
    const { bot } = entry
    if (entry.action === 'skip') {
      results.push({ id: bot.id, name: bot.name, status: 'skipped', reason: entry.reason })
      continue
    }
    if (entry.action === 'keep') {
      results.push({ id: bot.id, name: bot.name, status: 'unchanged' })
      continue
    }
    try {
      await updateBot(bot.id, { model: ref })
      results.push({ id: bot.id, name: bot.name, status: 'updated' })
    } catch (failure) {
      results.push({ id: bot.id, name: bot.name, status: 'failed', message: failure?.message ?? String(failure) })
    }
  }
  return results
}

export function summarizeModelChange(results) {
  const count = status => (results ?? []).filter(entry => entry.status === status).length
  return { total: (results ?? []).length, updated: count('updated'), unchanged: count('unchanged'), skipped: count('skipped'), failed: count('failed') }
}
