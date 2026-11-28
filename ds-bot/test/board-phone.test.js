import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { startRelayServer } from '../../link/server/server.ts'
import * as hostPlugin from '../index.js'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair, parsePairingUri, randomToken } from '../link.js'
import * as boardPlugin from '../src/board/entry.ts'
import { ROUTE } from '../src/board/plugin.ts'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}
const TITLE = 'Check the release'
const server = await startRelayServer()
after(() => server.close())

async function pair(t, { mountBoard = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-board-phone-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const root = new Context()
  let client
  t.after(async () => {
    try {
      await client?.close()
      await root.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const file = join(home, 'bot-board', 'board.json')
  const fake = fakeContext()
  for (const name of ['tools', 'systemPrompt', 'llm']) root.provide(name, fake[name])
  for (const name of ['sessions', 'sessionTitle', 'sessionController', 'workspaceRegistry']) root.provide(name, {})
  const routes = new Map()
  root.provide('connection', { fetch: { register: route => {
    if (route.methods.includes('POST')) routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } })
  await root.plugin(hostPlugin, { home, github: false })
  const post = async (path, endpoint, payload) => {
    const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const local = (endpoint, payload) => post('/api/bot', endpoint, payload)
  let card
  if (mountBoard) {
    await root.plugin(boardPlugin, { file, watchMs: -1, adoptMs: -1, waitPollMs: -1, teardownPollMs: -1, mergePollMs: -1 })
    const created = await post(ROUTE, 'add', { title: TITLE })
    assert.equal(created.ok, true)
    ;[card] = Object.values(created.value.cards)
  }

  assert.equal((await local('phone-set', { server: server.url, on: true })).ok, true)
  let phone
  for (let tries = 0; tries < 200; tries += 1) {
    phone = (await local('state', {})).value.phone
    if (phone.status === 'online') break
    await delay(25)
  }
  assert.equal(phone.status, 'online')
  const paired = await local('phone-pair', {})
  assert.equal(paired.ok, true)
  const offer = parsePairingUri(paired.value.pairing.uri)
  const keys = generateKeyPair()
  const self = { deviceId: deviceIdFor(keys.publicKey), ...keys }
  const peer = { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }
  const relay = new RelayTransport(offer.server, { deviceId: self.deviceId, identityKey: self.publicKey, accessToken: randomToken(), targetDeviceId: peer.deviceId })
  const secure = new SecureTransport(relay, self, peer, { hello: { pairingCode: offer.code, name: 'Pixel' }, handshakeTimeoutMs: 2_000 })
  client = new RpcClient(secure, 5_000)
  await client.connect()
  const board = (endpoint, payload) => client.rpc('bot', { endpoint: 'board', payload: { endpoint, payload } })
  const stored = () => JSON.parse(readFileSync(file, 'utf8')).cards[card.id]
  return { board, card, stored }
}

test('board state reads a persisted card over the phone link', async (t) => {
  const { board, card, stored } = await pair(t)
  const reply = await board('state', {})
  assert.equal(reply.ok, true)
  assert.equal(reply.value.cards[card.id].title, TITLE)
  assert.deepEqual(reply.value.cards[card.id], stored())
})

test('board write saves a note and moves the card to another column', async (t) => {
  const { board, card, stored } = await pair(t)
  const id = card.id
  const text = 'Ready for the next check.'
  assert.equal(stored().status, 'todo')
  assert.equal((await board('note', { id, text })).ok, true)
  assert.equal(stored().notes.at(-1).text, text)
  assert.equal((await board('move', { id, status: 'active' })).ok, true)
  assert.equal(stored().status, 'active')
})

test('board allowlist refuses restricted and unknown actions at the host', async (t) => {
  const { board, card } = await pair(t)
  for (const endpoint of ['file', 'pane', 'add', 'reassign', 'trace', 'unknown', 'toString']) {
    const reply = await board(endpoint, { id: card.id, title: 'New card', assignee: 'm1', trace: 'all' })
    assert.equal(reply.ok, false, endpoint)
    assert.equal(reply.error.code, 'board/refused', endpoint)
    assert.deepEqual(reply.error.details, {}, endpoint)
  }
})

test('board off returns an error with no board plugin mounted', async (t) => {
  const { board } = await pair(t, { mountBoard: false })
  const reply = await board('state', {})
  assert.equal(reply.ok, false)
  assert.equal(reply.error.code, 'board/off')
})
