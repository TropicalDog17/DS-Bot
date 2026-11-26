import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { NOTE_MAX, REPLY_MAX } from '../src/board/cards.ts'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/board/client/board.ts', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function composer(boardNote = () => {}, prefs = {}) {
  let hook = 0
  const state = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    createContext: () => ({}), useContext: () => undefined,
    useState(initial) {
      const slot = hook++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
    },
    useRef(current) { return react.useState({ current })[0] },
    useEffect: () => {}, useLayoutEffect: () => {}, useCallback: fn => fn,
  }
  const modules = { react, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => modules[name], Promise })
  const { CardDetail } = module.exports
  const card = { id: 'card', title: 'Release notes', status: 'active', assignee: 'user', notes: [] }
  const render = () => {
    hook = 0
    const tree = CardDetail({ card, roster: { byId: {}, bots: [], prefs }, actions: { boardNote } })
    const footer = tree.children.find(node => node?.props.className?.includes('bt-board-write'))
    const [box, send, status] = footer.children
    const [count, error] = status.children
    const thread = tree.children[0].children.find(node => node?.props?.notes)
    const pending = thread?.type(thread.props).children.filter(node => node?.props['data-pending']).map(node => (
      node.children[1].children.find(child => child?.props.className === 'bt-board-msg-text').children.join('')
    )) ?? []
    return { box, send, status, count, error, pending }
  }
  const type = value => render().box.props.onChange({ target: { value } })
  const enter = ({ isComposing = false, ...keys } = {}) => {
    const { props } = render().box
    let prevented = false
    props.onKeyDown({ key: 'Enter', ...keys, nativeEvent: { isComposing }, preventDefault: () => { prevented = true } })
    if (!prevented && !isComposing && !keys.ctrlKey && !keys.altKey && !keys.metaKey && keys.keyCode !== 229) type(props.value + '\n')
    return prevented
  }
  return { render, type, enter }
}

test('the card message box is a textarea with no maxlength', () => {
  const notes = []
  const message = composer((id, text) => notes.push([id, text]))
  const empty = message.render()
  assert.equal(empty.box.type, 'textarea')
  assert.equal(empty.box.props.placeholder, 'Message')
  assert.equal(Object.hasOwn(empty.box.props, 'maxLength'), false)
  assert.equal(empty.send.props.disabled, true)
  message.type('\u200b\u00a0')
  assert.equal(message.render().send.props.disabled, true)

  message.type('x'.repeat(18_000))
  assert.equal(message.render().count, null)
  message.type('x'.repeat(18_001))
  assert.equal(message.render().count.children.join(''), '18,001 / 20,000')

  const over = 'x'.repeat(20_003)
  message.type(over)
  const full = message.render()
  assert.equal(full.box.props.value, over)
  assert.equal(full.send.props.disabled, true)
  assert.equal(full.status.props['data-over-limit'], true)
  assert.equal(full.count.children.join(''), '20,003 / 20,000')
  assert.equal(full.error.children.join(''), 'Too long by 3 characters')
  assert.equal(full.error.props['aria-live'], 'polite')
  assert.equal(message.enter(), true)
  assert.deepEqual(notes, [])
})

test('one character over the limit is singular', () => {
  const message = composer()
  message.type('x'.repeat(20_001))
  assert.equal(message.render().error.children.join(''), 'Too long by 1 character')
  message.type('x'.repeat(25_000))
  assert.equal(message.render().error.children.join(''), 'Too long by 5,000 characters')
})

test('Enter sends the note and Shift+Enter keeps a line break', () => {
  const notes = []
  const record = (id, text) => { notes.push([id, text]) }
  const message = composer(record)
  message.type('first')
  assert.equal(message.enter({ shiftKey: true }), false)
  assert.equal(message.render().box.props.value, 'first\n')
  message.type(message.render().box.props.value + 'second')
  for (const keys of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { keyCode: 229 }, { isComposing: true }]) {
    assert.equal(message.enter(keys), false)
  }
  assert.deepEqual(notes, [])
  assert.equal(message.enter(), true)
  assert.deepEqual(notes, [['card', 'first\nsecond']])
  assert.equal(message.render().box.props.value, '')
  const newline = composer(record, { enterToSend: false })
  newline.type('first')
  assert.equal(newline.enter(), false)
  assert.equal(newline.render().box.props.value, 'first\n')
  assert.equal(notes.length, 1)
  newline.type('first\nsecond')
  newline.render().send.props.onClick()
  assert.deepEqual(notes, [['card', 'first\nsecond'], ['card', 'first\nsecond']])
})

test('a second note can be sent while the first one is on its way', async () => {
  const first = Promise.withResolvers()
  const second = Promise.withResolvers()
  const notes = []
  const message = composer((id, text) => {
    notes.push([id, text])
    return text === 'A' ? first.promise : second.promise
  })
  message.type('A')
  assert.equal(message.enter(), true)
  assert.deepEqual(Array.from(message.render().pending), ['A'])
  message.type('B')
  assert.equal(message.render().send.props.disabled, false)
  assert.equal(message.enter(), true)
  assert.deepEqual(notes, [['card', 'A'], ['card', 'B']])
  assert.deepEqual(Array.from(message.render().pending), ['A', 'B'])
  first.resolve()
  await Promise.resolve()
  assert.deepEqual(Array.from(message.render().pending), ['B'])
  second.resolve()
  await Promise.resolve()
  assert.deepEqual(Array.from(message.render().pending), [])
})

test('a refused note comes back into the box', async () => {
  for (const draft of ['', 'a new draft']) {
    const response = Promise.withResolvers()
    const message = composer(() => response.promise)
    const text = '  first\nsecond  '
    message.type(text)
    assert.equal(message.enter(), true)
    assert.equal(message.render().box.props.value, '')
    message.type(draft)
    response.reject(new Error('Try again'))
    await Promise.resolve()
    assert.equal(message.render().box.props.value, draft || text)
    assert.equal(message.render().send.props.disabled, false)
    assert.deepEqual(Array.from(message.render().pending), [])
  }
})

test('a pasted note over the limit is kept whole', () => {
  const message = composer()
  const pasted = '漢🙂'.repeat(12_500)
  message.type(pasted)
  const full = message.render()
  assert.equal(full.box.props.value, pasted)
  assert.equal(full.count.children.join(''), '25,000 / 20,000')
  assert.equal(full.error.children.join(''), 'Too long by 5,000 characters')
  assert.equal(full.send.props.disabled, true)
})

test('the client and the host share one limit', () => {
  assert.equal(NOTE_MAX, 20_000)
  assert.equal(REPLY_MAX, NOTE_MAX)
  const message = composer()
  const atLimit = '漢'.repeat(NOTE_MAX - 1) + '🙂'
  message.type(atLimit + ' \t\n')
  const full = message.render()
  const limit = NOTE_MAX.toLocaleString('en-US')
  assert.equal(full.count.children.join(''), `${limit} / ${limit}`)
  assert.equal(full.send.props.disabled, false)

  message.type(atLimit + '🙂')
  assert.equal(message.render().error.children.join(''), 'Too long by 1 character')
  assert.equal(message.render().send.props.disabled, true)
})
