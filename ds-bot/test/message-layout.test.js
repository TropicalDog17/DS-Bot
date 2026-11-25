import assert from 'node:assert/strict'
import { test } from 'node:test'
import { flatWidthOf, layoutOf, widthOf } from '../src/client/themes.ts'

test('a layout or width the plugin does not know reads as the default', () => {
  assert.equal(layoutOf(undefined), 'bubble')
  assert.equal(layoutOf({ layout: 'grid' }), 'bubble')
  assert.equal(layoutOf({ layout: 'flat' }), 'flat')
  assert.equal(widthOf({}), 80)
  assert.deepEqual([40, 101, 72.5, 'wide'].map(width => widthOf({ width })), [80, 80, 80, 80])
  assert.deepEqual([50, 95, 100].map(width => widthOf({ width })), [50, 95, 100])
  assert.equal(flatWidthOf({ width: 60 }), 100)
  assert.deepEqual([70, 101].map(flatWidth => flatWidthOf({ flatWidth })), [70, 100])
})
