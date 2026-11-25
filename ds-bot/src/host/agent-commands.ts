// DSH's command registry has no "remove for this Session" call: it offers register,
// list, find and execute only. An agent-scoped registration, though, shadows the global
// definition of the same name for that agent alone (see the host `commands` package:
// "A command-producing plugin mounted beneath an agent's own context declares its
// commands injection and registers an exact agent-scoped command, which shadows the
// global definition of the same name for that agent only").
export function install(rt) {
  if (rt.config?.commandShield === false) return
  const { ctx } = rt
  const botChat = sessionId => (Object.values(rt.state?.bots ?? {}) as any[]).some(bot => rt.chatOf?.(bot.id) === sessionId)
  const roomChat = sessionId => rt.roomOf?.(sessionId) !== undefined
    || Object.values(rt.state?.rooms ?? {}).some(room => rt.sessionOfRoom?.(room) === sessionId)
  const covered = sessionId => rt.chatOwners?.has?.(sessionId) === true || roomChat(sessionId) || botChat(sessionId)
  const isGroup = sessionId => roomChat(sessionId)
  const refusal = (sessionId, name) => {
    const where = isGroup(sessionId) ? 'a group chat' : "a Bot's chat"
    return `The DSH /${name} command does not run in ${where}.`

  }
  const rowCopy = sessionId => isGroup(sessionId)
    ? 'Not available in a group chat — use the group’s own controls'
    : 'Not available in a Bot chat — use the Bot’s own controls'
  const shields = new Map()
  let applying = false

  const sync = (shield) => {
    const commands = shield.commands
    if (commands === undefined) return
    for (const lift of shield.lifts) { try { lift() } catch {} }
    shield.lifts = []
    if (!covered(shield.sessionId)) return
    // Lift first: `list(agent)` is the merged view, so only after our shadows are gone
    // does it answer what the host currently serves this agent.
    const definitions = commands.list(shield.agent)
    for (const definition of definitions) {
      try {
        // Keep the host descriptor's identity and input hint: the client uses them to
        // claim a typed line with arguments and to keep the row's first-party face.
        const lift = commands.register({
          name: definition.name,
          description: rowCopy(shield.sessionId),
          ...(definition.definitionId === undefined ? {} : { definitionId: definition.definitionId }),
          ...(definition.input === undefined ? {} : { input: definition.input }),
          handler: () => ({ kind: 'error', text: refusal(shield.sessionId, definition.name) }),
        })
        if (typeof lift === 'function') shield.lifts.push(lift)
      } catch (error) {
        // A same-name command already in this exact agent scope keeps its own handler.
        rt.warn?.('ds-bot: the DSH /%s command could not be shadowed for %s: %s', definition.name, shield.sessionId, error?.message ?? error)
      }
    }
  }
  const resync = () => {
    if (applying) return
    applying = true
    try { for (const shield of shields.values()) sync(shield) } finally { applying = false }
  }

  const mount = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || shields.has(sessionId)) return undefined
    if (typeof agent.ctx?.plugin !== 'function') return undefined
    const shield: Record<string, any> = { sessionId, agent, child: undefined, lifts: [] }
    shield.ready = new Promise((resolve) => { shield.resolveReady = resolve })
    shields.set(sessionId, shield)
    try {
      // The plugin must be mounted beneath the agent's context: reading
      // `agent.ctx.commands` directly throws "cannot get property commands without
      // inject", and only a registration from inside this plugin belongs to the agent's
      // scope (its fiber goes with the agent).
      shield.fiber = agent.ctx.plugin({
        name: 'ds-bot-command-shield',
        inject: [],
        apply(child) {
          shield.child = child
          shield.commands = child.get?.('commands')
          applying = true
          try { if (shield.commands !== undefined) sync(shield) } finally {
            applying = false
            shield.resolveReady?.()
          }
        },
      })
    } catch (error) {
      shields.delete(sessionId)
      shield.resolveReady?.()
      rt.warn?.('ds-bot: the DSH command shield could not mount for %s: %s', sessionId, error?.message ?? error)
    }
    return shield
  }
  // `agent/created` is serial: wait for the injected plugin to register its shadows, so
  // the first command a fresh chat can send already meets the shield.
  const mountReady = async (agent) => {
    const shield = mount(agent)
    if (shield === undefined) return
    let timer
    await Promise.race([
      shield.ready,
      new Promise((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref?.() }),
    ])
    clearTimeout(timer)
  }
  const unmount = (sessionId) => {
    const shield = shields.get(sessionId)
    if (shield === undefined) return
    shields.delete(sessionId)
    for (const lift of shield.lifts) { try { lift() } catch {} }
    shield.lifts = []
    try { shield.fiber?.dispose?.() } catch {}
  }

  ctx.on('agent/created', ({ agent }) => mountReady(agent))
  ctx.on('agent/disposed', ({ agent }) => { unmount(agent?.session?.id) })
  ctx.on('commands/change', resync)
  const offSaved = rt.onSaved?.(() => resync())
  ctx.effect(() => () => {
    applying = true
    offSaved?.()
    for (const sessionId of [...shields.keys()]) unmount(sessionId)
  }, 'ds-bot: command shield cleanup')
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) void mountReady(agent)
}
