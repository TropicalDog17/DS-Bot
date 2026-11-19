import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { linkTarget, linkTexts, textLinks } from '../src/client/text-links.js'

test('a companion\'s links join every Bot bubble, redraw on its word, and leave with it', () => {
  const before = textLinks.getSnapshot()
  let tell
  const entry = { origin: 'https://cards.local/', link: text => text.replace('X', '[X](https://cards.local/x)'), open: () => {}, subscribe: (listener) => { tell = listener; return () => { tell = undefined } } }
  const off = textLinks.add(entry)
  const added = textLinks.getSnapshot()
  assert.deepEqual(added, [...before, entry])
  assert.equal(linkTexts('see X', added), 'see [X](https://cards.local/x)')
  tell()
  assert.notEqual(textLinks.getSnapshot(), added)
  off()
  assert.deepEqual(textLinks.getSnapshot(), before)
  assert.equal(tell, undefined)
})

test('a tap on a companion link names its entry and id; any other tap is not one', () => {
  const entry = { origin: 'https://cards.local/' }
  const anchor = { getAttribute: () => 'https://cards.local/c_1' }
  const on = { target: { closest: selector => (selector === 'a[href^="https://cards.local/"]' ? anchor : null) } }
  assert.deepEqual(linkTarget(on, [entry]), { entry, id: 'c_1' })
  assert.equal(linkTarget({ target: { closest: () => null } }, [entry]), null)
  assert.equal(linkTarget(on, []), null)
})

test('a Bot bubble draws companion links and opens their page on a tap', () => {
  const cells = readFileSync(new URL('../src/client/cells.js', import.meta.url), 'utf8')
  assert.match(cells, /linkMentions\(linkTexts\(shown, links\)/)
  assert.match(cells, /link\.entry\.open\(link\.id\)\s*\n\s*if \(link\.entry\.page\) actions\.openPage\(link\.entry\.page\)/)
})
