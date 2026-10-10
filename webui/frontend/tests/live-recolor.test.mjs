// Test runner: node --test tests/live-recolor.test.mjs
//
// The client half of live 3D recoloring on slider edits (src/lib/meshColors.ts);
// the server half is tests/webui/test_live_recolor.py.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  colorsNewerThan,
  currentColorSeq,
  decodeBase64,
  isOwnRender,
  meshKeyForJob,
  newRenderId,
  publishVertexColors,
  subscribeVertexColors,
  writeTopVertexColors,
} from '../src/lib/meshColors.ts'

test('mesh keys match the URLs the 3D panel loads', () => {
  assert.equal(meshKeyForJob('__init__'), '/api/init/mesh')
  assert.equal(meshKeyForJob('job-1'), '/api/outputs/colored-ply/job-1')
})

test('writes sRGB top-vertex colors as linear floats and leaves the bottom half alone', () => {
  const target = new Float32Array(12).fill(-1) // 4 vertices: 2 top, 2 bottom
  assert.equal(writeTopVertexColors(target, new Uint8Array([0, 255, 128, 10, 20, 30])), true)
  assert.equal(target[0], 0)
  assert.equal(target[1], 1)
  assert.ok(Math.abs(target[2] - 0.2158605) < 1e-5) // sRGB 128 -> linear
  assert.deepEqual([...target.slice(6)], [-1, -1, -1, -1, -1, -1])
})

test('refuses colors computed for a different mesh', () => {
  const target = new Float32Array(12).fill(-1)
  assert.equal(writeTopVertexColors(target, new Uint8Array(9)), false)
  assert.equal(writeTopVertexColors(target, new Uint8Array(0)), false)
  assert.equal(writeTopVertexColors(target, new Uint8Array(5)), false)
  assert.deepEqual([...target], new Array(12).fill(-1))
})

test('decodes the base64 color payload', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255])
  assert.deepEqual([...decodeBase64(Buffer.from(bytes).toString('base64'))], [...bytes])
})

test('updates reach the mesh they belong to, and report whether one took them', () => {
  const seen = []
  const unsubscribe = subscribeVertexColors((u) => {
    seen.push(u.meshKey)
    return u.meshKey === '/api/init/mesh'
  })
  assert.equal(publishVertexColors('/api/init/mesh', new Uint8Array(3)), true)
  assert.equal(publishVertexColors('/api/outputs/colored-ply/other', new Uint8Array(3)), false)
  unsubscribe()
  assert.equal(publishVertexColors('/api/init/mesh', new Uint8Array(3)), false)
  assert.deepEqual(seen, ['/api/init/mesh', '/api/outputs/colored-ply/other'])
})

test('a mesh file downloaded before the latest colors gets them re-applied', () => {
  const key = '/api/outputs/colored-ply/late'
  const loadStart = currentColorSeq()
  assert.equal(colorsNewerThan(key, loadStart), null)
  const rgb = new Uint8Array([1, 2, 3])
  publishVertexColors(key, rgb)
  assert.equal(colorsNewerThan(key, loadStart)?.rgb, rgb)
  // A download that started after them already contains them.
  assert.equal(colorsNewerThan(key, currentColorSeq()), null)
})

test("this tab's own render broadcasts are recognized", () => {
  const id = newRenderId()
  assert.equal(isOwnRender(id), true)
  assert.equal(isOwnRender('someone-else'), false)
  assert.equal(isOwnRender(undefined), false)
})
