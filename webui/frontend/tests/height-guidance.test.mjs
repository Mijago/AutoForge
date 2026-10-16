// Test runner: node --import tsx/esm --test tests/height-guidance.test.mjs
//
// Pure logic of the height guidance (src/lib/heightGuidance.ts) and the
// "out of date" check for its object-valued setting.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addColorPick,
  addPin,
  describeColorCost,
  describeReportPins,
  emptyGuidance,
  guidanceForSettings,
  guidanceIsActive,
  movePin,
  normalizeGuidance,
  pinLayer,
  pixelHex,
  positionFromLayer,
  prunePins,
  regionShares,
  removePin,
  sliderFromStrength,
  strengthFromSlider,
  suggestionCount,
  summarizeReport,
  updateColorPick,
} from '../src/lib/heightGuidance.ts'
import { staleReasons } from '../src/lib/staleResult.ts'

test('nothing suggested is stored as no guidance at all', () => {
  const g = emptyGuidance()
  assert.equal(guidanceIsActive(g), false)
  assert.equal(guidanceForSettings(g), null)
  // A strength the user chose is kept even before anything is suggested.
  assert.deepEqual(guidanceForSettings({ ...g, strength: 3 }), { ...emptyGuidance(), strength: 3 })
  // Painted regions alone are guidance.
  assert.equal(guidanceIsActive(g, true), true)
  assert.deepEqual(guidanceForSettings(g, true), g)
  // Strength 0 switches everything off.
  assert.equal(guidanceIsActive({ ...g, depth: true, strength: 0 }), false)
})

test('normalizing fills in and cleans partial or foreign data', () => {
  assert.deepEqual(normalizeGuidance(null), emptyGuidance())
  const g = normalizeGuidance({ order: 'sideways', pins: [{ uuid: 'a', position: 7 }, null], colors: [{ color: '#fff', direction: 'down' }] })
  assert.equal(g.order, 'auto')
  assert.deepEqual(g.pins, [{ uuid: 'a', position: 1 }])
  assert.deepEqual(g.colors, [{ color: '#fff', tolerance: 15, direction: 'raise' }])
})

test('pins are added, moved, removed and dropped with their filament', () => {
  let g = addPin(emptyGuidance(), 'red', 0.8)
  g = addPin(g, 'red', 0.1) // the same filament at two heights is fine
  g = addPin(g, 'white', 1.3)
  assert.deepEqual(g.pins.map((p) => p.position), [0.8, 0.1, 1])
  g = movePin(g, 1, 0.25)
  assert.equal(g.pins[1].position, 0.25)
  assert.equal(movePin(g, 9, 0.5), g)
  g = removePin(g, 0)
  assert.deepEqual(g.pins, [{ uuid: 'red', position: 0.25 }, { uuid: 'white', position: 1 }])
  assert.deepEqual(prunePins(g, ['white']).pins, [{ uuid: 'white', position: 1 }])
  assert.equal(suggestionCount(g), 2)
})

test('pin positions and color column layers convert both ways', () => {
  assert.equal(pinLayer(0.8, 50), 40)
  assert.equal(pinLayer(0, 50), 0)
  assert.equal(positionFromLayer(40, 50), 0.8)
  assert.equal(positionFromLayer(80, 50), 1)
  for (let layer = 0; layer <= 37; layer++) assert.equal(pinLayer(positionFromLayer(layer, 37), 37), layer)
})

test('picked colors replace an earlier pick of the same color', () => {
  let g = addColorPick(emptyGuidance(), '#AABBCC', 'raise')
  g = addColorPick(g, '#aabbcc', 'lower')
  assert.deepEqual(g.colors, [{ color: '#aabbcc', tolerance: 15, direction: 'lower' }])
  g = updateColorPick(g, 0, { tolerance: 30 })
  assert.equal(g.colors[0].tolerance, 30)
  assert.equal(pixelHex(255, 0, 16.4), '#ff0010')
})

test('the strength slider spans 0.05x to 100x on a log scale', () => {
  assert.equal(strengthFromSlider(0), 0.05)
  assert.equal(strengthFromSlider(100), 100)
  // Every step moves: the old rounding snapped small steps back to 1x.
  const values = Array.from({ length: 101 }, (_, i) => strengthFromSlider(i))
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1])
  assert.ok(new Set(values).size > 80)
  for (const s of [0.05, 0.3, 1, 7, 100]) assert.ok(Math.abs(strengthFromSlider(sliderFromStrength(s)) - s) <= 0.1 * s)
})

test('regions count raised (red) and lowered (blue) pixels', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0])
  assert.deepEqual(regionShares(px), { raise: 0.25, lower: 0.5 })
})

test('the result report reads as followed pins, order and heights', () => {
  const report = {
    top: 40,
    pins: [
      { uuid: 'red', material: 2, position: 0.8, nearest: 0.75, met: true },
      { uuid: 'white', material: 1, position: 0.1, nearest: null, met: false },
    ],
    order_agreement: 0.934,
    pixel_mean_distance: 0.21,
  }
  assert.deepEqual(summarizeReport(report), { text: '1/2 pins · order 93% · heights ±21%', followed: 1, total: 2 })
  assert.equal(summarizeReport(null), null)
  assert.deepEqual(describeReportPins(report, (u) => u.toUpperCase()), [
    'RED at 80%: followed at 75%',
    'WHITE at 10%: not used',
  ])
  assert.equal(describeColorCost(-0.02), 'no extra color error')
  assert.equal(describeColorCost(0.003), 'under 1% more color error')
  assert.equal(describeColorCost(0.104), '≈ +10% color error')
})

test('the same guidance read back from storage is not a change', () => {
  const g = { strength: 1, order: 'dark_to_light', pins: [{ uuid: 'a', position: 0.5 }], depth: false, depth_flip: false, colors: [] }
  const run = { settings: { height_guidance: JSON.parse(JSON.stringify(g)), max_layers: 75 }, filamentUuids: [] }
  assert.deepEqual(staleReasons(run, { height_guidance: g, max_layers: 75 }, []), [])
  assert.deepEqual(staleReasons(run, { height_guidance: { ...g, order: 'auto' }, max_layers: 75 }, []), ['height_guidance'])
})
