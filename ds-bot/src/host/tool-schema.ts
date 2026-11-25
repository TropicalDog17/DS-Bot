// Tool schemas handed to a model provider. An MCP server may describe a property as a
// union with no `type` of its own, or list null in an enum; a strict provider
// (Moonshot/KIMI validates a subset of JSON Schema) refuses the whole request for that,
// while others accept it. Every connector schema is handed on plain instead, so the same
// tool list works on every provider.
import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools'

const scalarType = type => typeof type === 'string' || (Array.isArray(type) && type.every(part => typeof part === 'string'))

function enumType(values) {
  const kept = values.filter(value => value !== null)
  if (kept.length === 0) return undefined
  if (kept.every(value => typeof value === 'string')) return 'string'
  if (kept.every(value => typeof value === 'boolean')) return 'boolean'
  if (kept.every(value => typeof value === 'number')) return kept.every(Number.isInteger) ? 'integer' : 'number'
  return undefined
}

// A schema with a type on every node it can name one for, and no null left in a
// scalar enum: the two things a strict provider rejects in an otherwise valid schema.
function typed(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  delete out.$ref
  delete out.$defs
  delete out.definitions
  delete out.const
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const first = node[key]?.find?.(branch => branch?.type !== 'null')
    delete out[key]
    if (first !== undefined) Object.assign(out, typed(first))
  }
  for (const key of ['properties', 'patternProperties']) {
    if (out[key] !== undefined) out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, schema]) => [name, typed(schema)]))
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) {
    if (out[key] !== undefined) out[key] = Array.isArray(out[key]) ? out[key].map(typed) : typed(out[key])
  }
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = 'object'
    else if (out.items !== undefined) out.type = 'array'
    else if (Array.isArray(out.enum)) out.type = enumType(out.enum)
  }
  if (Array.isArray(out.enum) && scalarType(out.type)) out.enum = out.enum.filter(value => value !== null)
  return out
}

export function plainToolSchema(parameters) {
  return typed(parameters ?? {})
}

// A model sometimes writes a boolean or a number as a string ("always": "true"), and
// DSH's strict check then refuses the whole call. DS Bot's own tools read such a
// string as the value it spells, where the schema allows no string; anything else is
// left for the check to refuse. The input is never changed.
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
export function lenientArgs(schema, value) {
  if (schema === null || typeof schema !== 'object') return value
  if (typeof value === 'string') {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (types.includes('string')) return value
    const text = value.trim().toLowerCase()
    if (types.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true'
    if ((types.includes('number') || types.includes('integer')) && NUMERIC.test(text)) {
      const number = Number(text)
      if (Number.isFinite(number) && (types.includes('number') || Number.isInteger(number))) return number
    }
    return value
  }
  if (Array.isArray(value)) {
    if (schema.items === undefined) return value
    const items = value.map(item => lenientArgs(schema.items, item))
    return items.some((item, at) => item !== value[at]) ? items : value
  }
  if (value !== null && typeof value === 'object' && schema.properties !== undefined) {
    let out = value
    for (const [name, inner] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, name)) continue
      const next = lenientArgs(inner, value[name])
      if (next !== value[name]) {
        if (out === value) out = { ...value }
        out[name] = next
      }
    }
    return out
  }
  return value
}

export function defineTool(options) {
  const tool = dshDefineTool(options)
  const loose = args => lenientArgs(tool.parameters, args)
  const execute = tool.execute
  tool.execute = (args, exec) => execute(loose(args), exec)
  for (const key of ['presentCall', 'presentResult', 'isConcurrencySafe']) {
    const inner = tool[key]
    if (inner !== undefined) tool[key] = (args, ...rest) => inner(loose(args), ...rest)
  }
  const { render, presentationMeta } = tool.output
  tool.output = {
    ...tool.output,
    render: (args, value) => render(loose(args), value),
    ...(presentationMeta === undefined ? {} : { presentationMeta: (args, value) => presentationMeta(loose(args), value) }),
  }
  return tool
}
