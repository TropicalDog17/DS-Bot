import { openSessions } from './threads.ts'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX, SECTION_COLORS, SECTION_NAME_MAX } from './constants.ts'
import { currentColor, isColor, normalize, unquote } from './text.ts'
import { nameProblem } from '../shared/mentions.ts'

const BROWSER_GRANT_KINDS = new Set(['post', 'upload', 'download', 'delete', '*'])
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/

const OWN_RULES = 'Where your instructions say otherwise, follow them.'
const writeIn = language => `Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`
const AFTER_USER = 'You were just set up as the user\'s Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team.'

function cleanBrowserGrants(input) {
  if (input === null) return null
  if (!Array.isArray(input) || input.length > 50) throw new Error('Browser grants must be an array of at most 50 entries')
  const grants = []
  const seen = new Set()
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each browser grant must have a site and kinds')
    }
    const until = entry.until
    if (until !== undefined) {
      if (typeof until !== 'number' || !Number.isFinite(until)) {
        throw new Error('Browser grant until must be a future epoch-millisecond timestamp')
      }
      if (until <= Date.now()) continue
    }
    const site = typeof entry.site === 'string' ? entry.site.trim().toLowerCase() : ''
    if (site !== '*' && !HOSTNAME.test(site)) throw new Error('Browser grant site must be * or a hostname')
    if (!Array.isArray(entry.kinds) || entry.kinds.length === 0
      || entry.kinds.some(kind => typeof kind !== 'string' || !BROWSER_GRANT_KINDS.has(kind))) {
      throw new Error('Browser grant kinds must be a non-empty subset of post, upload, download, delete, *')
    }
    const kinds = [...new Set(entry.kinds)].sort()
    const key = `${site}\0${kinds.join('\0')}\0${until ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    grants.push({ site, kinds, ...(until !== undefined ? { until } : {}) })
  }
  return grants
}

export function install(rt) {
  const { ctx, defaults, state } = rt

  let bootstrapping = null

  async function keepTeamFolder() {
    const team = rt.teamFolder()
    if (team !== undefined) await mkdir(team, { recursive: true }).catch(error => rt.warn('ds-bot: team folder %s not made again: %s', team, error))
    return team
  }

  async function ensureWorkspace() {
    if (state.workspaceId && ctx.workspaceRegistry.get(state.workspaceId)) {
      await keepTeamFolder()
      return state.workspaceId
    }
    const path = rt.defaultTeamFolder()
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'DS Bot')
    state.workspaceId = workspace.id
    await rt.save()
    return workspace.id
  }

  // Under the PTC preset (DSH Desktop's default) a model may call only run_code, which
  // turns down the group_relay call that a group chat's Session is given. A Session
  // keeps the preset it is made with.
  async function botPreset() {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined) return {}
    const standard = (await presets.list()).some(preset => preset.id === 'standard' && preset.broken === undefined)
    return standard ? { agentPreset: 'standard' } : {}
  }

  // `dir` is a working folder outside the team workspace. Such a Session is made by cwd
  // alone, so it joins no DSH workspace and the user's own project lists stay as they are —
  // unless the folder is already registered as a workspace, which it then joins (#710).
  async function createSession(title, { dir }: { dir?: any } = {}) {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const usable = dir !== undefined && await rt.isFolder(dir)
    if (dir !== undefined && !usable) rt.warn('ds-bot: the working folder %s is gone; %s starts in the team workspace', dir, title)
    const known = usable ? await ctx.workspaceRegistry.resolveByPath(dir) : undefined
    const place = known !== undefined ? { workspaceId: known.id } : usable ? { cwd: dir } : { workspaceId: await ensureWorkspace() }
    const { sessionId } = await ctx.sessionController.create({ ...place, ...await botPreset() })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, title)
    return sessionId
  }

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar: Record<string, any> = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Avatar images must be PNG, JPEG, WebP, GIF, or SVG')
      if (input.image.length > MAX_AVATAR_IMAGE) throw new Error('Avatar image is too large')
      avatar.image = input.image
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

  const held = { bot: new Set(), room: new Set() }
  const deleting = new Set()
  const liveBot = id => (deleting.has(id) ? undefined : rt.botOf(id))
  const isHeld = (kind, name) => held[kind].has(normalize(name))
  async function holdName(kind, name, work) {
    const key = normalize(name)
    if (key === '') return work()
    held[kind].add(key)
    try {
      return await work()
    } finally {
      held[kind].delete(key)
    }
  }
  const botNameTaken = name => rt.findBot(name) !== undefined || isHeld('bot', name)

  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!botNameTaken(stem)) return stem
    let index = 2
    while (botNameTaken(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  function cleanSectionName(text, selfId?) {
    const next = unquote(text).replace(/\s+/g, ' ').slice(0, SECTION_NAME_MAX)
    if (next === '') throw new Error('Enter a section name')
    if ((state.sections ?? []).some(sec => sec.id !== selfId && normalize(sec.name) === normalize(next))) {
      throw new Error(`Another section is already called "${next}"`)
    }
    return next
  }

  function freshSectionName(base = 'New section') {
    const stem = unquote(base).replace(/\s+/g, ' ').slice(0, SECTION_NAME_MAX - 4) || 'New section'
    const taken = name => (state.sections ?? []).some(sec => normalize(sec.name) === normalize(name))
    if (!taken(stem)) return stem
    let index = 2
    while (taken(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  function resolveSectionInput({ section, sectionId }, { allowCreate = true } = {}) {
    if (section === undefined && sectionId === undefined) return undefined
    const raw = section !== undefined ? section : sectionId
    if (raw === null || raw === '' || /^(none|null|无|未分组)$/i.test(String(raw).trim())) return null
    const list = (state.sections ??= [])
    const byId = list.find(sec => sec.id === raw)
    if (byId !== undefined) return byId.id
    if (section === undefined) throw new Error('Unknown section')
    const byName = list.find(sec => normalize(sec.name) === normalize(raw))
    if (byName !== undefined) return byName.id
    const clean = cleanSectionName(raw)
    if (!allowCreate) return clean
    const created = { id: `sec-${randomUUID().slice(0, 8)}`, name: clean }
    list.push(created)
    return created.id
  }

  async function createBot(options) {
    const cleanName = String(options.name ?? '').trim().slice(0, 40)
    const problem = nameProblem(cleanName)
    if (problem !== undefined) throw new Error(problem)
    if (botNameTaken(cleanName)) throw new Error(`A Bot named ${cleanName} already exists`)
    return holdName('bot', cleanName, () => buildBot(cleanName, options))
  }

  async function buildBot(cleanName, { role = '', instructions = '', color, brief = '', createdBy, main = false, avatar, model, effort, workDir, copyOf, pickModel = false, section, sectionId }) {
    const cleanAvatarValue = cleanAvatar(avatar)
    const modelRef = model ? await rt.resolveModel(model) : pickModel ? undefined : await rt.defaultBotModel()
    if (effort && modelRef === undefined) throw new Error('Pick a model before choosing a thinking level')
    const effortId = modelRef === undefined ? undefined
      : effort === null || effort === '' ? undefined
      : (await rt.resolveEffort(modelRef, effort)) ?? await rt.defaultEffort(modelRef)
    const dir = workDir === undefined || workDir === null ? undefined : await rt.cleanWorkDir(workDir)
    const clash = dir === undefined ? undefined : await rt.privateClash(dir)
    if (clash) throw new Error(`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${cleanName} cannot work there`)
    if (!main && (section !== undefined || sectionId !== undefined)) resolveSectionInput({ section, sectionId }, { allowCreate: false })
    const id = await createSession(cleanName, { dir })
    try {
      const resolvedSecId = !main ? resolveSectionInput({ section, sectionId }) : undefined
      state.bots[id] = {
        id,
        name: cleanName,
        role: String(role).trim().slice(0, 24),
        ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
        ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        ...(effortId ? { effort: effortId } : {}),
        ...(dir ? { workDir: dir } : {}),
        ...(resolvedSecId ? { sectionId: resolvedSecId } : {}),
        instructions: String(instructions).trim(),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
        capabilities: [],
      }
      if (main) state.mainBotIds = [id]
      const creator = rt.botOf(createdBy)
      const original = rt.botOf(copyOf)
      const language = rt.uiLanguage?.()
      const kickoff = main
        ? `You were just set up as the user's Main Bot. Greet the user in one or two short messages: say you will run their Bot team and that they can come to you for anything that needs a decision. Then ask in one short question what they want the team to help with first. ${writeIn(language)}`
        : original
          ? `The user just made you as a copy of ${original.name}: same job, fresh memory. Greet the user in one short message, then ask in one short question what this copy should focus on.`
          : creator
            ? `${creator.name} just created you for the user.${brief ? ` Why you exist: ${brief}` : ''}\nGreet the user in one short message, then ask in one short question where to start. Keep it brief.`
            : brief
              ? `The user just created you and sent this first message:\n\n${brief}\n\nIntroduce yourself in one short line, then help with it.`
              : 'The user just created you. Greet the user in one short message, then ask in one short question what you should focus on.'
      const opener = `${kickoff}\n${OWN_RULES}`
      const text = !main && language ? `${opener}\nWrite in ${language}.` : opener
      const bot = state.bots[id]
      const greeting = { text, from: createdBy ?? null, ...(main ? { main: true } : {}) }
      const scopeTools = () => rt.resolveAgent(id)
        .catch(error => rt.warn('ds-bot: scoped tools for %s not applied: %s', cleanName, error))
      if (modelRef === undefined) {
        bot.kickoff = greeting
        await rt.save()
        await scopeTools()
        return bot
      }
      await rt.save()
      await scopeTools()
      void rt.waitForModel(bot)
        .then(() => rt.applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', cleanName, error)))
        .then(() => sendKickoff(bot, greeting))
      return bot
    } catch (error) {
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(other => other !== id)
      rt.chatOwners.delete(id)
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', cleanName, archiveError))
      throw error
    }
  }

  const sentKickoffs = new Map()
  function sendKickoff(bot, greeting) {
    if (rt.hostClosing?.() === true) return
    sentKickoffs.set(bot.id, greeting)
    const text = greeting.afterUser ? `${AFTER_USER} ${writeIn(rt.uiLanguage?.())}\n${OWN_RULES}` : greeting.text
    void rt.dispatch.sendNotice({ fromId: greeting.from ?? undefined, toId: bot.id, text, role: 'kickoff' })
      .catch(error => rt.warn('ds-bot: kickoff failed: %s', error))
  }

  const releasing = new Set()
  async function releaseKickoff(bot) {
    const greeting = bot.kickoff
    if (greeting === undefined || !bot.model) return false
    delete bot.kickoff
    releasing.add(bot.id)
    await rt.save().catch((error) => { releasing.delete(bot.id); throw error })
    const send = () => { releasing.delete(bot.id); sendKickoff(bot, greeting) }
    void rt.waitForModel(bot).then(send, send)
    return true
  }

  const greetingOut = botId => releasing.has(botId)
    || (rt.unreadOf?.(rt.chatOf(botId)) ?? []).some(args => args.role === 'kickoff')

  function holdKickoffAgain(botId) {
    const bot = rt.botOf(botId)
    const greeting = sentKickoffs.get(botId)
    sentKickoffs.delete(botId)
    if (bot === undefined || greeting === undefined || bot.kickoff !== undefined) return
    if (greeting.main && !rt.isMain(botId)) return
    bot.kickoff = greeting
    void rt.save().catch(() => {})
  }

  function userWrote(botId) {
    const bot = rt.botOf(botId)
    const greeting = bot?.kickoff
    if (greeting === undefined || greeting.afterUser) return
    if (greeting.main && (bot.blocked !== undefined || !rt.isUsable(bot.model))) greeting.afterUser = true
    else delete bot.kickoff
    void rt.save().catch(() => {})
  }

  function userAnswered(botId) {
    const bot = rt.botOf(botId)
    if (bot?.kickoff?.afterUser !== true) return
    delete bot.kickoff
    void rt.save().catch(() => {})
  }

  async function duplicateBot(id) {
    const bot = liveBot(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (bot.private === true) throw new Error(`${bot.name} is private, so it cannot be copied`)
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    const workDir = bot.workDir !== undefined && await rt.isFolder(bot.workDir) ? bot.workDir : undefined
    return createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      effort: served ? (bot.effort ?? null) : undefined,
      workDir,
      sectionId: bot.sectionId,
      copyOf: bot.id,
    })
  }

  async function updateBot(id, patch, actorId, fromSessionId) {
    const bot = liveBot(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (patch.browserGrants !== undefined && actorId !== undefined) {
      throw new Error(`Only the user can set what ${bot.name} may do in the browser`)
    }
    if (patch.private !== undefined && actorId !== undefined) {
      throw new Error(`Only the user can make ${bot.name} private or open`)
    }
    if ((patch.section !== undefined || patch.sectionId !== undefined) && actorId !== undefined && !rt.isMain(actorId)) {
      throw new Error(`Only the user or a Main Bot can move ${bot.name} between sidebar sections`)
    }
    if (patch.section !== undefined || patch.sectionId !== undefined) {
      resolveSectionInput({ section: patch.section, sectionId: patch.sectionId }, { allowCreate: false })
    }
    const browserGrants = patch.browserGrants === undefined ? undefined : cleanBrowserGrants(patch.browserGrants)
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    const flag = patch.private === undefined ? undefined : patch.private === true
    await rt.checkPrivacyChange(bot, { flag, moving, workDir })
    const modelRef = patch.model === undefined ? undefined
      : patch.model === null || patch.model === '' ? null
      : await rt.resolveModel(patch.model)
    const engineBefore = rt.engineOf === undefined ? undefined : rt.engineOfBot(bot) ?? 'model'
    if (modelRef === null && engineBefore !== undefined && engineBefore !== 'model') throw new Error(`${bot.name} runs on a local agent and keeps a model of it`)
    const engineChanged = !!modelRef && engineBefore !== undefined && rt.engineOf(modelRef) !== engineBefore
    if (engineChanged && actorId !== undefined) throw new Error(`Only the user can change what ${bot.name} runs on, in the Bot's settings`)
    if (engineChanged && patch.changeEngine !== true) throw new Error(`Changing what ${bot.name} runs on needs a confirmation in the Bot's settings`)
    const effortRef = modelRef === undefined ? bot.model ?? bot.appliedModel : modelRef ?? bot.appliedModel
    let effortId
    if (patch.effort !== undefined) {
      if (patch.effort === null || patch.effort === '') effortId = null
      else {
        if (effortRef === undefined) throw new Error('Pick a model before choosing a thinking level')
        effortId = await rt.resolveEffort(effortRef, patch.effort)
      }
    }
    if (!liveBot(id)) throw new Error('Unknown Bot')
    if (patch.name !== undefined) {
      const next = String(patch.name).trim().slice(0, 40)
      const clash = rt.findBot(next)
      const pending = isHeld('bot', next) && normalize(next) !== normalize(bot.name)
      if (next === '' || (clash && clash.id !== id) || pending) throw new Error(`Name ${next} is not available`)
      const problem = next === bot.name ? undefined : nameProblem(next)
      if (problem !== undefined) throw new Error(problem)
      bot.name = next
      const agent = await rt.resolveAgent(rt.chatOf(id))
      await ctx.sessionTitle.rename(agent.session, next)
      await followMemberNames((Object.values(state.rooms) as any[]).filter(room => room.members.includes(id)))
    }
    const roleBefore = bot.role
    const instructionsBefore = bot.instructions
    if (patch.role !== undefined) bot.role = String(patch.role).trim().slice(0, 24)
    if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim()
    let modelChanged = false
    if (patch.color !== undefined) {
      if (patch.color === null) delete bot.color
      else if (isColor(currentColor(patch.color))) bot.color = currentColor(patch.color)
    }
    if (patch.avatar !== undefined) {
      const avatar = cleanAvatar(patch.avatar)
      if (avatar) bot.avatar = avatar
      else delete bot.avatar
    }
    if (patch.model !== undefined) {
      if ((modelRef ?? undefined) !== bot.model) delete bot.blocked
      if (modelRef === null) delete bot.model
      else bot.model = modelRef
      modelChanged = true
    }
    if (patch.effort !== undefined) {
      if (effortId === null) delete bot.effort
      else bot.effort = effortId
      modelChanged = true
    }
    if (patch.permission !== undefined) await rt.setPermission(bot, patch.permission)
    if (browserGrants !== undefined) {
      if (browserGrants === null) delete bot.browserGrants
      else bot.browserGrants = browserGrants
    }
    if (flag === true) bot.private = true
    else if (flag === false) delete bot.private
    if (patch.section !== undefined || patch.sectionId !== undefined) {
      const nextSecId = id === state.mainBotIds[0] ? null : resolveSectionInput({ section: patch.section, sectionId: patch.sectionId })
      if (nextSecId === null || nextSecId === undefined) delete bot.sectionId
      else bot.sectionId = nextSecId
    }
    const moved = moving && workDir !== bot.workDir
    if (moving) {
      if (workDir === undefined) delete bot.workDir
      else bot.workDir = workDir
    }
    await rt.save()
    const notes = []
    if (bot.role !== roleBefore) notes.push(`Your role is now "${bot.role || '(none)'}"`)
    if (bot.instructions !== instructionsBefore) notes.push(`Your instructions now read:\n${bot.instructions || '(none)'}`)
    const selfEditInChat = actorId === bot.id && fromSessionId === rt.chatOf(bot.id)
    if (notes.length > 0 && bot.kickoff === undefined && !selfEditInChat) {
      void rt.dispatch.sendNotice({ toId: bot.id, text: notes.join('\n'), role: 'update' })
        .catch(error => rt.warn('ds-bot: profile update for %s not delivered: %s', bot.name, error?.message ?? error))
    }
    if (modelChanged) await rt.applyModel(bot, { force: true })
    if (engineChanged) void rt.followEngine(bot.id)
    if (moved) void rt.followFolder({ botId: bot.id })
    if (modelChanged && bot.blocked === undefined) await releaseKickoff(bot)
    return bot
  }

  async function setFlags(id, { pinned, hidden, sectionId }) {
    const entry = rt.botOf(id) ?? rt.roomOf(id) ?? rt.own(state.agents, id)
    if (entry === undefined) throw new Error('Unknown conversation')
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    if (sectionId !== undefined) {
      if (sectionId === null || sectionId === '' || id === state.mainBotIds[0]) delete entry.sectionId
      else if (typeof sectionId === 'string' && (state.sections ?? []).some(sec => sec.id === sectionId)) entry.sectionId = sectionId
      else throw new Error('Unknown section')
    }
    await rt.save()
    return entry
  }

  async function saveSection({ id, name, collapsed, color, items, add, remove }: Record<string, any> = {}) {
    if (color !== undefined && color !== null && color !== '' && !SECTION_COLORS.includes(color)) {
      throw new Error('Unknown section color')
    }
    const list = (state.sections ??= [])
    let sec
    if (id !== undefined && id !== null && id !== '') {
      sec = list.find(entry => entry.id === id)
      if (sec === undefined) throw new Error('Unknown section')
      if (name !== undefined) sec.name = cleanSectionName(name, sec.id)
      if (typeof collapsed === 'boolean') {
        if (collapsed) sec.collapsed = true
        else delete sec.collapsed
      }
      if (color !== undefined) {
        if (color === null || color === '') delete sec.color
        else sec.color = color
      }
    } else {
      const clean = name !== undefined && String(name).trim() !== '' ? cleanSectionName(name) : freshSectionName()
      sec = {
        id: `sec-${randomUUID().slice(0, 8)}`,
        name: clean,
        ...(collapsed === true ? { collapsed: true } : {}),
        ...(SECTION_COLORS.includes(color) ? { color } : {}),
      }
      list.push(sec)
    }
    const entryOf = entryId => (entryId === state.mainBotIds[0] ? undefined : rt.botOf(entryId) ?? rt.roomOf(entryId) ?? rt.own(state.agents, entryId))
    if (Array.isArray(items)) {
      const keep = new Set(items)
      for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms), ...Object.values(state.agents)] as any[]) {
        if (entry.sectionId === sec.id && !keep.has(entry.id)) delete entry.sectionId
      }
      for (const itemId of keep) {
        const entry = entryOf(itemId)
        if (entry !== undefined) entry.sectionId = sec.id
      }
    }
    for (const itemId of add ?? []) {
      const entry = entryOf(itemId)
      if (entry !== undefined) entry.sectionId = sec.id
    }
    for (const itemId of remove ?? []) {
      const entry = entryOf(itemId)
      if (entry !== undefined && entry.sectionId === sec.id) delete entry.sectionId
    }
    await rt.save()
    return sec
  }

  async function reorderSections(ids) {
    if (!Array.isArray(ids)) throw new Error('Section order must be an array of section ids')
    const list = (state.sections ??= [])
    const byId = new Map(list.map(sec => [sec.id, sec]))
    const next = []
    for (const id of ids) {
      const sec = byId.get(id)
      if (sec !== undefined) {
        next.push(sec)
        byId.delete(id)
      }
    }
    for (const sec of byId.values()) next.push(sec)
    state.sections = next
    await rt.save()
    return state.sections
  }

  async function deleteSection(id) {
    const list = (state.sections ??= [])
    if (!list.some(sec => sec.id === id)) throw new Error('Unknown section')
    state.sections = list.filter(sec => sec.id !== id)
    for (const entry of [...Object.values(state.bots), ...Object.values(state.rooms), ...Object.values(state.agents)] as any[]) {
      if (entry.sectionId === id) delete entry.sectionId
    }
    await rt.save()
  }

  const roomBusy = id => [...rt.roomProgress.values()].some(round => round.roomId === id)
  const autoRoomName = members => ['You', ...members.map(id => rt.botOf(id)?.name).filter(Boolean)].join(', ')
  const cleanNotice = (text) => {
    const notice = String(text ?? '').trim()
    if (notice.length > ROOM_NOTICE_MAX) throw new Error(`A group's notice can hold at most ${ROOM_NOTICE_MAX} characters; this one has ${notice.length}`)
    return notice
  }

  function cleanRoomName(text, selfId?) {
    const next = unquote(text).replace(/\s+/g, ' ').slice(0, ROOM_NAME_MAX)
    if (next !== '' && (rt.findRooms(next).some(room => room.id !== selfId) || isHeld('room', next))) throw new Error(`Another group chat is already called "${next}"`)
    return next
  }

  async function retitleRoom(room) {
    try {
      const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
      await ctx.sessionTitle.rename(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: group title for %s not updated: %s', room.name, error)
    }
  }

  async function followMemberNames(rooms: any[] = Object.values(state.rooms)) {
    for (const room of rooms) {
      if (room.named) continue
      const next = autoRoomName(room.members)
      if (next === room.name) continue
      room.name = next
      await retitleRoom(room)
    }
  }

  function checkMembers(members) {
    if (members.length < 2) throw new Error('A group chat needs at least two Bots')
    if (members.length > ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`)
    rt.checkNoPrivate(members)
  }

  const defaultAdmin = (members, createdBy) => (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)

  async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy, section, sectionId }: Record<string, any> = {}) {
    const members = [...new Set(memberIds)].filter(id => liveBot(id))
    checkMembers(members)
    const custom = cleanRoomName(roomName ?? '')
    const adminId = admin !== undefined ? admin : defaultAdmin(members, createdBy)
    if (adminId !== null && !members.includes(adminId)) throw new Error('The admin must be a member of the group')
    if (mode !== undefined && !ROOM_MODES.includes(mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    if (section !== undefined || sectionId !== undefined) resolveSectionInput({ section, sectionId }, { allowCreate: false })
    return holdName('room', custom, () => buildRoom({ members, custom, notice, mode, adminId, createdBy, section, sectionId }))
  }

  async function buildRoom({ members, custom, notice, mode, adminId, createdBy, section, sectionId }) {
    const title = custom || autoRoomName(members)
    const id = await createSession(title)
    try {
      const live = members.filter(member => liveBot(member))
      checkMembers(live)
      const lead = adminId === null || live.includes(adminId) ? adminId : defaultAdmin(live, createdBy)
      const name = custom || autoRoomName(live)
      const resolvedSecId = resolveSectionInput({ section, sectionId })
      const room = {
        id,
        name,
        ...(custom ? { named: true } : {}),
        ...(resolvedSecId ? { sectionId: resolvedSecId } : {}),
        members: live,
        admin: lead,
        mode: mode ?? 'admin',
        notice: cleanNotice(notice),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
      }
      state.rooms[id] = room
      await rt.save()
      // A new Session starts on DSH's default, which may be a model no longer served.
      await rt.selectRoomSession(id)
      await rt.resolveAgent(id)
      if (name !== title) await retitleRoom(room)
      return room
    } catch (error) {
      delete state.rooms[id]
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', title, archiveError))
      throw error
    }
  }

  function planRoomChange(room, patch, actorId) {
    const byMain = actorId === undefined || rt.isMain(actorId)
    const byAdmin = !byMain && rt.isAdminOf(room, actorId)
    if (!byMain && !byAdmin) throw new Error(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`)
    let members = Array.isArray(patch.members) ? [...new Set(patch.members)] : [...room.members]
    for (const member of patch.add ?? []) if (!members.includes(member)) members.push(member)
    members = members.filter(member => !(patch.remove ?? []).includes(member) && liveBot(member))
    const current = room.members.filter(member => liveBot(member))
    if (members.length !== current.length || members.some(member => !current.includes(member))) checkMembers(members)
    let admin = room.admin ?? null
    if (patch.admin !== undefined) {
      admin = patch.admin || null
      if (admin === null && byAdmin) throw new Error('Hand the admin role to another member instead of leaving the group without one')
      if (admin !== null && !members.includes(admin)) throw new Error(`${rt.botOf(admin)?.name ?? 'That Bot'} must be a member to be the admin`)
    }
    if (admin !== null && !members.includes(admin)) {
      if (byAdmin && admin === actorId) throw new Error('Hand the admin role to another member before leaving the group')
      admin = null
    }
    if (patch.mode !== undefined && !ROOM_MODES.includes(patch.mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)
    if (patch.workDir !== undefined && byAdmin) throw new Error(`Only the user or a Main Bot can set the folder of "${room.name}"`)
    if ((patch.section !== undefined || patch.sectionId !== undefined) && byAdmin) {
      throw new Error(`Only the user or a Main Bot can move "${room.name}" between sidebar sections`)
    }
    if (patch.section !== undefined || patch.sectionId !== undefined) {
      resolveSectionInput({ section: patch.section, sectionId: patch.sectionId }, { allowCreate: false })
    }
    if (patch.permission !== undefined && actorId !== undefined) throw new Error(`Only the user can set the permissions of "${room.name}"`)
    const permission = patch.permission === undefined ? undefined : rt.cleanRoomPermission(patch.permission)
    const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id)
    return { members, admin, name, notice, permission }
  }

  async function updateRoom(id, patch, actorId) {
    const asked = rt.roomOf(id)
    if (asked === undefined) throw new Error('Unknown group chat')
    planRoomChange(asked, patch, actorId)
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    const clash = workDir === undefined ? undefined : await rt.privateClash(workDir)
    if (clash) throw new Error(`${workDir} is in or around the folder of ${clash.name}, a private Bot, so a group cannot work there`)
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    const { members, admin, name, notice, permission } = planRoomChange(room, patch, actorId)

    const changes = []
    const names = ids => ids.map(member => liveBot(member)?.name).filter(Boolean).join(', ')
    const added = members.filter(member => !room.members.includes(member))
    const removed = room.members.filter(member => !members.includes(member))
    if (added.length > 0) changes.push(`added ${names(added)}`)
    if (names(removed) !== '') changes.push(`removed ${names(removed)}`)
    for (const member of removed) {
      if (room.seen) delete room.seen[member]
      rt.dropGroupSession(room, member)
    }
    room.members = members
    if (admin !== (room.admin ?? null)) changes.push(admin ? `made ${rt.botOf(admin).name} the admin` : 'removed the admin')
    room.admin = admin
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      room.mode = patch.mode
      changes.push(patch.mode === 'admin' ? 'plain messages now go to the admin first' : 'every member now replies in turn')
    }
    if (notice !== undefined && notice !== (room.notice ?? '')) {
      room.notice = notice
      changes.push(notice ? 'updated the notice' : 'cleared the notice')
    }
    if (moving && workDir !== room.workDir) {
      delete room.folderNotice
      if (workDir === undefined) delete room.workDir
      else room.workDir = workDir
      delete room.memberDirs
      changes.push(workDir ? `every member now works in ${workDir} here` : 'every member works in its own folder again')
      void rt.followFolder({ roomId: room.id })
    }
    const before = room.name
    if (name !== undefined) {
      if (name !== '') {
        room.named = true
        room.name = name
      } else {
        delete room.named
      }
    }
    if (!room.named) room.name = autoRoomName(room.members)
    if (permission !== undefined && await rt.setRoomPermission(room, permission)) {
      changes.push(permission ? `every member now works with the ${permission} permissions here` : 'every member uses its own permissions again')
    }
    if (room.name !== before) {
      changes.push(`renamed it "${room.name}"`)
      await retitleRoom(room)
    }
    if (patch.section !== undefined || patch.sectionId !== undefined) {
      const nextSecId = resolveSectionInput({ section: patch.section, sectionId: patch.sectionId })
      if ((nextSecId ?? undefined) !== room.sectionId) {
        if (nextSecId === null || nextSecId === undefined) {
          delete room.sectionId
          changes.push('removed it from its sidebar section')
        } else {
          room.sectionId = nextSecId
          const secName = (state.sections ?? []).find(sec => sec.id === nextSecId)?.name ?? nextSecId
          changes.push(`moved it to section "${secName}"`)
        }
      }
    }
    await rt.save()
    return { room, changes }
  }

  async function deleteRoom(id) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    const archived = rt.archiveGroupMemory(room)
    for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId)
    for (const segment of room.parts ?? []) delete state.switching[segment.sessionId]
    delete state.switching[rt.sessionOfRoom(room)]
    delete state.rooms[id]
    rt.roomInbox.delete(id)
    rt.dropGroupLines(id)
    await archived
    const failed = await saveForDelete()
    // Armed scheduled tasks refuse a plain archive and would keep delivering into
    // the deleted group; the session-stop that stopActivity runs removes them.
    await ctx.workspaceRegistry.archiveSession(rt.sessionOfRoom(room), { stopActivity: true })
      .catch(error => rt.warn('ds-bot: group chat %s not archived: %s', room.name, error))
    if (failed !== undefined) throw failed
  }

  async function setMain(id, main) {
    const bot = liveBot(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (main && bot.private === true) throw new Error(`${bot.name} is private, so it cannot be a Main Bot`)
    if (!main) {
      if (!rt.isMain(id)) return
      throw new Error('The team needs a Main Bot; make another Bot the Main Bot instead')
    }
    if (state.mainBotIds.length === 1 && state.mainBotIds[0] === id) return
    const next = [id]
    if (main) delete bot.hidden
    for (const other of state.mainBotIds.filter(other => !next.includes(other))) {
      if (rt.botOf(other)?.kickoff?.main) delete rt.botOf(other).kickoff
    }
    state.mainBotIds = next
    if (next[0] && state.bots[next[0]]) delete state.bots[next[0]].sectionId
    await rt.save()
  }

  async function deleteBot(id) {
    const bot = liveBot(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (rt.isMain(id)) throw new Error('A Main Bot cannot be deleted; remove its Main Bot role first')
    deleting.add(id)
    try {
      const archived = rt.archiveBotMemory(id)
      const current = rt.chatOf(id)
      const parts = new Set([id, current, ...(bot.segments ?? []).map(segment => segment.sessionId), ...openSessions(bot)])
      const closedArchive: Record<string, any> | undefined = bot.private === true ? {
        id: bot.id,
        name: bot.name,
        ...(bot.workDir === undefined ? {} : { workDir: bot.workDir }),
        sessionIds: [...parts, ...rt.groupSessionsOf(id)],
        archiving: true,
      } : undefined
      await rt.releaseBot(id, [...parts, ...rt.groupSessionsOf(id)])
      if (closedArchive !== undefined) state.privateArchives = [...(state.privateArchives ?? []).filter(entry => entry.id !== id), closedArchive]
      delete state.bots[id]
      rt.dropOrphanCapabilities?.(bot)
      for (const part of parts) {
        delete state.questions[part]
        if (state.views !== undefined) delete state.views[part]
        if (state.closedCards !== undefined) delete state.closedCards[part]
        delete state.exchangeTurns[part]
        delete state.switching[part]
      }
      const touched = []
      for (const room of Object.values(state.rooms) as any[]) {
        if (!room.members.includes(id)) continue
        room.members = room.members.filter(member => member !== id)
        if (room.admin === id) room.admin = null
        rt.dropGroupSession(room, id)
        touched.push(room)
      }
      await followMemberNames(touched)
      await rt.forgetBotSecrets(id)
      const archivePath = await archived
      if (closedArchive !== undefined) {
        if (archivePath !== undefined) closedArchive.archivePath = archivePath
        delete closedArchive.archiving
      }
      const failed = await saveForDelete()
      // Same as deleteRoom: stopActivity removes the Session's armed scheduled tasks.
      // Past parts are archived too: a part move can leave tasks on the old Session,
      // which otherwise stays armed and invisible. Already-archived ids are a no-op.
      for (const part of parts) {
        await ctx.workspaceRegistry.archiveSession(part, { stopActivity: true })
          .catch(error => rt.warn('ds-bot: Bot %s not archived: %s', bot.name, error))
      }
      if (failed !== undefined) throw failed
    } finally {
      deleting.delete(id)
    }
  }

  async function saveForDelete() {
    try {
      await rt.save()
      return undefined
    } catch (error) {
      if (error?.code === 'ELOCKLOST' || rt.readOnly() !== undefined) throw error
      return error
    }
  }

  async function bootstrap() {
    await rt.load()
    void rt.syncModels()
    if (state.mainBotIds.some(id => rt.botOf(id))) return
    bootstrapping ??= createBot({ name: defaults.mainName, role: defaults.mainRole, main: true, color: 'deepseek', avatar: { shape: 'whale' }, pickModel: true })
      .finally(() => { bootstrapping = null })
    await bootstrapping
  }

  Object.assign(rt, {
    ensureWorkspace, keepTeamFolder, createSession, createBot, duplicateBot, updateBot, setFlags,
    saveSection, reorderSections, deleteSection,
    roomBusy, autoRoomName, retitleRoom, createRoom, updateRoom, deleteRoom,
    setMain, deleteBot, bootstrap, releaseKickoff, greetingOut, holdKickoffAgain, userWrote, userAnswered,
  })
}
