import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/composer.ts', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
let hooks = 0
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => { hooks += 1; return [initial, () => {}] },
  useRef: current => { hooks += 1; return { current } },
  useEffect: () => { hooks += 1 },
  useLayoutEffect: () => { hooks += 1 },
  useMemo: make => { hooks += 1; return make() },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { body: {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { ComposerPlus } = module.exports

function render(roster) {
  hooks = 0
  const tree = ComposerPlus({
    sessionId: 'chief', useRoster: select => select(roster),
    useInput: select => select({ phase: 'plain', draft: '', attachmentIds: [], queue: [] }),
    actions: { canReferenceChat: () => false },
  })
  return { tree, hooks }
}

test('the "+" calls the same hooks whether or not its roster knows the Bot yet', () => {
  const roster = { ready: false }
  const unknown = render(roster)
  roster.byId = { chief: { id: 'chief' } }
  const known = render(roster)
  roster.byId = {}
  const forgotten = render(roster)
  assert.equal(unknown.tree, null)
  assert.equal(known.tree.type, 'fragment')
  assert.equal(forgotten.tree, null)
  assert.equal(known.hooks, unknown.hooks)
  assert.equal(forgotten.hooks, unknown.hooks)
})
