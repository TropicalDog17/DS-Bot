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
  const platform = { react, 'react-dom': { createPortal: node => node }, '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: ({ text }) => text } }
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
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise })
  return module.exports
}
const { BoardScreen, CardDetail, boardColumns, leadColumn, linkLabel, plainLine, COLUMNS } = await bundled('board/client/board.js')
const { installBoardPage, boardCall, boardWatch, replyNotice, BOARD_ROUTE } = await bundled('board/client/index.js')
const { cardTagRule, cardTagNode, CARD_TAG_ID, linkCards, nameCards, CARD_LINK_ORIGIN } = await bundled('board/client/card-tag.js')
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
  assert.equal(leadColumn(columns), 'review')
  assert.equal(leadColumn(boardColumns({ b: card('b', 'blocked'), a: card('a', 'active') }, now).columns), 'blocked')
  assert.equal(leadColumn(boardColumns({}, now).columns), 'todo')
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
  const tree = { type: BoardScreen, props: { roster, actions: { closeBoard() {} } }, children: [] }
  const cards = all(tree, 'bt-board-card')
  assert.equal(cards.length, 2)
  assert.match(text(find(tree, 'bt-board-cols')), /LIFE-782Sửa lỗi đăng nhậpĐang viết test/)
  assert.equal(all(tree, 'bt-board-add').length, 1)
  assert.equal(all(tree, 'bt-board-col').filter(col => col.props.onDrop).length, 5)
  assert.equal(all(tree, 'bt-board-col').find(col => col.props['data-shown']).props['data-status'], 'blocked')
  assert.equal(all(tree, 'bt-board-empty').length, 3)
  assert.equal(text(find(tree, 'bt-board-empty')), '')
  assert.equal(all(tree, 'bt-board-fab').length, 1)
  const linked = { ...roster, board: { cards: { k: card('k', 'review', { title: 'PR', links: [{ url: 'https://github.com/x/y/pull/1' }] }) } } }
  assert.equal(all({ type: BoardScreen, props: { roster: linked, actions: { closeBoard() {} } }, children: [] }, 'bt-board-has-link').length, 1)
})

test('the Board is a screen, not a dialog: no close button, and a back arrow only with no sidebar beside it', () => {
  const roster = { byId: {}, bots: [], board: { cards: {} } }
  let closed = 0
  const screen = paneLeft => ({ type: BoardScreen, props: { roster, paneLeft, actions: { closeBoard: () => { closed += 1 } } }, children: [] })
  const wide = screen(280)
  const root = find(wide, 'bt-board-page')
  assert.equal(root.props.role, 'region')
  assert.equal(root.props['aria-modal'], undefined)
  assert.equal(all(wide, 'bt-board-close').length, 0)
  assert.equal(all(wide, 'bt-board-back').length, 0)
  const back = all(screen(0), 'bt-board-back')
  assert.equal(back.length, 1)
  assert.equal(back[0].props['aria-label'], 'Back')
  back[0].props.onClick()
  assert.equal(closed, 1)
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
  assert.equal(all(tree, 'bt-board-md').length, 1)
  assert.equal(all(tree, 'bt-board-md')[0].props.className.split(' ').includes('bt-board-msg-text'), true)
  assert.equal(messages[1].children.some(child => child?.props?.bot?.id === 'b'), true)
  assert.equal(messages[0].children.some(child => child?.props?.bot !== undefined), false)
  const box = find(tree, 'bt-board-write')
  assert.equal(box.children[0].props.placeholder, 'Message')
  const done = { type: CardDetail, props: { card: { ...talk, status: 'done', result: 'Đã gọi' }, roster, actions: {} }, children: [] }
  assert.equal(all(done, 'bt-board-msg').length, 3)
  assert.equal(find(done, 'bt-board-write'), null)
  assert.equal(find({ type: CardDetail, props: { card: card('e', 'todo'), roster, actions: {} }, children: [] }, 'bt-board-thread'), null)
  const asked = { ...talk, awaiting: { botId: 'b', since: now } }
  const waiting = all({ type: CardDetail, props: { card: asked, roster, actions: {} }, children: [] }, 'bt-board-waiting')
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].children.some(child => child?.props?.bot?.id === 'b'), true)
  assert.equal(all({ type: CardDetail, props: { card: { ...asked, status: 'done' }, roster, actions: {} }, children: [] }, 'bt-board-waiting').length, 0)
  assert.equal(all(tree, 'bt-board-waiting').length, 0)
})

test('a waiting card shows its Bot at work, and an answer keeps how it got there, folded', () => {
  const bot = { id: 'b', name: 'Writer', color: '#3b82f6' }
  const roster = { byId: { b: bot }, bots: [bot] }
  const asked = card('k', 'active', { assignee: 'b', awaiting: { botId: 'b', since: now }, notes: [{ at: now, by: 'user', text: 'xem log nhé' }] })
  const live = { since: now, steps: [
    { kind: 'think', text: 'Đọc log trước.' },
    { kind: 'tool', tool: 'read_file', target: 'login.log', state: 'done' },
    { kind: 'tool', text: 'Ran npm test', state: 'running' },
  ] }
  const tree = { type: CardDetail, props: { card: asked, roster, actions: {}, live }, children: [] }
  const waiting = find(tree, 'bt-board-waiting')
  assert.deepEqual(plain(all(waiting, 'bt-board-step').map(text)), ['Đọc log trước.', 'Opening a file · login.log', 'Ran npm test'])
  assert.deepEqual(plain(all(waiting, 'bt-board-tool').map(step => step.props['data-state'])), ['done', 'running'])
  assert.equal(all(waiting, 'bt-board-dots').length, 1)
  const woken = { type: CardDetail, props: { card: { ...asked, awaiting: undefined }, roster, actions: {}, live }, children: [] }
  assert.equal(all(find(woken, 'bt-board-waiting'), 'bt-board-step').length, 3)
  const fresh = { type: CardDetail, props: { card: { ...asked, awaiting: undefined, notes: [] }, roster, actions: {}, live }, children: [] }
  assert.equal(all(find(fresh, 'bt-board-waiting'), 'bt-board-step').length, 3)
  assert.equal(all({ type: CardDetail, props: { card: { ...asked, awaiting: undefined }, roster, actions: {} }, children: [] }, 'bt-board-waiting').length, 0)
  assert.equal(all({ type: CardDetail, props: { card: asked, roster, actions: {} }, children: [] }, 'bt-board-trace').length, 0)
  const answered = { ...asked, awaiting: undefined, notes: [...asked.notes,
    { at: now, by: 'b', text: 'Token hết hạn.', trace: { ms: 4000, steps: live.steps.map(step => ({ ...step, state: 'done' })) } },
    { at: now, by: 'b', text: 'Thêm nữa.' }] }
  const done = { type: CardDetail, props: { card: answered, roster, actions: {} }, children: [] }
  const folds = all(done, 'bt-board-fold')
  assert.equal(folds.length, 1)
  assert.equal(folds[0].type, 'details')
  assert.equal(folds[0].props.open, undefined)
  assert.match(text(folds[0].children[0]), /Thought it through/)
  assert.equal(all(folds[0], 'bt-board-step').length, 3)
  assert.equal(all(done, 'bt-board-waiting').length, 0)
  const called = { since: now, steps: [{ kind: 'tool', tool: 'bash', target: 'ls', input: 'command: ls', output: 'a.txt', state: 'done' }] }
  const opened = level => find({ type: CardDetail, props: { card: asked, roster: { ...roster, board: { trace: level } }, actions: {}, live: called }, children: [] }, 'bt-board-tool-fold')
  const fold = opened('thinking')
  assert.equal(fold.type, 'details')
  assert.equal(fold.props.open, undefined)
  assert.equal(text(find(fold, 'bt-board-tool')), 'Running shell commands · ls')
  assert.deepEqual(plain(all(fold, 'bt-board-io').map(text)), ['command: ls', 'a.txt'])
  assert.equal(opened('all').props.open, true)
})

test('the board header picks how much of a Bot\'s work shows', () => {
  const picked = []
  const screen = level => ({ type: BoardScreen, props: { roster: { byId: {}, bots: [], board: { cards: {}, trace: level } }, actions: { boardTrace: value => { picked.push(value) } } }, children: [] })
  const label = find(screen('tools'), 'bt-board-level')
  const select = label.children.find(child => child?.type === 'select')
  assert.equal(select.props.value, 'tools')
  assert.deepEqual(plain(select.children.map(option => option.props.value)), ['off', 'tools', 'thinking', 'all'])
  assert.deepEqual(plain(select.children.map(text)), ['Off', 'Tool calls', 'Thinking', 'All'])
  select.props.onChange({ target: { value: 'all' } })
  assert.deepEqual(picked, ['all'])
  assert.equal(find({ type: BoardScreen, props: { roster: { byId: {}, bots: [], board: { cards: {} } }, actions: {} }, children: [] }, 'bt-board-level'), null)
})

const seat = () => {
  const list = []
  const marks = []
  const alerts = []
  return {
    list, marks, alerts,
    register: (page) => { list.push(page); return () => { list.splice(list.indexOf(page), 1) } },
    mark: (id, on) => { marks.push([id, on]) },
    alert: (id, text, onOpen) => { alerts.push({ id, text, onOpen }) },
  }
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
  const off = seat()
  installBoardPage(off, { call: async () => undefined })
  await settle()
  assert.equal(off.list.length, 0)
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

test('an unread answer marks its card: the answer shows on it, and its column leads on a phone', () => {
  const roster = {
    byId: { b: { id: 'b', name: 'Coder' } }, bots: [{ id: 'b', name: 'Coder' }],
    board: { cards: {
      r: card('r', 'review', { title: 'Release' }),
      k: card('k', 'active', { title: 'Fix login', key: 'LIFE-782', progress: 'Đang viết test', unread: true,
        notes: [{ at: now, by: 'user', text: 'cần log không?' }, { at: now, by: 'b', text: 'Có, thêm log ở redirect.' }] }),
    } },
  }
  const tree = { type: BoardScreen, props: { roster, actions: {} }, children: [] }
  const cards = all(tree, 'bt-board-card')
  const marked = cards.filter(node => node.props['data-unread'])
  assert.equal(marked.length, 1)
  assert.match(text(marked[0]), /Có, thêm log ở redirect\./)
  assert.equal(all(tree, 'bt-board-new').length, 1)
  assert.equal(all(tree, 'bt-board-new')[0].props['aria-label'], 'New reply')
  assert.equal(leadColumn(boardColumns(roster.board.cards).columns), 'active')
  const focused = { type: BoardScreen, props: { roster, actions: {}, focus: 'k' }, children: [] }
  assert.equal(all(focused, 'bt-board-sheet').length, 1)
  assert.equal(all({ type: BoardScreen, props: { roster, actions: {}, focus: 'gone' }, children: [] }, 'bt-board-sheet').length, 0)
})

test('the watch marks the Board button and shows one notice per new answer while the page is closed', async () => {
  const bots = [{ id: 'b', name: 'Coder' }]
  const answered = (at, extra = {}) => card('k', 'active', { title: 'Fix login', key: 'LIFE-782', unread: true, notes: [{ at, by: 'b', text: 'ok' }], ...extra })
  let state = { cards: { k: answered(1) }, bots }
  const on = seat()
  const timers = []
  const live = boardWatch(on, { first: state, call: async () => state, setTimer: (fn, ms) => { timers.push(ms); return timers.length }, clearTimer: () => {} })
  assert.deepEqual(on.marks.at(-1), ['board', true])
  assert.equal(on.alerts.length, 0)
  await live.refresh()
  assert.equal(on.alerts.length, 0)
  state = { cards: { k: answered(2) }, bots }
  await live.refresh()
  await live.refresh()
  assert.equal(on.alerts.length, 1)
  assert.equal(on.alerts[0].id, 'board')
  assert.equal(on.alerts[0].text, 'Coder replied on LIFE-782')
  on.alerts[0].onOpen()
  assert.equal(live.focus(), 'k')
  assert.equal(live.focus(), null)
  const off = live.opened()
  assert.ok(timers.at(-1) < timers[0])
  state = { cards: { k: answered(3) }, bots }
  await live.refresh()
  assert.equal(on.alerts.length, 1)
  const open = timers.at(-1)
  state = { cards: { k: answered(3, { awaiting: { botId: 'b', since: 3 } }) }, bots }
  await live.refresh()
  assert.equal(timers.at(-1), 1000)
  state = { cards: { k: answered(3) }, bots }
  await live.refresh()
  assert.equal(timers.at(-1), open)
  off()
  state = { cards: { k: answered(3, { unread: undefined }) }, bots }
  await live.refresh()
  assert.deepEqual(on.marks.at(-1), ['board', false])
  live.stop()
  assert.equal(replyNotice(card('x', 'todo', { title: 'Viết báo cáo', assignee: 'b', notes: [] }), bots), 'Coder replied on Viết báo cáo')
})

test('a card note in a chat is a tag of the card: the whole note line, after a Bot mention too', () => {
  const rule = cardTagRule()
  assert.equal(rule.id, CARD_TAG_ID)
  const chat = 'Note on card c_bcd80b5f · LIFE-782 "Fix login redirect loop on Safari": Có cần thêm log cho Safari không?'
  const piece = plain(rule.match(chat, 0))
  assert.deepEqual(piece.data, { cardId: 'c_bcd80b5f', key: 'LIFE-782', title: 'Fix login redirect loop on Safari' })
  assert.equal(piece.start, 0)
  assert.equal(chat.slice(piece.end), 'Có cần thêm log cho Safari không?')
  const group = '@Writer Note on card c_0a1b2c3d "Đặt lịch khám răng": gọi trước 5h'
  const there = plain(rule.match(group, 0))
  assert.equal(there.start, '@Writer '.length)
  assert.deepEqual(there.data, { cardId: 'c_0a1b2c3d', title: 'Đặt lịch khám răng' })
  assert.equal(group.slice(there.end), 'gọi trước 5h')
  assert.equal(rule.match(chat, 1), undefined)
  assert.equal(rule.match('a note on card LIFE-782', 0), undefined)
})

test('tapping a card tag opens the Board on that card; a static tag only shows it', () => {
  const shown = []
  const opened = []
  const Tag = cardTagNode(id => shown.push(id))
  const node = { data: { cardId: 'c_bcd80b5f', key: 'LIFE-782', title: 'Fix login redirect loop on Safari' } }
  const tag = Tag({ node, interactive: true, actions: { openPage: id => opened.push(id) } })
  assert.equal(tag.type, 'button')
  assert.equal(text(tag), 'LIFE-782')
  assert.equal(tag.props.title, 'Fix login redirect loop on Safari')
  tag.props.onClick()
  assert.deepEqual(shown, ['c_bcd80b5f'])
  assert.deepEqual(opened, ['board'])
  const still = Tag({ node: { data: { cardId: 'c_1', title: 'Đặt lịch khám răng' } }, interactive: false, actions: {} })
  assert.equal(still.type, 'span')
  assert.equal(text(still), 'Đặt lịch khám răng')
})

test('the card tags come with the page and go with it; the tag leads the page to its card', async () => {
  const on = seat()
  const tags = []
  const stop = installBoardPage(on, {
    call: async endpoint => (endpoint === 'state' ? { cards: {}, bots: [] } : undefined),
    cardTags: ({ rule, Node, botText }) => { const entry = { rule, Node, botText, off: false }; tags.push(entry); return () => { entry.off = true } },
  })
  await settle()
  assert.equal(tags.length, 1)
  assert.equal(tags[0].rule.id, CARD_TAG_ID)
  tags[0].Node({ node: { data: { cardId: 'c_9', title: 'x' } }, interactive: true, actions: { openPage: () => {} } }).props.onClick()
  const page = on.list[0].Page({ close: () => {}, paneLeft: 0, leaving: false })
  stop()
  const focus = typeof page.props.focus === 'function' ? page.props.focus() : page.props.focus
  assert.equal(focus, 'c_9')
  assert.equal(tags[0].off, true)
  const off = seat()
  let asked = 0
  installBoardPage(off, { call: async () => undefined, cardTags: () => { asked += 1 } })
  await settle()
  assert.equal(asked, 0)
})

const known = {
  c_bcd80b5f: { id: 'c_bcd80b5f', key: 'LIFE-782', title: 'Fix login redirect loop on Safari' },
  c_0a1b2c3d: { id: 'c_0a1b2c3d', title: 'Đặt lịch khám răng' },
}

test('a card a Bot names in its text is a link its bubble draws as a tag; code and unknown ids stay', () => {
  const link = id => `${CARD_LINK_ORIGIN}${id}`
  assert.equal(linkCards('收到：Note on card c_bcd80b5f · LIFE-782 "Fix login redirect loop on Safari": ok', known),
    `收到：[LIFE-782](${link('c_bcd80b5f')}) ok`)
  assert.equal(linkCards('Xong c_bcd80b5f · LIFE-782, còn c_0a1b2c3d.', known),
    `Xong [LIFE-782](${link('c_bcd80b5f')}), còn [Đặt lịch khám răng](${link('c_0a1b2c3d')}).`)
  assert.equal(linkCards('c_ffffffff và `c_bcd80b5f`', known), 'c_ffffffff và `c_bcd80b5f`')
  assert.equal(linkCards('```\nc_bcd80b5f\n```', known), '```\nc_bcd80b5f\n```')
  assert.equal(linkCards('no card here', known), 'no card here')
  assert.equal(linkCards('c_00000001', { c_00000001: { id: 'c_00000001', title: 'a [b]' } }), `[a \\[b\\]](${link('c_00000001')})`)
})

test('the Board\'s own lines name a card by its key, not by its note line', () => {
  assert.equal(nameCards('收到：Note on card c_bcd80b5f · LIFE-782 "Fix login redirect loop on Safari": ok', known), '收到：LIFE-782 ok')
  assert.equal(nameCards('xem c_0a1b2c3d', known), 'xem Đặt lịch khám răng')
  assert.equal(nameCards(undefined, known), undefined)
  const cards = { ...known, c_bcd80b5f: card('c_bcd80b5f', 'active', { key: 'LIFE-782', title: 'Fix login redirect loop on Safari', assignee: 'b', unread: true, notes: [{ by: 'b', text: 'Note on card c_bcd80b5f · LIFE-782 "Fix login redirect loop on Safari": đã thêm log', at: now }] }) }
  const screen = BoardScreen({ roster: { bots: [], byId: {}, board: { cards } }, actions: {}, paneLeft: 0, leaving: false })
  assert.ok(all(screen, 'bt-board-progress').some(node => text(node) === 'LIFE-782 đã thêm log'))
})

test('a Bot\'s card links follow the board: a tap opens the Board on the card, and a rename redraws', async () => {
  const on = seat()
  const tags = []
  let view = { cards: { c_bcd80b5f: card('c_bcd80b5f', 'active', { key: 'LIFE-782', title: 'Fix login' }) }, bots: [] }
  const stop = installBoardPage(on, {
    call: async () => view,
    watchMs: 1,
    cardTags: (entry) => { tags.push(entry); return () => {} },
  })
  await settle()
  const { botText } = tags[0]
  assert.equal(botText.origin, CARD_LINK_ORIGIN)
  assert.equal(botText.page, 'board')
  assert.equal(botText.link('c_bcd80b5f'), `[LIFE-782](${CARD_LINK_ORIGIN}c_bcd80b5f)`)
  let redraws = 0
  botText.subscribe(() => { redraws += 1 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(redraws, 0)
  view = { cards: { c_bcd80b5f: card('c_bcd80b5f', 'active', { key: 'LIFE-900', title: 'Fix login' }) }, bots: [] }
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(redraws, 1)
  assert.equal(botText.link('c_bcd80b5f · LIFE-900'), `[LIFE-900](${CARD_LINK_ORIGIN}c_bcd80b5f)`)
  botText.open('c_bcd80b5f')
  const page = on.list[0].Page({ close: () => {}, paneLeft: 0, leaving: false })
  stop()
  const focus = typeof page.props.focus === 'function' ? page.props.focus() : page.props.focus
  assert.equal(focus, 'c_bcd80b5f')
})

test('a Bot\'s answer reads as Markdown in the card and as one plain line on the board', () => {
  const bot = { id: 'b', name: 'Writer', color: '#3b82f6' }
  const cards = { c_bcd80b5f: card('c_bcd80b5f', 'active', { key: 'LIFE-782', title: 'Fix login' }) }
  const talk = card('k', 'review', {
    assignee: 'b', result: '**Done** — see `log.txt`',
    notes: [{ at: now, by: 'b', text: '## Kết quả\n- **Fixed** c_bcd80b5f\n- see [the PR](https://x.test/1)' }],
  })
  let opened
  const tree = { type: CardDetail, props: { card: talk, roster: { byId: { b: bot }, bots: [bot], board: { cards } }, actions: {}, onOpenCard: id => { opened = id } }, children: [] }
  const md = all(tree, 'bt-board-md')
  assert.deepEqual(plain(md.map(text)), ['**Done** — see `log.txt`', `## Kết quả\n- **Fixed** [LIFE-782](${CARD_LINK_ORIGIN}c_bcd80b5f)\n- see [the PR](https://x.test/1)`])
  const detail = find(tree, 'bt-board-detail')
  let stopped = 0
  const anchor = { getAttribute: () => `${CARD_LINK_ORIGIN}c_bcd80b5f` }
  detail.props.onClick({ target: { closest: selector => (selector.includes(CARD_LINK_ORIGIN) ? anchor : null) }, preventDefault: () => { stopped += 1 }, stopPropagation: () => {} })
  assert.equal(opened, 'c_bcd80b5f')
  assert.equal(stopped, 1)
  detail.props.onClick({ target: { closest: () => null }, preventDefault: () => { stopped += 1 } })
  assert.equal(stopped, 1)
  assert.equal(plainLine('## Kết quả\n- **Fixed** the `login` bug\n- see [the PR](https://x.test/1) *now*'), 'Kết quả Fixed the login bug see the PR now')
  assert.equal(plainLine('```js\nrun()\n```'), 'run()')
  assert.equal(plainLine('snake_case and 2 * 3 * 4'), 'snake_case and 2 * 3 * 4')
  assert.equal(plainLine(undefined), undefined)
})

test('a Bot\'s question shows its options as buttons; a tap sends the pick, which stays marked', () => {
  const bot = { id: 'b', name: 'Writer', color: '#3b82f6' }
  const roster = { byId: { b: bot }, bots: [bot], board: { cards: {} } }
  const asking = card('k', 'review', { assignee: 'b', notes: [
    { at: now - 2000, by: 'user', text: 'deploy?' },
    { at: now - 1000, by: 'b', text: 'Which **environment**?', options: ['Staging', 'Production'] },
    { at: now - 500, by: 'b', text: 'Waiting for your pick.' },
  ] })
  const sent = []
  const actions = { boardNote: (id, text) => { sent.push([id, text]); return Promise.resolve() } }
  const tree = { type: CardDetail, props: { card: asking, roster, actions }, children: [] }
  const buttons = all(tree, 'bt-board-option')
  assert.deepEqual(plain(buttons.map(text)), ['Staging', 'Production'])
  assert.equal(buttons.some(button => button.props.disabled), false)
  buttons[1].props.onClick()
  assert.deepEqual(sent, [['k', 'Production']])
  const answered = { ...asking, notes: [...asking.notes, { at: now, by: 'user', text: 'Production' }] }
  const after = all({ type: CardDetail, props: { card: answered, roster, actions }, children: [] }, 'bt-board-option')
  assert.deepEqual(plain(after.map(button => [button.props.disabled, button.props['data-picked'] ?? false])), [[true, false], [true, true]])
  const done = all({ type: CardDetail, props: { card: { ...asking, status: 'done' }, roster, actions }, children: [] }, 'bt-board-option')
  assert.equal(done.every(button => button.props.disabled), true)
})

test('a card\'s links are drawn as the chat draws them, by a short name', () => {
  assert.equal(linkLabel('https://github.com/o/r/pull/7'), 'o/r#7')
  assert.equal(linkLabel('https://github.com/o/r/issues/12#issuecomment-1'), 'o/r#12')
  assert.equal(linkLabel('https://github.com/o/r/commit/abcdef1234567'), 'o/r@abcdef1')
  assert.equal(linkLabel('https://github.com/o/r'), 'o/r')
  assert.equal(linkLabel('https://github.com/o/r/tree/main/src'), 'github.com/o/r/tree/main/src')
  assert.equal(linkLabel('https://www.example.com/'), 'example.com')
  assert.equal(linkLabel('not a url'), 'not a url')
  const linked = card('k', 'active', { links: [{ url: 'https://github.com/o/r/pull/7' }] })
  const tree = { type: CardDetail, props: { card: linked, roster: { byId: {}, bots: [], board: { cards: {} } }, actions: {} }, children: [] }
  assert.deepEqual(plain(all(tree, 'bt-board-link').map(text)), ['[o/r#7](<https://github.com/o/r/pull/7>)'])
})

test('a card that waits on the user leads with what the user must do; its steps and brief fold', () => {
  const roster = { byId: {}, bots: [], board: { cards: {} } }
  const view = c => ({ type: CardDetail, props: { card: c, roster, actions: {} }, children: [] })
  const lines = tree => plain(all(tree, 'bt-board-line').map(text))
  const log = [
    { at: now - 3000, by: 'b', status: 'active', progress: 'starting' },
    { at: now - 2000, by: 'b', status: 'active', progress: 'PR up' },
    { at: now - 1000, by: 'b', status: 'review', progress: 'PR up' },
  ]
  const review = card('k', 'review', { progress: 'PR up', need: 'Merge o/r#7', log })
  const need = find(view(review), 'bt-board-need')
  assert.equal(need.props['data-status'], 'review')
  assert.equal(text(need), 'Merge o/r#7')
  assert.deepEqual(lines(view(review)), ['Merge o/r#7', 'PR up'])
  const older = card('k', 'blocked', { progress: 'Chờ duyệt: merge #1218' })
  assert.equal(text(find(view(older), 'bt-board-need')), 'Chờ duyệt: merge #1218')
  assert.deepEqual(lines(view(older)), ['Chờ duyệt: merge #1218'])
  assert.equal(find(view({ ...review, status: 'active' }), 'bt-board-need'), null)
  const steps = find(view(review), 'bt-board-steps')
  assert.equal(text(find(steps, 'bt-board-steps-toggle')), 'History (2)')
  assert.equal(find(steps, 'bt-board-steps-list'), null)
  assert.equal(find(view(card('k', 'active', { log: log.slice(0, 1) })), 'bt-board-steps'), null)
  const long = find(view(card('k', 'active', { brief: 'Goal.\nContext.\nLimits.\nDone when.\nMore.' })), 'bt-board-brief')
  assert.equal(long.props['data-folded'], true)
  assert.equal(text(find(long, 'bt-more')), 'Show more')
  const short = find(view(card('k', 'active', { brief: 'Merge #1209.' })), 'bt-board-brief')
  assert.equal(short.props['data-folded'], undefined)
  assert.equal(find(short, 'bt-more'), null)
  assert.equal(find(view(card('k', 'active')), 'bt-board-brief'), null)
})

test('a card with herdr panes offers its newest pane as a terminal, closed until opened', () => {
  const roster = { byId: {}, bots: [], board: { cards: {} } }
  const view = c => ({ type: CardDetail, props: { card: c, roster, actions: { boardPane: async () => ({}) } }, children: [] })
  const panes = [{ id: 'w1:p2', at: now - 2000 }, { id: 'w1:p1T', at: now - 1000 }]
  const box = find(view(card('k', 'active', { panes })), 'bt-board-panes')
  const toggle = find(box, 'bt-board-pane-toggle')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(text(toggle), 'Terminalw1:p1T')
  assert.equal(find(box, 'bt-board-term'), null)
  assert.equal(find(box, 'bt-board-pane-pick'), null)
  assert.equal(find(view(card('k', 'active')), 'bt-board-panes'), null)
})
