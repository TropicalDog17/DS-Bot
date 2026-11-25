import * as threadStore from './threads.js'

export function createCardThreads({ rt, threads = threadStore, freshRoute, selectRoute }) {
  // A card thread: a conversation of the Bot's own for one card's work, beside its chat
  // (threads.js). Opening one for a card that has it already returns that one.
  async function open(botId, cardId, title = '', roomId) {
    await rt.load()
    const bot = rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    const known = threads.cardThreadSession(bot, cardId)
    if (known !== undefined) return known
    const agent = await rt.resolveAgent(rt.chatOf(botId))
    const picked = await freshRoute(bot, agent.session)
    const freshId = await rt.createSession(title === '' ? bot.name : `${bot.name} · ${title}`.slice(0, 120), { dir: rt.workDirOf({ botId }) })
    if (picked !== undefined) await selectRoute({ name: bot.name }, freshId, picked)
    await rt.applyPermission(bot, freshId, undefined)
      .catch(error => rt.warn('ds-bot: permission for a card thread of %s not applied: %s', bot.name, error))
    // The Bot went away, or another call opened the card's thread meanwhile.
    const raced = rt.botOf(botId) === bot ? threads.cardThreadSession(bot, cardId) : undefined
    if (rt.botOf(botId) !== bot || raced !== undefined) {
      await rt.ctx.workspaceRegistry.archiveSession(freshId, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused card thread of %s not archived: %s', bot.name, error))
      if (raced !== undefined) return raced
      throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    }
    threads.addCardThread(bot, freshId, cardId, undefined, roomId)
    rt.chatOwners.set(freshId, bot.id)
    await rt.save()
    return freshId
  }

  // A finished card closes its thread. A thread whose turn still runs (the Bot finishing
  // the card from inside it, most often) is marked and closes when that turn ends, so
  // the turn is never cut off; the mark is saved, so a restart closes it too.
  async function close(botId, cardId) {
    await rt.load()
    const bot = rt.botOf(botId)
    const sessionId = threads.cardThreadSession(bot, cardId)
    if (sessionId === undefined) return false
    if (rt.live.get(sessionId)?.turn !== undefined) {
      const part = (bot.openParts ?? []).find(entry => entry.card === cardId)
      if (part === undefined ? bot.currentCardClosing !== true : part.closing !== true) {
        if (part === undefined) bot.currentCardClosing = true
        else part.closing = true
        await rt.save()
      }
      return 'later'
    }
    const closed = threads.closeCardThread(bot, cardId)
    if (closed !== undefined) {
      rt.chatOwners.delete(closed.sessionId)
      rt.pastOwners.set(closed.sessionId, { botId: bot.id })
    }
    await rt.save()
    if (closed !== undefined) {
      await rt.ctx.workspaceRegistry.archiveSession(closed.sessionId, { stopActivity: false })
        .catch(error => rt.warn('ds-bot: closed card thread of %s not archived: %s', bot.name, error))
    }
    return true
  }

  // turns.js calls this when a turn ends: a card thread marked to close closes now.
  // Every marked one is tried, so one left from before a restart closes as well.
  function turnEnded() {
    const finish = (botId, cardId) => {
      void close(botId, cardId).catch(error => rt.warn('ds-bot: closing a card thread failed: %s', error))
    }
    for (const bot of Object.values(rt.state.bots)) {
      if (bot.currentCardClosing === true && rt.live.get(threads.currentSession(bot))?.turn === undefined) finish(bot.id, bot.currentCard)
      for (const part of (bot.openParts ?? []).slice()) {
        if (part.closing !== true || rt.live.get(part.sessionId)?.turn !== undefined) continue
        finish(bot.id, part.card)
      }
    }
  }
  const sessionOf = (botId, cardId) => threads.cardThreadSession(rt.botOf(botId), cardId)
  function ofSession(sessionId) {
    const botId = rt.chatOwners.get(sessionId)
    const cardId = threads.cardOfThread(rt.botOf(botId), sessionId)
    return cardId === undefined ? undefined : { botId, cardId }
  }
  const roomOfSession = sessionId => threads.cardRoomOfThread(rt.botOf(rt.chatOwners.get(sessionId)), sessionId)

  return { open, ofSession, sessionOf, roomOfSession, close, turnEnded }
}
