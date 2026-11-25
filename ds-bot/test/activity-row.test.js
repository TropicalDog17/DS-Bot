import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { findHost, rowVisible, freshInputAt } from './src/client/activity-row.js'",
      "export { clientErrors } from './src/client/diagnostics.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: fn => setTimeout(fn, 0),
  cancelAnimationFrame: id => clearTimeout(id),
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { findHost, rowVisible, freshInputAt, clientErrors } = module.exports

test('the activity row mounts at the flow around the running slot, not at the slot', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow id="flow"><div class="wrap"><div data-chat-running id="slot"></div></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'flow')
})

test('the activity row stays after a pending steer echo, and after the message once it commits', () => {
  dom.window.document.body.innerHTML = [
    '<div data-chat-flow id="flow">',
    '<div data-slot="conversation.chat.flow">',
    '<div data-chat-flow-key="u1" data-chat-flow-kind="user" id="first">first message</div>',
    '<div data-chat-running id="slot"></div>',
    '<div data-chat-flow-key="s1" data-chat-flow-kind="steering" id="echo">a steer</div>',
    '</div>',
    '</div>',
  ].join('')
  const doc = dom.window.document
  const row = doc.createElement('div')
  row.className = 'bt-typing'
  findHost().appendChild(row)
  const echo = doc.getElementById('echo')
  const first = doc.getElementById('first')
  assert.ok(echo.compareDocumentPosition(row) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING, 'the pending steer draws above the row')
  assert.ok(first.compareDocumentPosition(echo) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)
  echo.remove()
  const committed = doc.createElement('div')
  committed.id = 'committed'
  committed.setAttribute('data-chat-flow-key', 's1')
  committed.setAttribute('data-chat-flow-kind', 'steering')
  doc.getElementById('slot').before(committed)
  assert.ok(committed.compareDocumentPosition(row) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING, 'the committed steer still draws above the row')
})

test('without the running slot the row mounts at the flow tail', () => {
  dom.window.document.body.innerHTML = '<div data-chat-flow id="flow"><div data-chat-flow-key="1"></div></div>'
  const host = findHost()
  assert.equal(host?.id, 'flow')
})

test('a missing chat flow is reported once per page, not on every retry', () => {
  dom.window.document.body.innerHTML = '<div></div>'
  const before = clientErrors().filter(entry => entry.text.startsWith('activity row:')).length
  assert.equal(findHost(), null)
  assert.equal(findHost(), null)
  const entries = clientErrors().filter(entry => entry.text.startsWith('activity row:'))
  assert.equal(entries.length, before + 1)
  assert.match(entries.at(-1).text, /activity row:/)
})

test('the row shows while a turn runs, also when text streamed before a tool', () => {
  const bot = {}
  const cases = [
    [{ running: true, streaming: false, tools: [], relaying: false, bot }, true],
    [{ running: true, streaming: true, tools: [], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: true, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, true],
    [{ running: false, streaming: false, tools: [{ label: 'x' }], relaying: false, bot }, false],
    [{ running: true, streaming: true, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [{ relay: true }], relaying: true, bot }, false],
    [{ running: true, streaming: false, tools: [], relaying: false }, false],
    [{ running: true, streaming: false, tools: [], relaying: false, room: {} }, true],
  ]
  for (const [input, expected] of cases) assert.equal(rowVisible(input), expected, JSON.stringify(input))
})

test('fresh input ignores queued sends and takes the newest of the rest', () => {
  const submissions = [
    { placement: 'queued', time: 300 },
    { placement: 'steering', time: 100 },
    { placement: 'transcript', time: 200 },
  ]
  assert.equal(freshInputAt(submissions, undefined), 200)
  assert.equal(freshInputAt(submissions, 400), 400)
  assert.equal(freshInputAt(submissions, 50), 200)
  assert.equal(freshInputAt([{ placement: 'queued', time: 300 }], undefined), 0)
  assert.equal(freshInputAt(undefined, 400), 400)
  assert.equal(freshInputAt([], undefined), 0)
})
