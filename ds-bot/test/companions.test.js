import test from 'node:test'
import assert from 'node:assert/strict'
import { install, rosterService, notesService } from '../src/host/companions.js'

const fixture = () => {
  const sent = []
  const listeners = new Set()
  const state = {
    bots: {
      a: { id: 'a', name: 'Ada', role: 'Lead', color: '#3366ff', avatar: { shape: 'fox' }, segments: [], instructions: 'secret' },
      b: { id: 'b', name: 'Bo', role: '' },
    },
    rooms: { r: { id: 'r', name: 'Ship', members: ['a', 'gone'], admin: 'a', log: [{ text: 'hi' }] } },
  }
  const rt = {
    ctx: {},
    state,
    load: async () => {},
    botOf: id => (Object.hasOwn(state.bots, id) ? state.bots[id] : undefined),
    roomOf: id => (Object.hasOwn(state.rooms, id) ? state.rooms[id] : undefined),
    isMain: id => id === 'a',
    findBot: ref => (Object.hasOwn(state.bots, ref) ? state.bots[ref] : undefined) ?? Object.values(state.bots).find(bot => bot.name.toLowerCase() === ref.toLowerCase()),
    onSaved: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    sendUser: async input => { sent.push(input) },
  }
  return { rt, sent, listeners }
}

test('the roster shows Bots and groups as copies, without private fields', () => {
  const { rt } = fixture()
  const roster = rosterService(rt)
  assert.deepEqual(roster.bots(), [
    { id: 'a', name: 'Ada', role: 'Lead', color: '#3366ff', avatar: { shape: 'fox' }, main: true },
    { id: 'b', name: 'Bo', role: '', main: false },
  ])
  assert.deepEqual(roster.groups(), [{ id: 'r', name: 'Ship', members: ['a'], admin: 'a' }])
  assert.equal(roster.findBot('bo').id, 'b')
  assert.equal(roster.findBot('nobody'), undefined)
  assert.equal(roster.bot('__proto__'), undefined)
  assert.equal(roster.group('r').name, 'Ship')
  const bot = roster.bot('a')
  assert.throws(() => { bot.name = 'X' })
  assert.equal(rt.state.bots.a.name, 'Ada')
})

test('roster subscribers hear every save and can unsubscribe', () => {
  const { rt, listeners } = fixture()
  const roster = rosterService(rt)
  let heard = 0
  const off = roster.subscribe(() => { heard += 1 })
  for (const listener of listeners) listener()
  off()
  assert.equal(listeners.size, 0)
  assert.equal(heard, 1)
})

test('a note goes to the group the Bot is in, else to its own chat', async () => {
  const { rt, sent } = fixture()
  const notes = notesService(rt)
  assert.deepEqual(await notes.deliver({ botId: 'a', roomId: 'r', text: ' ship\n it ' }), { sessionId: 'r', where: 'group' })
  assert.deepEqual(await notes.deliver({ botId: 'b', roomId: 'r', text: 'hello' }), { sessionId: 'b', where: 'chat' })
  assert.deepEqual(await notes.deliver({ botId: 'a', text: 'solo' }), { sessionId: 'a', where: 'chat' })
  assert.deepEqual(sent.map(entry => [entry.sessionId, entry.content[0].text]), [['r', '@Ada ship it'], ['b', 'hello'], ['a', 'solo']])
  assert.deepEqual(await notes.deliver({ botId: 'x', text: 'hi' }), { error: 'No such Bot.' })
  assert.deepEqual(await notes.deliver({ botId: 'a', text: '  ' }), { error: 'Write a note first.' })
  assert.equal(sent.length, 3)
})

test('reply listeners hear each answer a Bot writes, a failing listener does not stop the rest', () => {
  const { rt } = fixture()
  const warned = []
  rt.warn = (...args) => warned.push(args)
  const notes = notesService(rt)
  const heard = []
  notes.onReply(() => { throw new Error('boom') })
  const off = notes.onReply(reply => heard.push(reply))
  rt.botReplied({ botId: 'a', roomId: 'r', text: 'done', since: 5 })
  off()
  rt.botReplied({ botId: 'a', text: 'again', since: 6 })
  assert.deepEqual(heard, [{ botId: 'a', roomId: 'r', text: 'done', since: 5 }])
  assert.equal(Object.isFrozen(heard[0]), true)
  assert.equal(warned.length, 2)
})

test('install provides both services under a real host, and stays quiet without one', () => {
  const { rt } = fixture()
  install(rt)
  assert.ok(rt.companions.roster && rt.companions.notes)
  const provided = {}
  const hosted = fixture().rt
  hosted.ctx.provide = (name, value) => { provided[name] = value }
  install(hosted)
  assert.deepEqual(Object.keys(provided).sort(), ['dsBotNotes', 'dsBotRoster'])
  assert.equal(typeof provided.dsBotRoster.bots, 'function')
  assert.equal(typeof provided.dsBotNotes.deliver, 'function')
})
