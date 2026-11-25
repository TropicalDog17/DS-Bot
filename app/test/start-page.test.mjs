import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { START_ACTS } from '../src/start-window.mjs'
import { TEXT, t } from '../src/start/text.mjs'

const dir = new URL('../src/start/', import.meta.url)
const read = name => readFileSync(new URL(name, dir), 'utf8')
const SCRIPTS = ['start.js', 'whale.js', 'text.mjs']
const html = read('start.html')
const code = Object.fromEntries(SCRIPTS.map(name => [name, read(name)]))
const uncommented = text => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, '')

test('the start page runs under its CSP: no inline style or script, no data: or network URLs', () => {
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'">`), 'the CSP meta is missing or changed')
  const rules = [
    [/<style[\s>]/iu, '<style> element'],
    [/\sstyle\s*=/iu, 'style= attribute'],
    [/\son[a-z]+\s*=/iu, 'on* handler attribute'],
    [/<script(?![^>]*\ssrc=)[^>]*>/iu, 'inline <script>'],
    [/data:/iu, 'data: URL'],
    [/https?:/iu, 'http(s): URL'],
  ]
  for (const [pattern, what] of rules) assert.doesNotMatch(html, pattern, `start.html: ${what}`)
  for (const name of ['start.css', ...SCRIPTS]) {
    const body = uncommented(read(name))
    assert.doesNotMatch(body, /url\(\s*['"]?(?:data:|https?:)|@import/iu, `${name}: external or data: resource`)
    assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u, `${name}: markup or code from strings`)
  }
})

test('every file the page loads is relative and inside src/start', () => {
  const inside = (from, url) => {
    assert.doesNotMatch(url, /^(?:[a-z][\w+.-]*:|\/|\\)|\.\./iu, `${from} loads ${url}`)
    assert.ok(existsSync(new URL(url, dir)), `${from} loads ${url}, which is missing`)
  }
  const loads = [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/gu)].map(match => match[1])
  assert.deepEqual(loads, ['start.css', 'start.js'])
  assert.match(html, /<script type="module" src="start.js"><\/script>/u)
  for (const url of loads) inside('start.html', url)
  for (const [name, text] of Object.entries(code)) {
    const body = uncommented(text)
    assert.doesNotMatch(body, /\bimport\s*\(/u, `${name}: a dynamic import`)
    for (const match of body.matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gmu)) inside(name, match[1] ?? match[2])
  }
  for (const [, url] of uncommented(read('start.css')).matchAll(/url\(\s*['"]?([^'")#][^'")]*)/gu)) inside('start.css', url)
})

test('the page binds window.dsBotStart through onState and act only', () => {
  const used = new Set([...code['start.js'].matchAll(/\bbridge\??\.(\w+)/gu)].map(match => match[1]))
  assert.deepEqual([...used].sort(), ['act', 'onState'])
  assert.match(code['start.js'], /const bridge = window\.dsBotStart\b/u)
})

test('the page sends only the acts of the start window', () => {
  const local = new Set(['toggleDetails', 'toggleMore', 'toggleModels'])
  const sent = new Set([
    ...[...html.matchAll(/data-act="(\w+)"/gu)].map(match => match[1]),
    ...[...code['start.js'].matchAll(/\bact: '(\w+)'|\bact\('(\w+)'/gu)].map(match => match[1] ?? match[2]),
    ...[...code['whale.js'].matchAll(/\bact\('(\w+)'\)/gu)].map(match => match[1]),
  ].filter(name => !local.has(name)))
  assert.deepEqual([...sent].sort(), ['answer', 'copyDetails', 'freshStart', 'handoffDone', 'handoffShow', 'importModel', 'importOption', 'installUpdate', 'manualDownload', 'painted', 'pick', 'reloadView', 'retry', 'saveLog', 'wait'])
  for (const name of START_ACTS) assert.ok(sent.has(name), `the main process takes ${name}, which the page never sends`)
})

test('the start page draws the progress as a ring of three or four arcs and a closing circle', () => {
  const arcs = [...html.matchAll(/<g class="arc" data-phase="(\w+)" data-state="pending">(.*?)<\/g>/gu)]
  assert.deepEqual(arcs.map(match => match[1]), ['data', 'engine', 'team', 'import'])
  const point = (deg) => {
    const a = (deg * Math.PI) / 180
    return [110 + 106 * Math.cos(a), 110 + 106 * Math.sin(a)]
  }
  const layout = [[0, 3], [1, 3], [2, 3], [1, 4]]
  arcs.forEach(([, , arc], k) => {
    const [at, n] = layout[k]
    const span = 360 / n
    const paths = [...arc.matchAll(/<path class="(arc-[a-z]+)" d="([^"]+)" pathLength="100"\/>/gu)]
    assert.deepEqual(paths.map(match => match[1]), ['arc-base', 'arc-fill', 'arc-glow'], `arc ${String(k)}`)
    const d = paths[0][2]
    for (const match of paths) assert.equal(match[2], d, `arc ${String(k)}: its three paths differ`)
    const [x0, y0, rx, ry, , large, sweep, x1, y1] = d.match(/-?\d+(?:\.\d+)?/gu).map(Number)
    assert.deepEqual([rx, ry, large, sweep], [106, 106, 0, 1], `arc ${String(k)}: not a clockwise arc of radius 106`)
    const near = ([px, py], [qx, qy]) => Math.abs(px - qx) < 0.01 && Math.abs(py - qy) < 0.01
    assert.ok(near([x0, y0], point(-90 + at * span + 5)), `arc ${String(k)} starts elsewhere`)
    assert.ok(near([x1, y1], point(-90 + (at + 1) * span - 5)), `arc ${String(k)} ends elsewhere`)
  })
  assert.match(read('start.css'), /\.ring:not\(\[data-n="4"\]\) \.arc\[data-phase=import\]\{display:none\}/u)
  const source = code['whale.js']
  const arcD = source.match(/^export function arcD\(from, to\) \{$[\s\S]*?^\}$/mu)[0].replace('export ', '')
  const arcPathOf = source.match(/^export const arcPath = .*$/mu)[0].replace('export ', '')
  const arcPath = new Function(`${arcD}\n${arcPathOf}\nreturn arcPath`)()
  assert.equal(arcPath(0, 3), arcs[0][2].match(/d="([^"]+)"/u)[1])
  assert.equal(arcPath(2, 3), arcs[2][2].match(/d="([^"]+)"/u)[1])
  assert.equal(arcPath(1, 4), arcs[3][2].match(/d="([^"]+)"/u)[1])
  assert.match(html, /<li class="station" data-phase="data"[^>]*>.*\r?\n<li class="station" data-phase="import" data-state="pending" hidden>.*\r?\n<li class="station" data-phase="engine"/u)
  assert.equal(html.match(/<circle class="ring-full" cx="110" cy="110" r="106" pathLength="100" transform="rotate\(-90 110 110\)"\/>/gu)?.length, 1)
  assert.match(html, /<div class="pond">\r?\n<svg class="ring"[\s\S]*?<div class="water"[\s\S]*?<div class="lane">[\s\S]*?<span class="spout"><svg class="plume"[^>]*\shidden>[\s\S]*?<div class="whale-hit"[\s\S]*?<div class="fx" aria-hidden="true"><span class="ripple"><\/span><\/div>\r?\n<\/div>/u)
  assert.doesNotMatch(html, /class="(?:trace|elapsed)"/u)
  assert.match(html, /<\/main>\r?\n<div class="flight" aria-hidden="true"><\/div>/u)
  assert.match(code['whale.js'], /act\('handoffShow', \{ whale: \{ x: box\.left, y: box\.top - LIFT, size: box\.width \} \}\)/u)
  assert.doesNotMatch(read('start.css'), /\.(?:trace|elapsed)\b/u)
})

// A round cap is drawn wherever a dash touches its path, even a dash of no length: an empty arc
// must keep every dash off its path (pathLength 100), or it leaves a dot at one of its ends.
test('an empty or hidden arc leaves no dot: no dash touches its path', () => {
  const css = uncommented(read('start.css'))
  const rule = selector => css.split('}').map(part => part.trim().split('{')).find(([head]) => head === selector)?.[1] ?? ''
  const dashes = (body) => {
    const [dash, gap] = body.match(/stroke-dasharray:([\d.]+) ([\d.]+)/u).slice(1).map(Number)
    return { dash, gap }
  }
  const offsetOf = body => Number(body.match(/stroke-dashoffset:(-?[\d.]+)/u)[1])
  const touches = ({ dash, gap }, offset) => {
    for (let k = -3; k <= 3; k += 1) {
      const start = -offset + k * (dash + gap)
      if (start <= 100 && start + dash >= 0) return true
    }
    return false
  }
  const fill = rule('.arc-fill')
  const glow = rule('.arc-glow')
  const full = rule('.ring-full')
  const base = rule('.arc-base')
  assert.equal(touches(dashes(fill), offsetOf(fill)), false, 'an empty fill touches its arc')
  assert.equal(touches(dashes(full), offsetOf(full)), false, 'the closing circle touches the ring before it closes')
  assert.equal(touches(dashes(glow), offsetOf(glow)), false, 'the resting glow touches its arc')
  const run = css.match(/@keyframes bt-arc\{from\{stroke-dashoffset:(-?[\d.]+)\}to\{stroke-dashoffset:(-?[\d.]+)\}\}/u).slice(1).map(Number)
  for (const at of run) assert.equal(touches(dashes(glow), at), false, `the glow touches its arc at ${String(at)}`)
  const draw = Number(css.match(/@keyframes bt-ring-draw\{from\{stroke-dashoffset:(-?[\d.]+)\}\}/u)[1])
  assert.equal(touches(dashes(base), draw), false, 'the ring touches its arcs before it draws in')
  const share = css.match(/\.arc\[data-phase=import\]:is\(\[data-state=active\],\[data-state=failed\]\) \.arc-fill\{stroke-dashoffset:calc\(([\d.]+) - var\(--f,0\) \* ([\d.]+)\)/u).slice(1).map(Number)
  assert.equal(touches(dashes(fill), share[0]), false, 'an empty import arc touches its arc')
  assert.equal(share[0] - share[1], 0, 'a full import arc is not whole')
  assert.equal(touches(dashes(fill), 0), true)
  assert.equal(touches(dashes(base), offsetOf(base)), true)
})

test('every stage is seen active before it fills, even one done before the page painted or while a card waited', () => {
  const whale = code['whale.js']
  const legs = whale.slice(whale.indexOf('async function runLegs()'), whale.indexOf('function failStation()'))
  assert.match(legs, /while \(D\.at < want\.station && want\.view !== 'handoff'\) \{[\s\S]*?if \(!resume && !failure\(\) && stationEl\(i\)\.dataset\.state === 'pending'\) \{\s*clearTimeout\(activeTimer\)\s*showActive\(i\)/u)
  assert.doesNotMatch(legs, /if \(!ran\) \{/u, 'only the first stage gets its turn')
  assert.match(whale, /if \(holding\(\)\) station = Math\.min\(station, 1\)/u)
  assert.match(whale, /\(holding\(\) && i >= 1\)\) return/u)
  const handoff = whale.slice(whale.indexOf('async function handoff()'), whale.indexOf('root.dataset.ring = \'closed\''))
  assert.match(handoff, /if \(!resume && first && D\.checks === t && stationEl\(t\)\.dataset\.state === 'pending'\) \{\s*D\.handing = true\s*showActive\(t\)\s*await sleep\(HOLD\)/u)
  assert.match(legs, /await hold\(Math\.max\(D\.activeAt\[i\] \? D\.activeAt\[i\] \+ HOLD : 0/u)
  assert.match(whale, /const HOLD = 420\b/u)
  assert.match(whale, /async function step\(\) \{\s*await entered/u)
})

test('the whale\'s entrance waits until the window is on screen', () => {
  const page = code['start.js']
  assert.match(page, /if \(bridge && !resume\) \{\s*root\.dataset\.held = ''/u)
  assert.match(page, /if \(next\.shown\) release\(\)/u)
  assert.match(page, /createDirector\(\{ start: START, resume, begin,/u)
  assert.match(read('start.css'), /html\[data-held\] \*\{animation-play-state:paused!important\}/u)
  const whale = code['whale.js']
  assert.match(whale, /const entered = begun\.then\(\(\) => sleep\(entranceMs\)\)/u)
  assert.match(whale, /begun\.then\(\(\) => sleep\(resume \? 0 : 700\)\)/u)
})

test('the footer is the place line alone, centred with a grey button, on first and later starts', () => {
  assert.match(html, /<footer class="footrow"><p class="place" hidden><span class="place-text"><\/span><button class="btn" data-look="small" data-act="pick" data-detail="changePlace" data-t="btn.changePlace"><\/button><\/p><\/footer>/u)
  assert.ok(!('foot.community' in TEXT), 'the community note is back')
  const css = read('start.css')
  assert.match(css, /\.footrow\{[^}]*justify-content:center/u)
  assert.match(css, /html\[data-start=moving\] \.footrow\{display:none\}/u)
  assert.doesNotMatch(css, /data-start=later[^{]*\.footrow/u)
  assert.doesNotMatch(css, /\.note\b/u)
  assert.match(code['start.js'], /const on = START !== 'moving' && place !== null/u)
  assert.match(html, /<section class="card" data-kind="move" hidden>.*?data-t="say\.move".*?data-t="card\.move\.lead".*?data-detail="move" data-t="btn\.move".*?data-act="pick" data-t="btn\.repick".*?data-detail="cancel" data-t="btn\.cancel".*?<\/section>/u)
})

const cardOf = kind => html.match(new RegExp(`<section class="card" data-kind="${kind}" hidden>.*?</section>`, 'u'))?.[0] ?? ''
const recovers = (card, kind) => {
  for (const act of ['copyDetails', 'saveLog', 'toggleDetails']) assert.match(card, new RegExp(`data-act="${act}"`, 'u'), `${kind}: no ${act}`)
  assert.match(card, /<div class="log" hidden><pre><\/pre><\/div>/u, `${kind}: no log to fold out`)
}

test('the failure page says what happened, what to do for each reason, and folds out the log', () => {
  const card = cardOf('failed')
  assert.match(card, /<p class="lead" data-t="reason\.start\.\{reason\}"><\/p><p class="small do" data-t="card\.failed\.do\.\{reason\}"><\/p>/u)
  for (const reason of ['permission', 'space', 'files', 'engine', 'missing', 'other']) assert.ok(`card.failed.do.${reason}` in TEXT, reason)
  assert.match(card, /data-act="retry" data-main/u)
  recovers(card, 'failed')
})

test('the team view that did not load says what happened and what to do, and folds out the log', () => {
  const card = cardOf('viewFailed')
  assert.match(card, /<p class="lead" data-t="card\.viewFailed\.lead"><\/p><p class="small do" data-t="card\.viewFailed\.do"><\/p>/u)
  assert.match(card, /data-look="primary" data-act="reloadView"/u)
  recovers(card, 'viewFailed')
})

test('a failed copy says what happened and what to do, retries or starts without the team, and folds out the log', () => {
  const card = cardOf('importFailed')
  assert.match(card, /<p class="lead" data-t="card\.importFailed\.lead"><\/p><p class="small do" data-t="card\.importFailed\.do"><\/p>/u)
  assert.match(card, /data-look="primary" data-act="answer" data-detail="retry".*?data-act="answer" data-detail="startWithout"/u)
  recovers(card, 'importFailed')
})

test('a move that does not go through has one card with three variants', () => {
  const card = html.match(/<section class="card" data-kind="moveFailed" hidden>.*?<\/section>/u)?.[0]
  assert.ok(card, 'the moveFailed card is missing')
  assert.match(card, /data-t="say\.moveFailed"/u)
  assert.match(card, /<span data-why="place" data-t="reason\.place\.\{place\}"><\/span><span data-why="inUse" data-t="card\.moveFailed\.inUse"><\/span><span data-why="copy" data-t="card\.moveFailed\.copy"><\/span> <span data-t="card\.moveFailed\.stay"><\/span>/u)
  assert.match(card, /data-detail="retry" data-why="copy" data-t="btn\.retry".*?data-detail="old" data-old data-t="btn\.startOld".*?data-act="toggleDetails" data-why="copy"/u)
  assert.match(code['start.js'], /node\.hidden = node\.dataset\.why !== s\.card\?\.why/u)
  assert.match(code['start.js'], /if \(name === 'moveFailed'\) el\.querySelector\('\[data-old\]'\)\.dataset\.look = s\.card\?\.why === 'copy' \? 'soft' : 'primary'/u)
})

const LAYERS = ['voice', 'say', 'hint', 'card', 'reason', 'btn', 'note', 'foot', 'status', 'dialog', 'picker']
const layerOf = key => key.split('.')[0]
const PLACEHOLDER = /\{(\w+)(?:\|[^}]*)?\}/gu

test('every text key starts with one of the eleven layers', () => {
  for (const key of Object.keys(TEXT)) assert.ok(LAYERS.includes(layerOf(key)), `${key}: unknown layer`)
})

test('the whale and the hint row have only the lines for when the user is needed', () => {
  const layer = name => Object.keys(TEXT).filter(key => layerOf(key) === name).sort()
  assert.deepEqual(layer('voice'), ['voice.failed', 'voice.viewFailed', 'voice.watchdog'])
  assert.deepEqual(layer('hint'), ['hint.space'])
  assert.ok(!('status.elapsed' in TEXT), 'the elapsed clock is back')
})

test('each layer ends its lines as its rule says', () => {
  const BARE = new Set(['voice', 'say', 'hint', 'btn', 'foot', 'status', 'picker'])
  const NOT_SENTENCES = new Set([
    'card.update.slow', 'card.update.downloading', 'dialog.pickRoot', 'dialog.pickMove', 'dialog.pickCookies', 'dialog.saveAs', 'dialog.saveLog',
    'card.import.line', 'card.import.model', 'card.import.optRegen', 'card.import.optSkipWork',
  ])
  for (const [key, text] of Object.entries(TEXT)) {
    if (BARE.has(layerOf(key))) {
      assert.doesNotMatch(text, /\.$/u, `${key}: ends with a full stop`)
    } else if (key.startsWith('reason.copy.')) {
      assert.doesNotMatch(text, /[.?!,]$/u, `${key}: a fragment ends with punctuation`)
    } else if (!NOT_SENTENCES.has(key)) {
      const end = layerOf(key) === 'reason' || layerOf(key) === 'note' ? /\.$/u : /[.?]$/u
      assert.match(text, end, `${key}: not a whole sentence`)
    }
    if (['dialog.pickRoot', 'dialog.pickMove', 'dialog.pickCookies', 'dialog.saveAs', 'dialog.saveLog'].includes(key)) {
      assert.doesNotMatch(text, /\.$/u, `${key}: a picker title ends with a full stop`)
    }
  }
})

test('a button that opens the system picker ends with …', () => {
  const picks = [...html.matchAll(/<button\b[^>]*>/gu)].map(match => match[0]).filter(tag => tag.includes('data-act="pick"'))
  assert.ok(picks.length > 0)
  for (const tag of picks) {
    const key = tag.match(/data-t="([^"]+)"/u)?.[1]
    assert.ok(key !== undefined, `a pick button without text: ${tag}`)
    assert.match(TEXT[key], /…$/u, `${key}: a pick button`)
  }
})

test('every text key that the page uses exists', () => {
  const keys = Object.keys(TEXT)
  const matching = pattern => keys.filter(key => new RegExp(`^${pattern.replaceAll('.', '\\.').replace(/\{\w+\}/gu, '\\w+')}$`, 'u').test(key))
  for (const [, key] of html.matchAll(/data-t(?:-label)?="([^"]+)"/gu)) assert.ok(matching(key).length > 0, `start.html: unknown text key ${key}`)
  const literal = new RegExp(`^(?:${LAYERS.join('|')})\\.[\\w.]+$`, 'u')
  for (const name of ['start.js', 'whale.js']) {
    const text = uncommented(code[name])
    const used = [
      ...[...text.matchAll(/'([\w.]+)'/gu)].map(match => match[1]).filter(key => literal.test(key)),
      ...[...text.matchAll(/\b(?:say|label)\('([\w.]+)'/gu)].map(match => match[1]),
    ]
    for (const key of used) assert.ok(key in TEXT, `${name}: unknown text key ${key}`)
    for (const [, prefix] of text.matchAll(/`([\w.]+\.)\$\{/gu)) assert.ok(keys.some(key => key.startsWith(prefix)), `${name}: no text key starts with ${prefix}`)
  }
  for (const key of ['voice.failed', 'voice.viewFailed', 'voice.watchdog', 'status.phase.data', 'status.phase.import', 'status.phase.engine', 'status.phase.team', 'status.state.pending', 'status.state.active', 'status.state.done', 'status.state.failed']) assert.ok(key in TEXT, key)
  assert.deepEqual(matching('reason.start.{reason}').sort(), ['reason.start.engine', 'reason.start.files', 'reason.start.missing', 'reason.start.other', 'reason.start.permission', 'reason.start.space'])
  assert.deepEqual(matching('reason.place.{reason}').sort(), ['reason.place.drive', 'reason.place.dsh', 'reason.place.foreign', 'reason.place.nested', 'reason.place.onedrive', 'reason.place.permission', 'reason.place.program', 'reason.place.space', 'reason.place.workspace'])
  assert.deepEqual(matching('reason.copy.{reason}').sort(), ['reason.copy.full', 'reason.copy.inUse', 'reason.copy.other', 'reason.copy.permission'])
})

test('the main process uses only keys of the table and keeps no table of its own', () => {
  const src = new URL('../src/', import.meta.url)
  const files = Object.fromEntries(['main.mjs', 'first-run.mjs', 'updates.mjs'].map(name => [name, uncommented(readFileSync(new URL(name, src), 'utf8'))]))
  for (const [name, text] of Object.entries(files)) {
    const used = [
      ...[...text.matchAll(/\btx\(\s*'([^']+)'/gu)].map(match => match[1]),
      ...[...text.matchAll(/'((?:dialog|btn)\.[\w.]+)'/gu)].map(match => match[1]),
    ]
    for (const key of used) assert.ok(key in TEXT, `${name}: unknown text key ${key}`)
  }
  assert.match(files['main.mjs'], /\btx\('dialog\./u)
  assert.match(files['first-run.mjs'], /\btx\('dialog\./u)
  for (const name of ['first-run.mjs', 'updates.mjs']) {
    assert.doesNotMatch(files[name], /\b(?:en|zh)\s*:\s*\{/u, `${name}: a string table`)
    assert.doesNotMatch(files[name], /[㐀-鿿]/u, `${name}: Chinese copy outside text.mjs`)
  }
})

test('t fills placeholders and falls back to the key', () => {
  assert.equal(t('hint.space', { drive: 'C', free: '1.2 GB' }), 'Only 1.2 GB left on drive C')
  assert.equal(t('btn.useRec', { rec: 'D' }), 'Put it on drive D')
  assert.equal(t('btn.retry'), 'Try again')
  assert.equal(t('hint.space', { drive: 'C' }), 'Only {free} left on drive C')
  assert.equal(t('no.such.key'), 'no.such.key')
})

test('t picks the English singular or plural by the value', () => {
  assert.equal(t('card.import.line', { bots: 1, groups: 6 }), 'Found your old team: 1 Bot, 6 group chats')
  assert.equal(t('card.import.line', { bots: 6, groups: 1 }), 'Found your old team: 6 Bots, 1 group chat')
  assert.equal(t('card.import.line', { bots: 1 }), 'Found your old team: 1 Bot, {groups|group chat|group chats}')
})

test('the generated blocks of the start page are current', () => {
  const script = fileURLToPath(new URL('../scripts/start-assets.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
