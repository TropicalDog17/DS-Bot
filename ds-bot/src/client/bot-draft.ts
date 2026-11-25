import { agentAvatar, isLocalRoute, modelsFor, routeOf } from './agent-routes.ts'
import { t } from './i18n.ts'

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

export function startModel(roster) {
  const usable = modelsFor(roster.models).filter(model => model.needsKey !== true)
  return (usable.find(model => model.ref === roster.prefs?.defaultBotModel) ?? usable.find(model => model.ref === roster.defaultModel) ?? usable[0])?.ref ?? ''
}

export function createPayload({ name, look, image, model, effort, brief, ownLook = false, sectionId }) {
  const badge = !image && !ownLook && isLocalRoute(model) ? agentAvatar(String(model).split('/')[0]) : undefined
  const payload: Record<string, any> = { name, color: look.color, avatar: image ? { shape: look.shape, image } : badge !== undefined ? { shape: look.shape, image: badge.image } : { shape: look.shape } }
  if (model) payload.model = model
  if (effort !== undefined) payload.effort = effort
  if (brief) payload.brief = brief
  if (sectionId) payload.sectionId = sectionId
  return payload
}

export function avatarAfter(bot, target) {
  const worn = bot.engine === undefined ? undefined : agentAvatar(bot.engine)?.image
  if (worn === undefined || bot.avatar?.image !== worn) return {}
  const { image: _worn, ...rest } = bot.avatar
  const logo = isLocalRoute(target) ? agentAvatar(routeOf(target))?.image : undefined
  if (logo !== undefined) return { avatar: { ...rest, image: logo } }
  return { avatar: Object.keys(rest).length > 0 ? rest : null }
}

export function runModeNotes({ bot, roster, target, agent }) {
  const groups = (roster.rooms ?? []).filter(room => room.members?.includes(bot.id)).length
  const notes = [groups === 0
    ? t('Its own chat starts a new part with a handoff before the next turn.')
    : t('Its own chat and {count} group chats each start a new part with a handoff before the next turn.', { count: groups })]
  notes.push(t('Earlier messages stay readable. Its memory and instructions stay the same.'))
  if (!isLocalRoute(target)) return notes
  if ((bot.capabilities ?? []).length > 0) notes.push(t('Its shared MCP servers and skills do not reach a local agent.'))
  if (agent?.signedIn === false) notes.push(t('{agent} is not signed in. Sign in first, or its turns fail.', { agent: agent.name }))
  if (bot.private === true) notes.push(t('The privacy rules of a private Bot do not cover the tools of a local agent.'))
  return notes
}
