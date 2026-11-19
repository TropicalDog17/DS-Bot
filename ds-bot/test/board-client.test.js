import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
  useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment',
}
const require = (name) => {
  const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null } }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const bundled = async (entry) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams })
  return module.exports
}
const { BoardDialog, boardColumns, leadColumn, COLUMNS } = await bundled('board.js')
const plain = value => JSON.parse(JSON.stringify(value))

const all = (node, cls, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), cls, out)
  if ((node.props?.className ?? '').split(' ').includes(cls)) out.push(node)
  for (const child of node.children ?? []) all(child, cls, out)
  return out
}
const find = (node, cls) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (typeof node.type === 'function') return find(node.type(node.props), cls)
  if ((node.props?.className ?? '').split(' ').includes(cls)) return node
  for (const child of node.children ?? []) {
    const found = find(child, cls)
    if (found) return found
  }
  return null
}
const text = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return text(node.type(node.props))
  return (node.children ?? []).map(text).join('')
}

const DAY = 86_400_000
const now = Date.now()
const card = (id, status, extra = {}) => ({ id, title: id, status, assignee: 'user', createdAt: now - DAY, updatedAt: now - DAY, notes: [], links: [], ...extra })

test('the board sorts cards into five columns and keeps old Done and cancelled cards in history', () => {
  const cards = {
    t: card('t', 'todo'), a: card('a', 'active'), r: card('r', 'review'), b: card('b', 'blocked'),
    d1: card('d1', 'done', { doneAt: now - 1000 }), d2: card('d2', 'done', { doneAt: now - 10 * DAY }), x: card('x', 'cancelled'),
  }
  const { columns, history } = boardColumns(cards, now)
  assert.deepEqual(plain(COLUMNS.map(([status]) => columns[status].map(entry => entry.id))), [['t'], ['a'], ['r'], ['b'], ['d1']])
  assert.deepEqual(plain(history.map(entry => entry.id)).sort(), ['d2', 'x'])
  // Review leads, since it is the user's to act on; then blocked.
  assert.equal(leadColumn(columns), 'review')
  assert.equal(leadColumn(boardColumns({ b: card('b', 'blocked'), a: card('a', 'active') }, now).columns), 'blocked')
  assert.equal(leadColumn(boardColumns({}, now).columns), 'todo')
  // At most ten recent Done cards show.
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d${i}`, card(`d${i}`, 'done', { doneAt: now - i * 1000 })]))
  const split = boardColumns(many, now)
  assert.equal(split.columns.done.length, 10)
  assert.equal(split.history.length, 2)
})

test('the Board page shows each card with its ticket key and Vietnamese text intact, and one Add card action', () => {
  const roster = {
    byId: {}, bots: [],
    board: { cards: { k: card('k', 'active', { title: 'Sửa lỗi đăng nhập', key: 'LIFE-782', progress: 'Đang viết test' }), b: card('b', 'blocked', { title: 'Chờ duyệt' }) } },
  }
  const tree = { type: BoardDialog, props: { roster, actions: { closeBoard() {} } }, children: [] }
  const cards = all(tree, 'bt-board-card')
  assert.equal(cards.length, 2)
  assert.match(text(find(tree, 'bt-board-cols')), /LIFE-782Sửa lỗi đăng nhậpĐang viết test/)
  assert.equal(all(tree, 'bt-board-add').length, 1)
  // Each column takes a drop, and on a phone the tabs pick the column that needs the user.
  assert.equal(all(tree, 'bt-board-col').filter(col => col.props.onDrop).length, 5)
  assert.equal(all(tree, 'bt-board-col').find(col => col.props['data-shown']).props['data-status'], 'blocked')
})
