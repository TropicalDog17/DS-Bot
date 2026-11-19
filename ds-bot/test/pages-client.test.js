import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
  useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment',
}
const require = (name) => {
  if (name !== 'react') throw new Error(`no platform module ${name}`)
  return react
}
const bundled = async (entry) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require })
  return module.exports
}
const { createPages, PageButtons, PageView } = await bundled('pages.js')
const Icon = () => null
const Page = () => null

test('a companion registers a page, and its disposer takes it back', () => {
  const { source, service } = createPages()
  let changes = 0
  source.subscribe(() => { changes += 1 })
  const offBoard = service.register({ id: 'board', title: ' Board ', icon: Icon, Page, order: 2 })
  service.register({ id: 'notes', title: 'Notes', icon: Icon, Page, order: 1 })
  assert.equal(JSON.stringify(service.list().map(page => [page.id, page.title])), JSON.stringify([['notes', 'Notes'], ['board', 'Board']]))
  assert.throws(() => service.register({ id: 'board', title: 'Again', icon: Icon, Page }), /already registered/)
  offBoard()
  offBoard()
  assert.equal(source.getSnapshot().map(page => page.id).join(), 'notes')
  assert.equal(changes, 3)
})

test('a malformed page is refused', () => {
  const { service } = createPages()
  assert.throws(() => service.register(null), { name: 'TypeError' })
  assert.throws(() => service.register({ id: 'Bad Id', title: 'x', icon: Icon, Page }), { name: 'TypeError' })
  assert.throws(() => service.register({ id: 'ok', title: '  ', icon: Icon, Page }), { name: 'TypeError' })
  assert.throws(() => service.register({ id: 'ok', title: 'x', icon: 'svg', Page }), { name: 'TypeError' })
  assert.equal(service.list().length, 0)
})

test('each page gets one labelled button that opens it', () => {
  const { service } = createPages()
  service.register({ id: 'board', title: 'Board', icon: Icon, Page })
  const opened = []
  const buttons = PageButtons({ pages: service.list(), actions: { openPage: id => opened.push(id) } })
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props['aria-label'], 'Board')
  assert.equal(buttons[0].props['data-page'], 'board')
  assert.equal(buttons[0].children[0].type, Icon)
  buttons[0].props.onClick()
  assert.equal(opened.join(), 'board')
  assert.equal(PageButtons({ pages: [], actions: {} }).length, 0)
})

test('the open page gets the main area edge, its exit flag and a close', () => {
  const { service } = createPages()
  service.register({ id: 'board', title: 'Board', icon: Icon, Page })
  let closed = 0
  const view = PageView({ page: service.list()[0], paneLeft: 280, leaving: false, actions: { closePage: () => { closed += 1 } } })
  assert.equal(view.type, Page)
  assert.equal(view.props.paneLeft, 280)
  assert.equal(view.props.leaving, false)
  view.props.close()
  assert.equal(closed, 1)
})
