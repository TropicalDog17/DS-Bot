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
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams, Promise })
  return module.exports
}
const { BoardDialog, CardDetail, boardColumns, leadColumn, COLUMNS } = await bundled('board/client/board.js')
const { installBoardPage, boardCall, BOARD_ROUTE } = await bundled('board/client/index.js')
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
  // The three empty columns are bare drop zones; a phone adds cards from one button by the thumb.
  assert.equal(all(tree, 'bt-board-empty').length, 3)
  assert.equal(text(find(tree, 'bt-board-empty')), '')
  assert.equal(all(tree, 'bt-board-fab').length, 1)
  // A card with a link says so.
  const linked = { ...roster, board: { cards: { k: card('k', 'review', { title: 'PR', links: [{ url: 'https://github.com/x/y/pull/1' }] }) } } }
  assert.equal(all({ type: BoardDialog, props: { roster: linked, actions: { closeBoard() {} } }, children: [] }, 'bt-board-has-link').length, 1)
})

test('an open card is a conversation: the user on the right, the Bot\'s replies under its mark, one Message box', () => {
  const bot = { id: 'b', name: 'Writer', color: '#3b82f6' }
  const roster = { byId: { b: bot }, bots: [bot] }
  const talk = card('k', 'active', {
    assignee: 'b',
    notes: [
      { at: now - 3000, by: 'user', text: 'Gọi trước 5h nhé' },
      { at: now - 2000, by: 'b', text: 'Ok, mình gọi lúc 4h.\nXong sẽ báo.' },
      { at: now - 1000, text: 'an older note without by' },
    ],
  })
  const tree = { type: CardDetail, props: { card: talk, roster, actions: {} }, children: [] }
  const messages = all(tree, 'bt-board-msg')
  assert.deepEqual(plain(messages.map(message => message.props['data-by'])), ['user', 'bot', 'user'])
  assert.deepEqual(plain(all(tree, 'bt-board-msg-text').map(text)), ['Gọi trước 5h nhé', 'Ok, mình gọi lúc 4h.\nXong sẽ báo.', 'an older note without by'])
  // The Bot's reply sits under its mark; the user's own messages carry no mark.
  assert.equal(messages[1].children.some(child => child?.props?.bot?.id === 'b'), true)
  assert.equal(messages[0].children.some(child => child?.props?.bot !== undefined), false)
  const box = find(tree, 'bt-board-write')
  assert.equal(box.children[0].props.placeholder, 'Message')
  // A finished card shows the conversation and takes no new message.
  const done = { type: CardDetail, props: { card: { ...talk, status: 'done', result: 'Đã gọi' }, roster, actions: {} }, children: [] }
  assert.equal(all(done, 'bt-board-msg').length, 3)
  assert.equal(find(done, 'bt-board-write'), null)
  // No messages yet, no thread.
  assert.equal(find({ type: CardDetail, props: { card: card('e', 'todo'), roster, actions: {} }, children: [] }, 'bt-board-thread'), null)
  // While the Bot owes an answer, its mark waits under the last message; a finished card shows no wait.
  const asked = { ...talk, awaiting: { botId: 'b', since: now } }
  const waiting = all({ type: CardDetail, props: { card: asked, roster, actions: {} }, children: [] }, 'bt-board-waiting')
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].children.some(child => child?.props?.bot?.id === 'b'), true)
  assert.equal(all({ type: CardDetail, props: { card: { ...asked, status: 'done' }, roster, actions: {} }, children: [] }, 'bt-board-waiting').length, 0)
  assert.equal(all(tree, 'bt-board-waiting').length, 0)
})

// A fake `dsBotPages` seat: what the page registered, and whether it was taken back.
const seat = () => {
  const list = []
  return { list, register: (page) => { list.push(page); return () => { list.splice(list.indexOf(page), 1) } } }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('the page registers in the DS Bot seat only when ds-bot/board answers', async () => {
  const on = seat()
  const stop = installBoardPage(on, { call: async endpoint => (endpoint === 'state' ? { cards: {}, bots: [] } : undefined) })
  await settle()
  assert.deepEqual(plain(on.list.map(page => [page.id, page.title])), [['board', 'Board']])
  assert.equal(typeof on.list[0].icon, 'function')
  stop()
  assert.equal(on.list.length, 0)
  // Plugin off: the route is not there, so nothing shows.
  const off = seat()
  installBoardPage(off, { call: async () => undefined })
  await settle()
  assert.equal(off.list.length, 0)
  // A network failure is tried once more, then left alone.
  const flaky = seat()
  let calls = 0
  installBoardPage(flaky, { retryMs: 0, call: async () => { calls += 1; throw new Error('offline') } })
  await settle(); await settle(); await settle()
  assert.equal(calls, 2)
  assert.equal(flaky.list.length, 0)
})

test('the route client reads the plugin answer, treats the app page as no plugin, and throws refusals', async () => {
  const answer = (status, body) => async (url, init) => {
    assert.equal(url, BOARD_ROUTE)
    assert.deepEqual(JSON.parse(init.body), { endpoint: 'add', payload: { title: 'x' } })
    return { ok: status === 200, json: async () => { if (typeof body === 'string') throw new SyntaxError('html'); return body } }
  }
  assert.deepEqual(plain(await boardCall('add', { title: 'x' }, { fetchImpl: answer(200, { ok: true, value: { cards: {} } }) })), { cards: {} })
  assert.equal(await boardCall('add', { title: 'x' }, { fetchImpl: answer(200, '<!doctype html>') }), undefined)
  assert.equal(await boardCall('add', { title: 'x' }, { fetchImpl: answer(404, {}) }), undefined)
  await assert.rejects(boardCall('add', { title: 'x' }, { fetchImpl: answer(200, { ok: false, error: { code: 'board/refused', message: 'Write a title first.' } }) }), /Write a title first\./)
})
