#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next
        i += 1
      } else {
        args[key] = true
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function usageHelp() {
  console.log([
    'Usage:',
    '  node ds-bot/dev/usage-benchmark.mjs snapshot --home <DSH_HOME> [--hours 24 | --since <ISO>] [--out <file.json>] [--claude-dir <dir>]',
    '  node ds-bot/dev/usage-benchmark.mjs diff <before.json> <after.json>',
  ].join('\n'))
}

function usageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const rec = stream[i]
    if (rec?.type === 'chunk' && rec.chunk?.type === 'usage') return rec.chunk.usage
  }
  return undefined
}

function querySqlite(dbPath, sql) {
  if (!existsSync(dbPath)) return []
  const raw = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  })
  return raw.trim() ? JSON.parse(raw) : []
}

function collectAux(dbPath, sinceMs) {
  const rows = querySqlite(dbPath, `
    SELECT provider, model, kind, input, output, cache_read, cache_write
    FROM calls
    WHERE time >= ${sinceMs}
  `)
  const byProviderModelKind = {}
  const opusAux = {}
  const haikuOptchat = { calls: 0, input: 0, output: 0 }
  for (const row of rows) {
    const key = `${row.provider}/${row.model}|${row.kind}`
    const bucket = (byProviderModelKind[key] ??= {
      provider: row.provider,
      model: row.model,
      kind: row.kind,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    bucket.calls += 1
    bucket.input += row.input || 0
    bucket.output += row.output || 0
    bucket.cacheRead += row.cache_read || 0
    bucket.cacheWrite += row.cache_write || 0

    if (String(row.model).includes('opus')) {
      const ok = (opusAux[row.kind] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      ok.calls += 1
      ok.input += row.input || 0
      ok.output += row.output || 0
      ok.cacheRead += row.cache_read || 0
      ok.cacheWrite += row.cache_write || 0
    }
    if (String(row.model).includes('haiku') && row.kind === 'other') {
      haikuOptchat.calls += 1
      haikuOptchat.input += row.input || 0
      haikuOptchat.output += row.output || 0
    }
  }
  return {
    auxByProviderModelKind: Object.values(byProviderModelKind).sort(
      (a, b) => (b.input + b.cacheRead + b.output) - (a.input + a.cacheRead + a.output),
    ),
    opusAux,
    haikuOptchat: {
      ...haikuOptchat,
      avgOutputPerCall: haikuOptchat.calls > 0 ? Math.round(haikuOptchat.output / haikuOptchat.calls) : 0,
    },
  }
}

function collectTurns(sessionsRoot, sinceMs) {
  const turnByModel = {}
  const solTurns = {
    calls: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    crZero: 0,
    crPartial: 0,
    crHigh: 0,
  }
  const opusTurns = {
    calls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    within5mMissCalls: 0,
    within5mMissInput: 0,
    within5mLiveImageCalls: 0,
    within5mLiveImageInput: 0,
    within5mStaleLiveImageCalls: 0,
    within5mStaleLiveImageInput: 0,
    imageOffloadEvents: 0,
  }

  function walk(dir) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(file)
        continue
      }
      if (!entry.isFile() || entry.name !== 'session.v4.jsonl.zstd') continue
      try {
        if (statSync(file).mtimeMs < sinceMs) continue
        const text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 120 * 1024 * 1024 })
        const liveImageSeqs = new Set()
        let lastAssistantSeq = -1
        let curProvider = ''
        let curModel = ''
        let retry = null
        let prevOpusTs
        const attempts = new Map()

        for (const line of text.split('\n')) {
          if (!line) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }
          const data = ev.data ?? {}
          if (ev.type === 'request/header') {
            const cfg = data.header?.config
            if (cfg?.provider && cfg?.model) {
              curProvider = cfg.provider
              curModel = cfg.model
            }
          } else if (ev.type === 'request/context') {
            if (data.provider && data.model) {
              curProvider = data.provider
              curModel = data.model
            }
          } else if (ev.type === 'llm/retry-started') {
            retry = retry?.turn === data.turn && retry.step === data.step
              ? { ...retry, count: retry.count + 1 }
              : { turn: data.turn, step: data.step, count: 1 }
          } else if (ev.type === 'session/end-seed' && data.inherited === true) {
            attempts.clear()
            liveImageSeqs.clear()
            lastAssistantSeq = -1
          } else if (ev.type === 'user/message' || ev.type === 'tool/result') {
            const blocks = data.content ?? data.message?.content ?? []
            if (Array.isArray(blocks) && blocks.some(block => block?.type === 'image' && block.offloaded !== true)) {
              liveImageSeqs.add(ev.seq)
            }
          } else if (ev.type === 'image/offload') {
            if ((ev.time || 0) >= sinceMs) opusTurns.imageOffloadEvents += 1
            for (const target of data.targets ?? []) liveImageSeqs.delete(target.seq)
          } else if (ev.type === 'assistant/message' || ev.type === 'assistant/attempt') {
            const usage = (ev.type === 'assistant/message' ? data.usage : undefined) ?? usageChunk(data.stream)
            const hadStaleLiveImage = [...liveImageSeqs].some(seq => seq < lastAssistantSeq)
            const hadLiveImage = liveImageSeqs.size > 0
            if (ev.type === 'assistant/message' && Number.isFinite(ev.seq)) lastAssistantSeq = ev.seq
            if (!usage) continue
            const ts = Number.isFinite(ev.time) ? ev.time : 0
            const src = data.message?.source
            const provider = src?.provider ?? curProvider
            const model = src?.model ?? curModel
            if (!model) continue
            const attempt = retry?.turn === data.turn && retry.step === data.step ? retry.count : 0
            const key = `${data.turn}:${data.step}:${attempt}`
            attempts.set(key, {
              time: ts,
              provider,
              model,
              input: usage.inputTokens || 0,
              cacheRead: usage.cacheReadTokens || 0,
              cacheWrite: usage.cacheWriteTokens || 0,
              output: usage.outputTokens || 0,
              hadLiveImage,
              hadStaleLiveImage,
            })
          }
        }

        const ordered = [...attempts.values()].sort((a, b) => a.time - b.time)
        for (const row of ordered) {
          if (row.time < sinceMs) {
            if (String(row.model).includes('opus')) prevOpusTs = row.time
            continue
          }
          const modelKey = `${row.provider}/${row.model}`
          const bucket = (turnByModel[modelKey] ??= {
            provider: row.provider,
            model: row.model,
            calls: 0,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
          })
          bucket.calls += 1
          bucket.input += row.input
          bucket.cacheRead += row.cacheRead
          bucket.cacheWrite += row.cacheWrite
          bucket.output += row.output

          if (String(row.model).includes('sol')) {
            solTurns.calls += 1
            solTurns.input += row.input
            solTurns.cacheRead += row.cacheRead
            solTurns.output += row.output
            if (row.cacheRead === 0) solTurns.crZero += 1
            else if (row.cacheRead / Math.max(1, row.input + row.cacheRead) < 0.8) solTurns.crPartial += 1
            else solTurns.crHigh += 1
          }
          if (String(row.model).includes('opus')) {
            opusTurns.calls += 1
            opusTurns.input += row.input
            opusTurns.cacheRead += row.cacheRead
            opusTurns.cacheWrite += row.cacheWrite
            opusTurns.output += row.output
            if (prevOpusTs !== undefined && (row.time - prevOpusTs) <= 5 * 60 * 1000 && row.input > 15_000) {
              opusTurns.within5mMissCalls += 1
              opusTurns.within5mMissInput += row.input
              if (row.hadLiveImage) {
                opusTurns.within5mLiveImageCalls += 1
                opusTurns.within5mLiveImageInput += row.input
              }
              if (row.hadStaleLiveImage) {
                opusTurns.within5mStaleLiveImageCalls += 1
                opusTurns.within5mStaleLiveImageInput += row.input
              }
            }
            prevOpusTs = row.time
          }
        }
      } catch {}
    }
  }

  walk(sessionsRoot)
  const totalPrompt = opusTurns.input + opusTurns.cacheRead
  const solPrompt = solTurns.input + solTurns.cacheRead
  return {
    opusTurns: {
      ...opusTurns,
      cacheHitRatio: totalPrompt > 0 ? Number((opusTurns.cacheRead / totalPrompt).toFixed(4)) : null,
      avgUncachedInputPerCall: opusTurns.calls > 0 ? Math.round(opusTurns.input / opusTurns.calls) : 0,
      avgPromptPerCall: opusTurns.calls > 0 ? Math.round(totalPrompt / opusTurns.calls) : 0,
      avgOutputPerCall: opusTurns.calls > 0 ? Math.round(opusTurns.output / opusTurns.calls) : 0,
      within5mMissRate: opusTurns.calls > 0 ? Number((opusTurns.within5mMissCalls / opusTurns.calls).toFixed(4)) : 0,
    },
    solTurns: {
      ...solTurns,
      cacheHitRatio: solPrompt > 0 ? Number((solTurns.cacheRead / solPrompt).toFixed(4)) : null,
      avgUncachedInputPerCall: solTurns.calls > 0 ? Math.round(solTurns.input / solTurns.calls) : 0,
      avgPromptPerCall: solTurns.calls > 0 ? Math.round(solPrompt / solTurns.calls) : 0,
      crZeroRate: solTurns.calls > 0 ? Number((solTurns.crZero / solTurns.calls).toFixed(4)) : 0,
    },
    turnByModel: Object.values(turnByModel).sort(
      (a, b) => (b.input + b.cacheRead + b.output) - (a.input + a.cacheRead + a.output),
    ),
  }
}

function collectClaudeCli(claudeDir, sinceMs) {
  if (!claudeDir || !existsSync(claudeDir)) return undefined
  const dedup = new Map()
  function walk(dir) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(file)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        if (statSync(file).mtimeMs < sinceMs) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        let idx = 0
        for (const line of lines) {
          idx += 1
          if (!line) continue
          const obj = JSON.parse(line)
          const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN
          if (!Number.isFinite(ts) || ts < sinceMs) continue
          const usage = obj.message?.usage
          const model = obj.message?.model
          if (!usage || !model || model === '<synthetic>') continue
          const key = obj.message?.id ?? obj.requestId ?? `${file}:${idx}`
          dedup.set(key, {
            model,
            isSubagent: file.includes('/subagents/'),
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            cacheWrite: usage.cache_creation_input_tokens || 0,
          })
        }
      } catch {}
    }
  }
  walk(claudeDir)
  const byModel = {}
  const subagents = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const entry of dedup.values()) {
    const bucket = (byModel[entry.model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    bucket.calls += 1
    bucket.input += entry.input
    bucket.output += entry.output
    bucket.cacheRead += entry.cacheRead
    bucket.cacheWrite += entry.cacheWrite
    if (entry.isSubagent) {
      subagents.calls += 1
      subagents.input += entry.input
      subagents.output += entry.output
      subagents.cacheRead += entry.cacheRead
      subagents.cacheWrite += entry.cacheWrite
    }
  }
  return { byModel, subagents }
}

function pctDelta(before, after) {
  if (before === null || after === null || before === undefined || after === undefined) return 'n/a'
  if (before === 0) return after === 0 ? '0.0%' : '+inf'
  const diff = ((after - before) / before) * 100
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`
}

function fmtValue(value, kind) {
  if (value === null || value === undefined) return 'n/a'
  if (kind === 'pct') return `${(value * 100).toFixed(2)}%`
  return Number(value).toLocaleString('en-US')
}

function runDiff(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'))
  const after = JSON.parse(readFileSync(afterPath, 'utf8'))
  const bOpus = before.dsBot.opusTurns
  const aOpus = after.dsBot.opusTurns
  const bAux = before.dsBot.opusAux ?? {}
  const aAux = after.dsBot.opusAux ?? {}
  const rows = [
    ['Opus turn calls', bOpus.calls, aOpus.calls, 'num'],
    ['Opus turn cache hit ratio', bOpus.cacheHitRatio, aOpus.cacheHitRatio, 'pct'],
    ['Opus avg uncached input / call', bOpus.avgUncachedInputPerCall, aOpus.avgUncachedInputPerCall, 'num'],
    ['Opus avg prompt / call', bOpus.avgPromptPerCall ?? Math.round((bOpus.input + bOpus.cacheRead) / Math.max(1, bOpus.calls)), aOpus.avgPromptPerCall ?? Math.round((aOpus.input + aOpus.cacheRead) / Math.max(1, aOpus.calls)), 'num'],
    ['Opus within-5m miss rate (>15K)', bOpus.within5mMissRate ?? (bOpus.calls ? bOpus.within5mMissCalls / bOpus.calls : 0), aOpus.within5mMissRate ?? (aOpus.calls ? aOpus.within5mMissCalls / aOpus.calls : 0), 'pct'],
    ['Opus within-5m miss uncached inp', bOpus.within5mMissInput, aOpus.within5mMissInput, 'num'],
    ['Opus stale live-image miss calls', bOpus.within5mStaleLiveImageCalls ?? bOpus.within5mLiveImageCalls, aOpus.within5mStaleLiveImageCalls ?? aOpus.within5mLiveImageCalls, 'num'],
    ['Opus memory calls', bAux.memory?.calls ?? 0, aAux.memory?.calls ?? 0, 'num'],
    ['Opus compaction calls', bAux.compaction?.calls ?? 0, aAux.compaction?.calls ?? 0, 'num'],
    ['Opus image OCR calls', bAux.image?.calls ?? 0, aAux.image?.calls ?? 0, 'num'],
    ['Haiku optchat calls', before.dsBot.haikuOptchat?.calls ?? 0, after.dsBot.haikuOptchat?.calls ?? 0, 'num'],
    ['Haiku optchat output tokens', before.dsBot.haikuOptchat?.output ?? 0, after.dsBot.haikuOptchat?.output ?? 0, 'num'],
    ['Haiku optchat avg output / call', before.dsBot.haikuOptchat?.avgOutputPerCall ?? 0, after.dsBot.haikuOptchat?.avgOutputPerCall ?? 0, 'num'],
    ...(before.dsBot.solTurns || after.dsBot.solTurns
      ? [
          ['Sol turn calls', before.dsBot.solTurns?.calls ?? 0, after.dsBot.solTurns?.calls ?? 0, 'num'],
          ['Sol turn cache hit ratio', before.dsBot.solTurns?.cacheHitRatio ?? null, after.dsBot.solTurns?.cacheHitRatio ?? null, 'pct'],
          ['Sol avg uncached input / call', before.dsBot.solTurns?.avgUncachedInputPerCall ?? 0, after.dsBot.solTurns?.avgUncachedInputPerCall ?? 0, 'num'],
          ['Sol zero-cache call rate', before.dsBot.solTurns?.crZeroRate ?? 0, after.dsBot.solTurns?.crZeroRate ?? 0, 'pct'],
        ]
      : []),
  ]
  console.log(`Before: ${before.capturedAt} (${before.windowHours}h)  ->  After: ${after.capturedAt} (${after.windowHours}h)\n`)
  console.log('Metric'.padEnd(36), 'Before'.padStart(14), 'After'.padStart(14), 'Delta'.padStart(10))
  console.log('-'.repeat(78))
  for (const [label, a, b, kind] of rows) {
    console.log(label.padEnd(36), fmtValue(a, kind).padStart(14), fmtValue(b, kind).padStart(14), pctDelta(a, b).padStart(10))
  }
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]

if (cmd === 'diff') {
  if (!args._[1] || !args._[2]) {
    usageHelp()
    process.exit(1)
  }
  runDiff(args._[1], args._[2])
} else if (cmd === 'snapshot') {
  const dshHome = args.home ?? process.env.DSH_HOME
  if (!dshHome) {
    console.error('Error: pass --home <DSH_HOME> or set DSH_HOME')
    process.exit(1)
  }
  const nowMs = Date.now()
  const sinceMs = args.since ? Date.parse(args.since) : nowMs - Number(args.hours ?? 24) * 3600 * 1000
  if (!Number.isFinite(sinceMs)) {
    console.error('Error: invalid --since or --hours value')
    process.exit(1)
  }
  const windowHours = Number(((nowMs - sinceMs) / 3600000).toFixed(2))
  const aux = collectAux(join(dshHome, 'bot/usage.sqlite'), sinceMs)
  const turns = collectTurns(join(dshHome, 'sessions'), sinceMs)
  const claudeCodeCli = collectClaudeCli(args['claude-dir'], sinceMs)
  const snapshot = {
    capturedAt: new Date(nowMs).toISOString(),
    sinceIso: new Date(sinceMs).toISOString(),
    windowHours,
    dsBot: {
      opusTurns: turns.opusTurns,
      solTurns: turns.solTurns,
      opusAux: aux.opusAux,
      haikuOptchat: aux.haikuOptchat,
      turnByModel: turns.turnByModel,
      auxByProviderModelKind: aux.auxByProviderModelKind,
    },
    ...(claudeCodeCli === undefined ? {} : { claudeCodeCli }),
  }
  if (args.out) writeFileSync(args.out, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(JSON.stringify({
    capturedAt: snapshot.capturedAt,
    sinceIso: snapshot.sinceIso,
    windowHours: snapshot.windowHours,
    opusTurns: snapshot.dsBot.opusTurns,
    solTurns: snapshot.dsBot.solTurns,
    opusAux: snapshot.dsBot.opusAux,
    haikuOptchat: snapshot.dsBot.haikuOptchat,
    ...(claudeCodeCli === undefined ? {} : { claudeCodeCli }),
  }, null, 2))
} else {
  usageHelp()
  process.exit(1)
}
