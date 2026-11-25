import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineTool, lenientArgs, plainToolSchema } from '../src/host/tool-schema.ts'

// The schema public#1508 reported from an MCP connector: a union with no type of its
// own, and an enum that lists null. Moonshot/KIMI refused the whole request for it.
const REPORTED = {
  type: 'object',
  properties: {
    sort_order: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      enum: ['ASC', 'DESC', null],
      description: 'Sort Order: The sort order (ASC or DESC). Defaults to DESC.',
      title: 'Sort Order',
    },
  },
  required: ['sort_order'],
}

test('the reported union property is collapsed to its first non-null branch, without the null enum entry', () => {
  const plain = plainToolSchema(REPORTED)
  assert.deepEqual(plain.properties.sort_order, {
    type: 'string',
    enum: ['ASC', 'DESC'],
    description: 'Sort Order: The sort order (ASC or DESC). Defaults to DESC.',
    title: 'Sort Order',
  })
  assert.equal(plain.type, 'object')
  assert.deepEqual(plain.required, ['sort_order'])
  assert.ok(Array.isArray(REPORTED.properties.sort_order.oneOf))
  assert.deepEqual(REPORTED.properties.sort_order.enum, ['ASC', 'DESC', null])
})

test('a schema without a type gets the one its shape or enum names', () => {
  const plain = plainToolSchema({
    type: 'object',
    properties: {
      filter: { type: 'object', properties: { status: { enum: ['open', 'closed'] } } },
      ids: { type: 'array', items: { type: 'integer' } },
      mode: { enum: ['fast', 'slow'] },
      flags: { enum: [true, false] },
      count: { enum: [1, 2, 3] },
      bare: {},
    },
  })
  assert.equal(plain.properties.filter.type, 'object')
  assert.equal(plain.properties.filter.properties.status.type, 'string')
  assert.deepEqual(plain.properties.filter.properties.status.enum, ['open', 'closed'])
  assert.equal(plain.properties.ids.items.type, 'integer')
  assert.equal(plain.properties.mode.type, 'string')
  assert.equal(plain.properties.flags.type, 'boolean')
  assert.equal(plain.properties.count.type, 'integer')
  assert.deepEqual(plain.properties.bare, {})
})

test('nested arrays of objects are typed at every level', () => {
  const plain = plainToolSchema({
    type: 'object',
    properties: {
      rows: { type: 'array', items: { properties: { id: { type: 'string' } } } },
    },
  })
  assert.equal(plain.properties.rows.items.type, 'object')
  assert.deepEqual(plain.properties.rows.items.properties.id, { type: 'string' })
})

test('a nullable union keeps the type of its non-null branch and loses the null enum entry', () => {
  const plain = plainToolSchema({ type: 'object', properties: { tag: { anyOf: [{ type: 'null' }, { type: 'integer' }], enum: [1, null] } } })
  assert.deepEqual(plain.properties.tag, { type: 'integer', enum: [1] })
})

test('refs and const are removed, as the local agent bridge already did', () => {
  const plain = plainToolSchema({
    type: 'object',
    $defs: { name: { type: 'string' } },
    properties: {
      name: { $ref: '#/$defs/name' },
      kind: { const: 'row' },
    },
  })
  assert.equal(plain.$defs, undefined)
  assert.deepEqual(plain.properties.name, {})
  assert.deepEqual(plain.properties.kind, {})
})

test('a schema already plain comes out equal, so the tool list is left as it was', () => {
  const plain = { type: 'object', properties: { text: { type: 'string', description: 'x' } }, required: ['text'] }
  assert.deepEqual(plainToolSchema(plain), plain)
  assert.deepEqual(plainToolSchema({}), {})
  assert.deepEqual(plainToolSchema(undefined), {})
})


test('schema keywords used as property names and metadata remain data', () => {
  const input = { type: 'object', properties: {
    items: { type: 'array', items: { type: 'string' } },
    properties: { type: 'string' }, const: { type: 'string' },
    anyOf: { type: 'string' }, $ref: { type: 'string' },
    options: { type: 'object', default: { items: [1], const: 'keep' } },
  } }
  assert.deepEqual(plainToolSchema(input), input)
})

const ARGS = {
  type: 'object',
  properties: {
    always: { type: 'boolean' },
    limit: { type: 'integer' },
    ratio: { type: 'number' },
    text: { type: 'string' },
    flags: { type: 'array', items: { type: 'boolean' } },
    nested: { type: 'object', properties: { on: { type: 'boolean' } } },
  },
}

test('a boolean or a number written as a string reads as the value it spells', () => {
  const args = { always: 'true', limit: '20', ratio: ' 0.5 ', text: 'true', flags: ['false', true], nested: { on: 'FALSE' } }
  assert.deepEqual(lenientArgs(ARGS, args), { always: true, limit: 20, ratio: 0.5, text: 'true', flags: [false, true], nested: { on: false } })
  assert.equal(args.always, 'true')
})

test('a string that spells no value of the type is left for the check to refuse', () => {
  const args = { always: 'yes', limit: '2.5', ratio: '1e400', nested: 'x' }
  assert.deepEqual(lenientArgs(ARGS, args), args)
  assert.deepEqual(lenientArgs(ARGS, { limit: '' }), { limit: '' })
  const plain = { always: true, text: 'hi' }
  assert.equal(lenientArgs(ARGS, plain), plain)
})

test('a DS Bot tool takes "true" and "20" for a boolean and an integer', async () => {
  const seen = []
  const tool = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { always: { type: 'boolean' }, limit: { type: 'integer' } },
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: `${typeof args.always} ${value}` }] },
    execute: async (args) => {
      seen.push(args)
      return 'ok'
    },
  })
  assert.equal(await tool.execute({ always: 'true', limit: '20' }, {}), 'ok')
  assert.deepEqual(seen, [{ always: true, limit: 20 }])
  assert.deepEqual(tool.output.render({ always: 'false' }, 'ok'), [{ type: 'text', text: 'boolean ok' }])
  await assert.rejects(tool.execute({ always: 'maybe' }, {}), /"always" must be a boolean/)
})
