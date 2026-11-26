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

function composer(boardNote = () => {}) {
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
    useRef: current => ({ current }), useEffect: () => {}, useCallback: fn => fn,
  }
  const modules = { react, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => modules[name], Promise })
  const { CardDetail } = module.exports
  const card = { id: 'card', title: 'Release notes', status: 'active', assignee: 'user', notes: [] }
  const render = () => {
    hook = 0
    const tree = CardDetail({ card, roster: { byId: {}, bots: [] }, actions: { boardNote } })
    const footer = tree.children.find(node => node?.props.className?.includes('bt-board-write'))
    const [box, send, status] = footer.children
    const [count, error] = status.children
    return { box, send, status, count, error }
  }
  const type = value => render().box.props.onChange({ target: { value } })
  const enter = ({ shiftKey = false, isComposing = false } = {}) => {
    const { props } = render().box
    let prevented = false
    props.onKeyDown({ key: 'Enter', shiftKey, nativeEvent: { isComposing }, preventDefault: () => { prevented = true } })
    if (!prevented && !isComposing) type(props.value + '\n')
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

test('Enter sends the note and Shift+Enter keeps a line break', async () => {
  const notes = []
  const response = Promise.withResolvers()
  const message = composer((id, text) => { notes.push([id, text]); return response.promise })
  message.type('first')
  assert.equal(message.enter({ shiftKey: true }), false)
  assert.equal(message.render().box.props.value, 'first\n')
  message.type(message.render().box.props.value + 'second')
  assert.equal(message.enter({ isComposing: true }), false)
  assert.deepEqual(notes, [])
  assert.equal(message.enter(), true)
  assert.deepEqual(notes, [['card', 'first\nsecond']])
  assert.equal(message.render().box.props.value, '')
  message.type('another draft')
  assert.equal(message.render().send.props.disabled, true)
  message.type('')
  response.reject(new Error('Try again'))
  await Promise.resolve()
  assert.equal(message.render().box.props.value, 'first\nsecond')
  assert.equal(message.render().send.props.disabled, false)
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
  assert.equal(message.render().error.children.join(''), 'Too long by 1 characters')
  assert.equal(message.render().send.props.disabled, true)
})
