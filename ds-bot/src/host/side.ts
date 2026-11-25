import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASIDE_LIMIT } from './constants.ts'
import { EMPTY_ERROR, RESTART_ERROR, TOOL_ERROR, callAside, locatePrivate, snapshotOf } from './btw.ts'
import { replaceFile } from './files.ts'

export const SIDE_MARKER = 'ds-bot/side'

const SIDE_PROMPT = [
  SIDE_MARKER,
  'Answer from the conversation so far, based on progress up to this snapshot, and from this side chat.',
  'Do not call any tool.',
  'If the answer needs information that is not in the conversation, say so.',
  'Never claim to have done anything.',
].join('\n')
const SIDE_RETRY = 'Do not call any tool. Answer in text only.'
const GROUP_REFUSAL = "Side chat is only available in a Bot's private chat."
const BUSY_ERROR = 'Wait for the answer, or cancel it.'
const CHAT_ERROR = 'This side chat is no longer here.'
const ENTRY_ERROR = 'This side question is no longer here.'

const promptFor = (question, retry) => [SIDE_PROMPT, ...(retry ? [SIDE_RETRY] : []), question].join('\n\n')

// Earlier finished pairs sit between the snapshot and the new question. The
// assistant pair carries the route tag a model-produced message needs — the
// assembler reads `source` on every assistant message.
const pairsOf = (chat, entry, route) =>
  (chat.entries ?? []).filter(other => other !== entry && other?.status === 'done')
    .flatMap(other => [
      { role: 'user', content: [{ type: 'text', text: other.question }] },
      { role: 'assistant', content: [{ type: 'text', text: other.answer }], source: { kind: 'model', provider: route?.provider, model: route?.model } },
    ])

const answering = chat => (chat?.entries ?? []).some(entry => entry?.status === 'answering')

export function install(rt) {
  const { ctx, state } = rt
  const flights = new Map()
  const byBot = new Map()
  let disposing = false
  const dropped = new Set()

  const track = (id, botId, controller) => {
    flights.set(id, { botId, controller })
    const ids = byBot.get(botId) ?? new Set()
    ids.add(id)
    byBot.set(botId, ids)
  }
  const untrack = (id) => {
    const flight = flights.get(id)
    if (flight === undefined) return
    flights.delete(id)
    const ids = byBot.get(flight.botId)
    ids?.delete(id)
    if (ids?.size === 0) byBot.delete(flight.botId)
  }

  const sideDir = typeof rt.home === 'string' ? join(rt.home, 'side') : undefined
  const botFile = botId => join(sideDir, `${botId}.json`)
  const writes = () => rt.readOnly?.() === undefined
  const chats = new Map()
  const reading = new Map()
  let writing = Promise.resolve()

  const writeBot = (botId) => {
    const run = writing.then(async () => {
      if (sideDir === undefined || !writes() || dropped.has(botId) || rt.botOf(botId) === undefined) return
      const path = botFile(botId)
      await mkdir(sideDir, { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      try {
        await writeFile(temp, JSON.stringify(chats.get(botId) ?? [], null, 2), 'utf8')
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = run.catch(() => {})
    return run
  }

  const persist = async (botId) => {
    await writeBot(botId).catch(error => rt.warn('ds-bot: side chats of %s not saved: %s', botId, error))
    await rt.save()
  }

  async function readBot(botId) {
    const held = chats.get(botId)
    if (held !== undefined) return held
    const pending = reading.get(botId)
    if (pending !== undefined) return pending
    const job = (async () => {
      let list = []
      if (sideDir !== undefined) {
        try {
          const parsed = JSON.parse(await readFile(botFile(botId), 'utf8'))
          if (Array.isArray(parsed)) list = parsed.filter(chat => chat !== null && typeof chat === 'object' && !Array.isArray(chat))
        } catch (error) {
          if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable side chats %s: %s', botFile(botId), error?.code ?? error)
        }
      }
      for (const chat of list) if (!Array.isArray(chat.entries)) chat.entries = []
      if (writes()) {
        const now = Date.now()
        let touched = false
        for (const chat of list) {
          for (const entry of chat.entries) {
            if (entry?.status !== 'answering' || flights.has(entry.id)) continue
            entry.status = 'failed'
            entry.error = entry.error ?? RESTART_ERROR
            entry.finishedAt = entry.finishedAt ?? now
            touched = true
          }
        }
        chats.set(botId, list)
        if (touched) await writeBot(botId).catch(error => rt.warn('ds-bot: side chats of %s not saved: %s', botId, error))
      } else {
        chats.set(botId, list)
      }
      return chats.get(botId)
    })()
    reading.set(botId, job)
    try {
      return await job
    } finally {
      reading.delete(botId)
    }
  }

  const originalLoad = rt.load?.bind(rt)
  if (typeof originalLoad === 'function') {
    let ready
    rt.load = () => (ready ??= (async () => {
      await originalLoad()
      for (const botId of Object.keys(state.bots)) await readBot(botId)
    })())
  }

  const originalRefresh = rt.refresh?.bind(rt)
  if (typeof originalRefresh === 'function') {
    rt.refresh = async () => {
      const wasWriting = writes()
      await originalRefresh()
      if (wasWriting || !writes()) return
      for (const botId of [...chats.keys()]) {
        chats.delete(botId)
        await readBot(botId)
      }
    }
  }

  const sideView = () => {
    const view = {}
    for (const botId of Object.keys(state.bots)) {
      const list = chats.get(botId) ?? []
      if (list.length > 0) view[botId] = [...list].sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0))
    }
    return view
  }

  const abandoned = botId => disposing || dropped.has(botId) || rt.botOf(botId) === undefined
  const stopError = (botId) => new Error(disposing && !dropped.has(botId) && rt.botOf(botId) !== undefined ? 'DS Bot is stopping.' : 'Unknown Bot')

  async function drain(ids?) {
    const left = () => (ids === undefined ? [...flights.keys()] : ids.filter(id => flights.has(id)))
    for (;;) {
      const idsLeft = left()
      if (idsLeft.length === 0) return
      const waiting = idsLeft.map(id => flights.get(id)?.done).filter(Boolean)
      if (waiting.length > 0) {
        await Promise.allSettled(waiting)
        continue
      }
      await new Promise(resolve => { setTimeout(resolve, 0) })
    }
  }

  function alive(botId, chat, entry) {
    if (disposing || dropped.has(botId)) return false
    if (rt.botOf(botId) === undefined) return false
    const list = chats.get(botId)
    return list !== undefined && list.includes(chat) && (chat.entries ?? []).includes(entry)
  }

  function settle(botId, chat, entry, patch) {
    if (entry.status !== 'answering' || !alive(botId, chat, entry)) return false
    Object.assign(entry, patch, { finishedAt: Date.now() })
    chat.updatedAt = entry.finishedAt
    return true
  }

  async function complete(botId, chat, entry, snapshot, signal) {
    const extra = pairsOf(chat, entry, snapshot.header?.config)
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (signal.aborted || entry.status !== 'answering' || !alive(botId, chat, entry)) return
        const result = await callAside(ctx, rt, snapshot, { extra, question: entry.question, promptFor, kind: 'side', retry: attempt === 1, signal })
        if (signal.aborted || entry.status !== 'answering' || !alive(botId, chat, entry)) return
        if (result.failed !== undefined) {
          if (settle(botId, chat, entry, { status: 'failed', error: result.failed, answer: '' })) await persist(botId)
          return
        }
        if (result.cutOff) {
          const answer = result.text ?? ''
          if (settle(botId, chat, entry, { status: 'failed', error: ASIDE_LIMIT, answer, finish: 'max-tokens' })) await persist(botId)
          return
        }
        if (result.toolCalls) {
          if (attempt === 0) continue
          if (settle(botId, chat, entry, { status: 'failed', error: TOOL_ERROR, answer: '' })) await persist(botId)
          return
        }
        if (result.text === '') {
          if (settle(botId, chat, entry, { status: 'failed', error: EMPTY_ERROR, answer: '' })) await persist(botId)
          return
        }
        if (settle(botId, chat, entry, { status: 'done', answer: result.text })) await persist(botId)
        return
      }
    } catch (error) {
      if (signal.aborted || entry.status !== 'answering' || !alive(botId, chat, entry)) return
      const message = error?.message ?? String(error)
      rt.warn('ds-bot: side for %s failed: %s', botId, message)
      if (settle(botId, chat, entry, { status: 'failed', error: message, answer: '' })) await persist(botId)
    }
  }

  const newChat = botId => ({ id: randomUUID(), botId, createdAt: Date.now(), updatedAt: Date.now(), entries: [] })

  async function sideNew({ sessionId: raw }) {
    const { botId } = locatePrivate(rt, raw, GROUP_REFUSAL)
    const list = await readBot(botId)
    const chat = newChat(botId)
    list.push(chat)
    await persist(botId)
    return { chatId: chat.id }
  }

  async function sideAsk({ sessionId: raw, chatId, recent, text }) {
    const question = typeof text === 'string' ? text : ''
    if (question.trim() === '') throw Object.assign(new Error('Write a question.'), { code: 'bot/invalid' })
    const { sessionId, botId } = locatePrivate(rt, raw, GROUP_REFUSAL)
    const list = await readBot(botId)
    let chat
    if (typeof chatId === 'string' && chatId !== '') {
      chat = list.find(item => item.id === chatId)
      if (chat === undefined) throw new Error(CHAT_ERROR)
      if (answering(chat)) throw new Error(BUSY_ERROR)
    } else if (recent === true) {
      chat = [...list]
        .filter(item => item.entries?.at(-1)?.status !== 'answering')
        .sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0]
    }
    const id = randomUUID()
    const controller = new AbortController()
    track(id, botId, controller)
    let started = false
    let created = false
    try {
      const agent = await rt.resolveAgent(sessionId)
      if (abandoned(botId)) throw stopError(botId)
      const snapshot = snapshotOf(agent.session, ctx.get?.('sessionProjections'))
      const route = snapshot.header?.config
      if (!route?.provider || !route?.model) throw new Error('This Bot has not called a model yet. Send a normal message first.')
      if (chat === undefined) {
        chat = newChat(botId)
        list.push(chat)
        created = true
      }
      if (answering(chat)) throw new Error(BUSY_ERROR)
      const entry = { id, question, answer: '', status: 'answering', createdAt: Date.now() }
      chat.entries.push(entry)
      chat.updatedAt = entry.createdAt
      await persist(botId)
      if (abandoned(botId) || !alive(botId, chat, entry)) {
        if (disposing && !dropped.has(botId) && alive(botId, chat, entry)) return { chatId: chat.id, entryId: id }
        throw new Error('Unknown Bot')
      }
      const done = complete(botId, chat, entry, snapshot, controller.signal).finally(() => untrack(id))
      const flight = flights.get(id)
      if (flight !== undefined) flight.done = done
      started = true
      return { chatId: chat.id, entryId: id }
    } catch (error) {
      if (chat !== undefined && (chat.entries ?? []).some(entry => entry?.id === id)) {
        chat.entries = chat.entries.filter(entry => entry?.id !== id)
        if (created && chat.entries.length === 0) {
          const index = list.indexOf(chat)
          if (index !== -1) list.splice(index, 1)
        }
        await writeBot(botId).catch(() => {})
      }
      throw error
    } finally {
      if (!started) untrack(id)
    }
  }

  async function sideCancel({ chatId, entryId }) {
    for (const [botId, list] of chats) {
      const chat = list.find(item => item?.id === chatId)
      if (chat === undefined) continue
      const entry = (chat.entries ?? []).find(item => item?.id === entryId)
      if (entry === undefined) throw new Error(ENTRY_ERROR)
      if (entry.status !== 'answering') return { answering: false }
      entry.status = 'cancelled'
      entry.finishedAt = Date.now()
      chat.updatedAt = entry.finishedAt
      flights.get(entryId)?.controller.abort()
      await persist(botId)
      return { answering: true }
    }
    throw new Error(CHAT_ERROR)
  }

  async function sideClose({ chatId }) {
    for (const [botId, list] of chats) {
      const index = list.findIndex(item => item?.id === chatId)
      if (index === -1) continue
      const chat = list[index]
      const ids = (chat.entries ?? []).filter(entry => entry?.status === 'answering').map(entry => entry.id)
      for (const id of ids) flights.get(id)?.controller.abort()
      await drain(ids)
      const current = chats.get(botId)
      if (current !== undefined && current.includes(chat)) {
        chats.set(botId, current.filter(item => item !== chat))
        await persist(botId)
      }
      return {}
    }
    return {}
  }

  async function sideDispose() {
    disposing = true
    for (const flight of flights.values()) flight.controller.abort()
    await drain()
    await writing
  }

  async function dropBot(botId) {
    dropped.add(botId)
    chats.delete(botId)
    reading.delete(botId)
    const ids = [...(byBot.get(botId) ?? [])]
    for (const id of ids) flights.get(id)?.controller.abort()
    await drain(ids)
    if (sideDir !== undefined && writes()) await rm(botFile(botId), { force: true }).catch(error => rt.warn('ds-bot: side chats of %s not removed: %s', botId, error))
  }

  if (typeof rt.deleteBot === 'function') {
    const originalDelete = rt.deleteBot.bind(rt)
    rt.deleteBot = async (id) => {
      if (rt.botOf(id) !== undefined && !rt.isMain(id)) await dropBot(id)
      return originalDelete(id)
    }
  }

  const sideJoin = id => flights.get(id)?.done ?? Promise.resolve()

  Object.assign(rt, { sideNew, sideAsk, sideCancel, sideClose, sideJoin, sideDispose, sideView })
}
