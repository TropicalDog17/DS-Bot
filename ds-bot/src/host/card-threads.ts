import * as threadStore from './threads.ts'

export function createCardThreads({ rt, threads = threadStore, freshRoute, selectRoute }) {
  async function open(botId, cardId, title = '', roomId, mayOpen = () => true) {
    await rt.load()
    const bot = rt.botOf(botId)
    if (bot === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    if (!mayOpen()) return undefined
    const known = threads.cardThreadSession(bot, cardId)
    if (known !== undefined) return known
    const agent = await rt.resolveAgent(rt.chatOf(botId))
    const picked = await freshRoute(bot, agent.session)
    const freshId = await rt.createSession(title === '' ? bot.name : `${bot.name} · ${title}`.slice(0, 120), { dir: rt.workDirOf({ botId }) })
    if (picked !== undefined) await selectRoute({ name: bot.name }, freshId, picked)
    await rt.applyPermission(bot, freshId, undefined)
      .catch(error => rt.warn('ds-bot: permission for a card thread of %s not applied: %s', bot.name, error))
    const raced = rt.botOf(botId) === bot ? threads.cardThreadSession(bot, cardId) : undefined
    if (rt.botOf(botId) !== bot || raced !== undefined || !mayOpen()) {
      await rt.ctx.workspaceRegistry.archiveSession(freshId, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused card thread of %s not archived: %s', bot.name, error))
      if (rt.botOf(botId) !== bot) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
      return mayOpen() ? raced : undefined
    }
    threads.addCardThread(bot, freshId, cardId, undefined, roomId)
    rt.chatOwners.set(freshId, bot.id)
    await rt.save()
    return freshId
  }

  async function close(botId, cardId, sessionId?) {
    await rt.load()
    const bot = rt.botOf(botId)
    if (bot === undefined) return false
    const target = sessionId ?? threads.cardThreadSession(bot, cardId) ?? threads.closingCardThreadSession(bot, cardId)
    if (target === undefined) return false
    if (rt.live.get(target)?.turn !== undefined) {
      if (threads.currentSession(bot) === target) {
        if (bot.currentCardClosing !== true) {
          bot.currentCardClosing = true
          await rt.save()
        }
      } else {
        const part = (bot.openParts ?? []).find(entry => entry.sessionId === target)
        if (part !== undefined && part.closing !== true) {
          part.closing = true
          await rt.save()
        }
      }
      return 'later'
    }
    const closed = threads.closeCardThread(bot, cardId, Date.now(), target)
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

  function turnEnded() {
    const finish = (botId, cardId, sessionId) => {
      void close(botId, cardId, sessionId).catch(error => rt.warn('ds-bot: closing a card thread failed: %s', error))
    }
    for (const bot of Object.values(rt.state.bots) as any[]) {
      if (bot.currentCardClosing === true && rt.live.get(threads.currentSession(bot))?.turn === undefined) finish(bot.id, bot.currentCard, threads.currentSession(bot))
      for (const part of (bot.openParts ?? []).slice()) {
        if (part.closing !== true || rt.live.get(part.sessionId)?.turn !== undefined) continue
        finish(bot.id, part.card, part.sessionId)
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
  function isClosed(botId, cardId) {
    const bot = rt.botOf(botId)
    if (bot === undefined) return true
    if (threads.cardThreadSession(bot, cardId) !== undefined) return false
    if (threads.closingCardThreadSession(bot, cardId) !== undefined) return false
    return bot.closedCards?.some(entry => entry.card === cardId) === true
  }

  return { open, ofSession, sessionOf, roomOfSession, isClosed, close, turnEnded }
}
