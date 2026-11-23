// The Main Bot's routing digest: who is on the team, what each one is for and whether it
// is busy, as DSH runtime context (a user-role snapshot DSH adds again only when the text
// changes). Only the Main Bot's Sessions get it, and the status is coarse on purpose:
// every change adds a snapshot, so minutes and tool names stay in list_bots.
// Companion plugins add their own part (the board adds the open cards) through
// rt.routingParts, so DS Bot never reads their data.

export const DIGEST_NAME = 'ds-bot-routing-digest'
// Right after DSH's own team identity context.
const ORDER = 126
const JOB_MAX = 100

export function install(rt) {
  const { ctx } = rt
  const parts = new Set()
  // A companion adds `part(botId) -> string`; returns the remover.
  rt.routingParts = (part) => {
    parts.add(part)
    return () => { parts.delete(part) }
  }

  const busy = (bot) => {
    if ((rt.approvalsView?.() ?? []).some(entry => entry.botId === bot.id)) return 'waiting for the user'
    const sessions = [rt.chatOf(bot.id), ...(bot.openParts ?? []).map(part => part.sessionId), ...(rt.groupSessionsOf?.(bot.id) ?? [])]
    return sessions.some(sessionId => rt.live.get(sessionId)?.turn !== undefined) ? 'working' : 'idle'
  }
  const line = (bot) => {
    if (bot.private === true) return `- ${bot.name}${bot.role ? ` (${bot.role})` : ''} · private, takes no handed-on work`
    const job = (bot.instructions ?? '').split('\n')[0].trim().slice(0, JOB_MAX)
    return `- ${bot.name}${bot.role ? ` (${bot.role})` : ''}${job ? ` — ${job}` : ''} · ${busy(bot)}`
  }

  const digestFor = (sessionId) => {
    if (!rt.isBotSession(sessionId)) return ''
    const self = rt.selfOf(sessionId)
    if (!rt.isMain(self)) return ''
    const others = Object.values(rt.state.bots).filter(bot => bot.id !== self).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    const lines = ['[Team right now · for routing]', others.length === 0 ? '- No other Bots yet.' : others.map(line).join('\n')]
    for (const part of parts) {
      let text = ''
      try { text = String(part(self) ?? '').trim() } catch (error) { rt.warn?.('ds-bot: a routing digest part failed: %s', error) }
      if (text !== '') lines.push(text)
    }
    return lines.join('\n')
  }
  rt.routingDigest = digestFor

  if (typeof ctx.systemPrompt?.context !== 'function') return
  ctx.effect(() => ctx.systemPrompt.context({
    name: DIGEST_NAME,
    order: ORDER,
    interpolate: false,
    required: true,
    text: context => digestFor(context?.agent?.id),
  }), 'ds-bot: routing digest')
}
