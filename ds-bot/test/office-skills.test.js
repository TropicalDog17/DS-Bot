import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { officeProvider, officeNode, cliPath } from '../src/host/office-skills.ts'

describe('office skill provider', () => {
  test('lists office and office-tools with bundled metadata', async () => {
    const provider = officeProvider()
    const list = await provider.list()
    assert.deepEqual(list.map(s => s.name), ['office', 'office-tools'])
    for (const skill of list) {
      assert.equal(skill.provider, 'ds-bot-office')
      assert.equal(skill.source, 'bundled')
      assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
      assert.equal(skill.resourceBase.kind, 'directory')
      assert.ok(existsSync(skill.locator))
      assert.ok(skill.description.length > 0)
    }
    assert.equal(list[0].rank, 550)
    assert.equal(list[1].rank, 600)
  })

  test('office-tools content carries the runtime block', async () => {
    const provider = officeProvider()
    const [candidate] = (await provider.list()).filter(s => s.name === 'office-tools')
    const skill = await provider.get(candidate)
    assert.match(skill.content, /officeTools/)
    assert.match(skill.content, /PowerShell/)
  })
})

describe('office node selection', () => {
  test('uses DS_BOT_OFFICE_NODE when the file exists', () => {
    const { node } = officeNode({ DS_BOT_OFFICE_NODE: process.execPath })
    assert.equal(node, process.execPath)
  })
  test('ignores DS_BOT_OFFICE_NODE that does not exist', () => {
    const { node } = officeNode({ DS_BOT_OFFICE_NODE: '/no/such/node-here' })
    assert.equal(node, process.execPath)
  })
  test('falls back to the host interpreter under plain Node', () => {
    const { node } = officeNode({})
    assert.equal(node, process.execPath)
  })
})

describe('cli path mapping', () => {
  test('maps app.asar to app.asar.unpacked', () => {
    const inAsar = `D:${sep}app${sep}resources${sep}app.asar${sep}node_modules${sep}ds-bot${sep}office.js`
    assert.equal(cliPath(inAsar), `D:${sep}app${sep}resources${sep}app.asar.unpacked${sep}node_modules${sep}ds-bot${sep}office.js`)
  })
  test('leaves unpackaged paths alone', () => {
    const plain = `D:${sep}repo${sep}ds-bot${sep}office.js`
    assert.equal(cliPath(plain), plain)
  })
})
