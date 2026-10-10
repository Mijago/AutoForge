// Test runner: node --test tests/auto-prune.test.mjs
// The automatic-pruning presets and outcome messages (src/lib/pruning.ts).

import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_PRUNE_PRESETS, DEFAULT_AUTO_PRUNE_PRESET, autoPrunePreset, describeAutoOutcome } from '../src/lib/pruning.ts'

test('the four quality levels, strictest first', () => {
  assert.deepEqual(
    AUTO_PRUNE_PRESETS.map((p) => [p.id, p.maxLoss]),
    [['extremely_good', 10], ['very_good', 20], ['good', 30], ['acceptable', 40]],
  )
  for (const p of AUTO_PRUNE_PRESETS) assert.ok(p.help.length > 20, `${p.id} needs a hover explanation`)
})

test('an unknown preset falls back to the default one', () => {
  assert.equal(autoPrunePreset('nope').id, DEFAULT_AUTO_PRUNE_PRESET)
  assert.equal(autoPrunePreset('acceptable').maxLoss, 40)
})

test('every way the search can stop has its own message', () => {
  const messages = ['start_above_limit', 'limit_reached', 'nothing_left', 'pass_limit', undefined].map((o) => describeAutoOutcome(o, 20))
  assert.equal(new Set(messages).size, messages.length)
  assert.match(describeAutoOutcome('start_above_limit', 20), /already over the loss limit 20/)
})
