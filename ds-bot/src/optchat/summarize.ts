import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { DEFAULTS, part, utf8 } from './core.ts'

const INSTRUCTION = [
  'Summarize the text below for a long-lived assistant\'s memory.',
  'Keep names, dates, numbers, decisions, preferences and open questions exactly.',
  'Write plain prose without a preamble. Stay under {bytes} bytes.',
].join(' ')

export function nextNode(ns) {
  const count = ns.events.length
  for (let i = 0; i < count; i += 1) if (!ns.has(part(0, i))) return part(0, i)
  for (let l = 1; 2 ** l <= count; l += 1) {
    for (let i = 0; (i + 1) * 2 ** l <= count; i += 1) {
      const p = part(l, i)
      if (!ns.has(p) && ns.children(p).every(child => ns.has(child))) return p
    }
  }
  return undefined
}

export async function buildOne(ns, summarize, { nodeBytes = DEFAULTS.nodeBytes, attempts = DEFAULTS.sizeAttempts, signal }: any = {}) {
  const p = nextNode(ns)
  if (p === undefined) return undefined
  const source = ns.source(p)
  if (source === undefined) return undefined
  let text = p.l === 0 && utf8(source) <= nodeBytes ? source : undefined
  for (let attempt = 0; text === undefined && attempt < attempts; attempt += 1) {
    const bytes = Math.floor(nodeBytes * (1 - attempt * 0.2))
    const out = String(await summarize(source, bytes, signal) ?? '').trim()
    if (out !== '' && utf8(out) <= nodeBytes) text = out
  }
  if (text === undefined) throw new Error(`optchat: summary for ${p.start}+${p.n} stayed over ${nodeBytes} bytes`)
  const node = { l: p.l, i: p.i, text }
  ns.saveNode(node)
  return node
}

export async function buildAll(ns, summarize, options: any = {}) {
  let built = 0
  while (!options.signal?.aborted) {
    const node = await buildOne(ns, summarize, options)
    if (node === undefined) break
    built += 1
  }
  return built
}

async function lowestEffort(llm, route) {
  if (typeof route.reasoningEffort === 'string') return route.reasoningEffort
  const info = await llm.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
  const efforts = info?.reasoning?.efforts ?? []
  return efforts.some(entry => entry.id === 'off') ? 'off' : efforts[0]?.id
}

export function llmSummarizer(llm, route) {
  let effortPromise
  return async (text, bytes, signal) => {
    const effort = await (effortPromise ??= lowestEffort(llm, route))
    const assembler = new BlockAssembler()
    const request = {
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      purpose: 'compaction',
      system: INSTRUCTION.replace('{bytes}', String(bytes)),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: Math.max(64, Math.ceil(bytes / 2)),
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of llm.stream(request)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`optchat: summarizer ${finish.kind}: ${finish.failure?.message ?? ''}`)
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }
}
