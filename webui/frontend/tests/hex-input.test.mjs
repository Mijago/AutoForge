// Test runner: node --test tests/hex-input.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHexInput } from '../src/lib/color.ts'

test('hex spellings people paste from the web', () => {
  const orange = { r: 255, g: 136, b: 0 }
  for (const text of ['#ff8800', 'ff8800', 'FF8800', '  #FF8800\n', '"#ff8800"', '#f80', 'f80', '0xff8800', '#ff8800ff', '#f80f']) {
    assert.deepEqual(parseHexInput(text), orange, text)
  }
})

test('things that are not a hex color', () => {
  for (const text of ['', '#', '#ff880', '#ff88001', 'red', '#gg0000', '12345']) {
    assert.equal(parseHexInput(text), null, text)
  }
})
