export function createSource(initial) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved === value) return
      value = resolved
      for (const listener of [...listeners]) listener()
    },
  }
}

export const EMPTY_ROSTER = { revision: -1, mainBotId: null, mainBotIds: [], bots: [], rooms: [], agents: [], sections: [], exchangeTurns: {}, questions: {}, btwCards: {}, sideChats: {}, learning: {}, secrets: [], capabilities: [], capabilityStatuses: {}, phone: null, secretRequests: {}, models: [], defaultModel: null, modelsKey: null, prefs: {}, byId: {}, roomsById: {}, agentsById: {}, agentOf: {}, ready: false }
export const isMainOf = (roster, id) => id !== undefined && (roster.mainBotIds ?? []).includes(id)

export function indexRoster(value) {
  const byId = {}
  for (const bot of value.bots) {
    const open = (bot.openParts ?? []).flatMap(part => [part.sessionId, ...(part.parts ?? [])])
    for (const id of [...(bot.parts ?? []), ...open, bot.sessionId ?? bot.id, bot.id]) byId[id] = bot
  }
  const roomsById = {}
  for (const room of value.rooms) {
    for (const id of [room.id, room.sessionId, ...(room.ownParts ?? [])]) roomsById[id] = room
  }
  const agentsById = {}
  const agentOf = {}
  for (const agent of value.agents ?? []) {
    agentsById[agent.id] = agent
    for (const sessionId of agent.sessions ?? []) agentOf[sessionId] = agent.id
  }
  return { ...value, agents: value.agents ?? [], sections: value.sections ?? [], byId, roomsById, agentsById, agentOf, ready: true }
}

export function isAgentSession(roster, cache, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return false
  if (roster.ready) return roster.agentOf[sessionId] !== undefined
  return cache.has(sessionId)
}

export const heldCardKey = (kind, requestId) => JSON.stringify([kind, requestId])

export function countCards(state, sessionId, callIds, delta) {
  const own = { ...state[sessionId] }
  for (const callId of callIds) {
    const count = (own[callId] ?? 0) + delta
    if (count > 0) own[callId] = count
    else delete own[callId]
  }
  return { ...state, [sessionId]: own }
}
