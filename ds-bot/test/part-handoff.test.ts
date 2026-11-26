import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NOTE_SECTIONS,
  canonicalHeadings,
  carryOriginSource,
  handoffPackage,
  handoffSource,
  noteText,
} from '../src/host/part-handoff.ts'

test('canonicalHeadings normalizes translated headings in section order without rewriting out-of-order notes', () => {
  const names = NOTE_SECTIONS.map(([name]) => name)
  const translated = names.map((_, i) => `## Mục ${i + 1}\n- item ${i + 1}`).join('\n')
  const normalized = canonicalHeadings(translated, names)
  for (const name of names) assert.match(normalized, new RegExp(`^## ${name}$`, 'm'))

  const misordered = '## Progress\n- a\n## Goals\n- b\n## Constraints and preferences\n- c\n## Decisions\n- d\n## Facts to keep\n- e\n## Open threads\n- f\n## Next step\n- g\n## Where to look\n- h'
  assert.equal(canonicalHeadings(misordered, names), misordered)
})

test('noteText formats model notes, whole carryovers, and fallback explanations', () => {
  assert.equal(noteText({ note: 'real note' }), 'real note')
  assert.match(noteText({ fallback: 'whole' }) ?? '', /every message of the part was carried over word for word/)
  assert.match(noteText({ fallback: 'overflow', note: 'prev', noteFrom: 2 }) ?? '', /overflowed the model's window.*part 2.*\n\nprev/s)
  assert.match(noteText({ fallback: 'cutoff' }) ?? '', /cut off at the output limit/)
  assert.match(noteText({ fallback: 'engine' }) ?? '', /what you run on changed/)
})

test('handoffPackage includes reason, engine/folder notices, earlier messages, and resume directive', () => {
  const pkg = handoffPackage({
    segment: { note: '## Goals\n- ship' },
    lines: { recent: ['[part 1 #2 · 10:00] User: hi'], earlier: ['[part 1 #1 · 09:59] User: init'], unlisted: 3, complete: false },
    number: 2,
    resume: true,
    folder: '/repo/work',
    engine: 'Codex',
  })
  assert.match(pkg, /\[Handoff · part 2\]/)
  assert.match(pkg, /You now run on Codex/)
  assert.match(pkg, /You now work in \/repo\/work/)
  assert.match(pkg, /\(3 older messages are not listed\.\)/)
  assert.match(pkg, /could not be read in time/)
  assert.match(pkg, /You were in the middle of a turn/)
})

test('carryOriginSource and handoffSource strip rpcId, propagate imOrigin, and preserve resume info', () => {
  const job: Record<string, any> = {
    resumeOrigin: 'im-origin-1',
    info: { kind: 'bot', role: 'request', exchangeId: 'ex-1', rpcId: 'rpc-1' },
    joined: [{ info: { exchangeId: 'ex-2' }, text: 'also' }],
  }
  const source = handoffSource(job, true)
  assert.equal(source.rpcId, undefined)
  assert.equal(source.imOrigin, 'im-origin-1')
  assert.equal(source.exchangeId, 'ex-1')
  assert.equal(source.handoff, true)
  assert.equal(source.resume, true)
  assert.equal(job.originSent, true)

  const plainJob: Record<string, any> = {}
  const plain = carryOriginSource(plainJob, { kind: 'bot', rpcId: 'drop-me' })
  assert.deepEqual(plain, { kind: 'bot' })
  assert.equal(plainJob.originSent, undefined)
})
