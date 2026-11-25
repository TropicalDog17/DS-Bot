// DSH offers Auto review for the current Session only, so neither a Bot nor a group keeps it.
const SESSION_ONLY = 'auto'

export function install(rt) {
  const { ctx } = rt

  const presets = () => ctx.get?.('permissionPresets')

  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultPreset } = service.catalog()
    return { options: options.filter(option => option.value !== SESSION_ONLY), defaultPreset }
  }

  const roomOfSession = sessionId => rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)

  async function setPreset(sessionId, name) {
    const agent = await rt.resolveAgent(sessionId)
    const wanted = typeof name === 'function' ? name() : name
    if (wanted) presets().set(agent.session, wanted)
    return wanted
  }

  async function applyPermission(bot, sessionId, room = roomOfSession(sessionId)) {
    const name = () => room?.permission ?? bot.permission
    if (presets() === undefined || !name()) return
    return setPreset(sessionId, name)
  }

  function checkPreset(name, whose) {
    const service = presets()
    if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    if (wanted === SESSION_ONLY) throw new Error(`Auto review applies to one Session only and cannot be ${whose} permission`)
    service.resolve(wanted)
    return wanted
  }

  const requests = new Map()

  async function setPermission(bot, name) {
    const wanted = checkPreset(name, 'a Bot\'s')
    const request = requests.get(bot.id) ?? { seq: 0, applied: bot.permission }
    const mine = ++request.seq
    requests.set(bot.id, request)
    bot.permission = wanted
    const applyTo = (sessionId, room = roomOfSession(sessionId)) =>
      setPreset(sessionId, () => (request.seq === mine ? room?.permission ?? bot.permission : undefined))
    const own = () => [rt.chatOf(bot.id), ...(bot.openParts ?? []).map(part => part.sessionId)]
      .filter((sessionId, index, list) => sessionId !== undefined && list.indexOf(sessionId) === index)
    const groups = async (warnFail) => {
      for (const sessionId of rt.groupSessionsOf(bot.id)) {
        if (request.seq !== mine) break
        if (roomOfSession(sessionId)?.permission) continue
        await applyTo(sessionId).catch(warnFail)
      }
    }
    try {
      let applied
      for (const sessionId of own()) {
        if (request.seq !== mine) break
        applied = await applyTo(sessionId)
      }
      if (applied !== undefined) request.applied = applied
    } catch (error) {
      if (request.seq === mine) {
        if (request.applied === undefined) delete bot.permission
        else bot.permission = request.applied
        const fallback = request.applied ?? presets().catalog().defaultPreset
        const warnFail = error => rt.warn('ds-bot: permission for %s not restored: %s', bot.name, error)
        const restoreTo = (sessionId) => setPreset(sessionId, () => (request.seq === mine ? roomOfSession(sessionId)?.permission ?? fallback : undefined))
        for (const sessionId of own()) {
          if (request.seq !== mine) break
          await restoreTo(sessionId).catch(warnFail)
        }
        for (const sessionId of rt.groupSessionsOf(bot.id)) {
          if (request.seq !== mine) break
          if (roomOfSession(sessionId)?.permission) continue
          await restoreTo(sessionId).catch(warnFail)
        }
      }
      throw error
    }
    await groups(error => rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error))
  }

  const cleanRoomPermission = name => (name === null || name === '' ? null : checkPreset(name, 'a group\'s'))

  async function setRoomPermission(room, name) {
    const wanted = cleanRoomPermission(name) ?? undefined
    if (wanted === room.permission) return false
    if (wanted === undefined) delete room.permission
    else room.permission = wanted
    const service = presets()
    if (service === undefined) return true
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      const bot = rt.botOf(botId)
      if (bot === undefined) continue
      await setPreset(sessionId, () => room.permission ?? bot.permission ?? service.catalog().defaultPreset)
        .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', bot.name, room.name, error))
    }
    return true
  }

  Object.assign(rt, { permissionCatalog, applyPermission, setPermission, cleanRoomPermission, setRoomPermission })
}
