#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const at = process.argv.indexOf('--root')
const root = resolve(at === -1 ? join(import.meta.dirname, '..') : process.argv[at + 1])
const load = path => import(pathToFileURL(join(root, path)).href)

const DSH_TOOLS = [
  ['read', 'Read a file.', { path: { type: 'string' } }],
  ['bash', 'Run a shell command.', { command: { type: 'string' } }],
  ['write', 'Write a file.', { path: { type: 'string' }, content: { type: 'string' } }],
  ['edit', 'Edit a file.', { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }],
  ['web_search', 'Search the web.', { query: { type: 'string' } }],
  ['web_fetch', 'Fetch a web page.', { url: { type: 'string' } }],
].map(([name, description, properties]) => ({ name, description, parameters: { type: 'object', properties } }))

export const TEAM = {
  chief: { name: 'Chief', role: 'Lead', instructions: 'Coordinates the team for the user.' },
  researcher: { name: 'Researcher', role: 'Research', instructions: 'Finds and reads sources: web, papers, docs. Answers with links.' },
  coder: { name: 'Coder', role: 'Engineer', instructions: 'Writes and fixes code in the user\'s repositories, runs tests, opens pull requests.' },
  writer: { name: 'Writer', role: 'Writing', instructions: 'Drafts posts, emails and docs in the user\'s voice.' },
  ops: { name: 'Ops', role: 'Operations', instructions: 'Keeps servers, deploys and backups running; reads logs and dashboards.' },
}

const state = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: Object.fromEntries(Object.entries(TEAM).map(([id, bot], index) => [id, { id, sessionId: id, ...bot, createdAt: index + 1 }])),
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

const schemaOf = (tool) => {
  const parameters = tool.parameters
  if (parameters?.type === 'object') return parameters
  if (parameters !== undefined && typeof parameters.toJSONSchema === 'function') return parameters.toJSONSchema()
  return { type: 'object', properties: {} }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-routing-prompt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state()))
  const { createRuntime } = await load('index.js')
  const { fakeContext } = await load('test/fake-ctx.js')
  const ctx = fakeContext()
  const provided = new Map()
  ctx.provide = (name, service) => { provided.set(name, service) }
  ctx.tools.schemas = () => DSH_TOOLS.map(tool => ({ name: tool.name }))
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new' }), resolveAgent: async id => ({ agent: { id, session: { id } } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()

  const boardTools = []
  const boardSections = new Map()
  let board
  if (existsSync(join(root, 'src/board/plugin.ts'))) {
    const { install } = await load('src/board/plugin.ts')
    const { openBoardStore } = await load('src/board/store.ts')
    const file = join(home, 'board', 'board.json')
    board = install({ on: () => () => {} }, { file, watchMs: 0 }, {
      identity: provided.get('botSessionIdentity') ?? { ownerOfSession: id => rt.ownerOfSession?.(id), subscribe: () => () => {} },
      roster: rt.companions?.roster ?? provided.get('dsBotRoster'),
      notes: rt.companions?.notes ?? provided.get('dsBotNotes'),
      bridge: rt.companions?.bridge ?? provided.get('dsBotBridge'),
      tools: { register: (tool) => { boardTools.push(tool); return () => {} } },
      connection: { fetch: { register: () => () => {} } },
      systemPrompt: { section: (section) => { boardSections.set(section.name, section); return () => {} } },
      store: openBoardStore(file),
    })
  }

  const registered = []
  const denied = new Set()
  const agent = {
    id: 'chief',
    session: { id: 'chief' },
    ctx: {
      tools: {
        register: (tool) => { registered.push(tool); return () => {} },
        restrict: (filter) => { for (const name of filter.deny ?? []) denied.add(name); return () => {} },
      },
      on: () => () => {},
      effect: execute => execute(),
    },
    followup: () => {},
  }
  await Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const turn = { agent: { id: 'chief' } }
  const guard = name => (ctx.guards ?? []).map(check => check({ name, agent: { id: 'chief' } })).find(reason => reason !== undefined)

  const sections = [...ctx.sections.values(), ...boardSections.values()]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((section) => {
      try { return { name: section.name, text: String(section.text(turn) ?? '') } } catch (error) { return { name: section.name, text: '', error: String(error?.message ?? error) } }
    })
    .filter(section => section.text !== '')
  const contexts = [...(ctx.contexts?.values() ?? [])]
    .map((context) => {
      try { return { name: context.name, text: String(context.text(turn) ?? '') } } catch { return { name: context.name, text: '' } }
    })
    .filter(context => context.text !== '')

  const seen = new Set()
  const tools = [...DSH_TOOLS, ...registered, ...boardTools]
    .filter(tool => !denied.has(tool.name) && guard(tool.name) === undefined)
    .filter(tool => !seen.has(tool.name) && seen.add(tool.name))
    .map(tool => ({ name: tool.name, description: String(tool.description ?? ''), parameters: schemaOf(tool) }))

  process.stdout.write(`${JSON.stringify({ root, team: TEAM, main: 'chief', sections, contexts, tools, denied: [...denied].sort() }, null, 2)}\n`)
  board?.dispose?.()
  await ctx.dispose()
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
}

await main()
