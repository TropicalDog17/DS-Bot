import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/feedback.ts', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const ISSUES = 'https://github.com/Fei2411/DS-Bot/issues/new'

function page(window) {
  const notes = []
  const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: initial => [initial, (next) => { if (typeof next === 'string') notes.push(next) }],
    useEffect: () => {},
    useRef: current => ({ current }),
    useLayoutEffect: () => {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, window, URL, URLSearchParams, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`no platform module ${name}`)
    },
  })
  const actions = { diagnostics: async () => ({ markdown: '| DS Bot | 0.1.6 |', issuesUrl: ISSUES, entries: [], total: 0 }) }
  let pending
  const run = (promise) => { pending = promise; return promise }
  const tree = module.exports.FeedbackPage({ actions, run, Section: 'section', Row: 'row' })
  const find = node => (Array.isArray(node) ? node.flatMap(find) : node && typeof node === 'object' ? [...(node.props?.className === 'bt-fb-primary' ? [node] : []), ...find(node.children)] : [])
  return {
    notes,
    report: async () => {
      find(tree)[0].props.onClick()
      await pending
    },
  }
}

test('on the Desktop, "Report on GitHub" hands the issue address to the system browser', async () => {
  const opened = []
  const window = { dshDesktop: { protocolVersion: 1 }, open: (url = '') => { opened.push(String(url)); return null } }
  const { notes, report } = page(window)
  await report()
  assert.equal(opened.length, 1)
  assert.ok(opened[0].startsWith(`${ISSUES}?template=bug.yml`))
  assert.equal(notes.some(note => /blocked the new window/.test(note)), false)
  assert.ok(notes.includes('Opened a new GitHub issue with the diagnostics filled in. Check it before you submit.'))
})

test('in a browser, the window reserved in the click gets the issue address', async () => {
  const reserved = { location: { href: '' } }
  const window = { open: () => reserved }
  const { notes, report } = page(window)
  await report()
  assert.equal(reserved.opener, null)
  assert.ok(reserved.location.href.startsWith(`${ISSUES}?template=bug.yml`))
  assert.ok(notes.includes('Opened a new GitHub issue with the diagnostics filled in. Check it before you submit.'))
})

test('in a browser that blocks the window, the page offers the link instead', async () => {
  const { notes, report } = page({ open: () => null })
  await report()
  assert.ok(notes.includes('The browser blocked the new window.'))
  assert.ok(notes.some(note => note.startsWith(`${ISSUES}?template=bug.yml`)))
})

test('a page\'s notice offers Open, which leads to that page; a failure still offers Details', () => {
  const react = {
    createContext: initial => ({ value: initial, Provider: ({ children }) => children }), useContext: ctx => ctx.value,
    useMemo: make => make(), useCallback: fn => fn, useId: () => 'id', useSyncExternalStore: (s, get) => get(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment', useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, window: {}, URL, URLSearchParams, setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : {}),
  })
  const calls = []
  const actions = { dismissToast: token => calls.push(['dismiss', token]), openPage: id => calls.push(['page', id]), openSettings: id => calls.push(['settings', id]) }
  const toast = value => module.exports.ErrorToast({ useUi: pick => pick({ toast: value }), actions })
  const links = node => node.children.filter(child => child?.props?.className === 'bt-toast-link')
  const notice = toast({ text: 'Coder replied on LIFE-782', token: 7, page: 'board', onOpen: () => calls.push(['focus']) })
  assert.equal(notice.props['data-kind'], 'page')
  assert.equal(links(notice)[0].children.join(''), 'Open')
  links(notice)[0].props.onClick()
  assert.deepEqual(calls, [['dismiss', 7], ['focus'], ['page', 'board']])
  const failure = toast({ text: 'Request failed', token: 8 })
  assert.equal(failure.props['data-kind'], undefined)
  assert.equal(links(failure)[0].children.join(''), 'Details')
})
