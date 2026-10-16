// Test runner: node --import tsx/esm --test tests/color-core-axis.test.mjs
//
// The color column's axis runs from layer 0 (the base) to the top layer of
// the current heightmap, not to the highest band.

import test from 'node:test'
import assert from 'node:assert/strict'
import { colorCoreLayerAt, colorCoreLayerY, colorCoreTopLayer, getStackSegments } from '../src/lib/colorStack.ts'

test('the axis top is the heightmap top, not the highest band', () => {
  // Bands end at layer 30, the heightmap reaches 52.
  assert.equal(colorCoreTopLayer(52, [10, 30]), 52)
  // A band above the print's top doesn't stretch the axis.
  assert.equal(colorCoreTopLayer(40, [10, 75]), 40)
})

test('without a heightmap range the highest band is the top', () => {
  assert.equal(colorCoreTopLayer(0, [12, 31]), 31)
  assert.equal(colorCoreTopLayer(Number.NaN, []), 1)
})

test('layer positions cover 0..top with the base at the bottom', () => {
  // 11 rows of 10px for layers 0..10.
  assert.equal(colorCoreLayerY(10, 10, 110), 5)
  assert.equal(colorCoreLayerY(0, 10, 110), 105)
  // Outside the axis: pinned to its ends.
  assert.equal(colorCoreLayerY(14, 10, 110), 5)
  assert.equal(colorCoreLayerAt(0, 10, 110), 0)
  assert.equal(colorCoreLayerAt(109, 10, 110), 10)
  assert.equal(colorCoreLayerAt(55, 10, 110), 5)
  // A point and the layer drawn there agree.
  for (let layer = 0; layer <= 10; layer++) assert.equal(colorCoreLayerAt(110 - colorCoreLayerY(layer, 10, 110), 10, 110), layer)
})

test('layers above the top band keep its color up to the axis top', () => {
  const handles = [
    { storeIndex: 0, value: 3, color: '#000000' },
    { storeIndex: 1, value: 5, color: '#ffffff' },
  ]
  const segs = getStackSegments(handles, 8)
  assert.equal(segs.length, 8)
  assert.deepEqual(segs.slice(5).map((s) => s.color), ['#ffffff', '#ffffff', '#ffffff'])
  // Without an axis top it still stops at the top band.
  assert.equal(getStackSegments(handles).length, 5)
})
