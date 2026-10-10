import test from 'node:test'
import assert from 'node:assert/strict'
import { dataUrlToBlob, embeddedImageName, heightmapSource, isImageDataUrl, isSavedHeightmap } from '../src/lib/projectFile.ts'

// A saved project carries its heightmap and image so it opens on any server
// (loading one used to rebuild a different heightmap from the photo).

test('the heightmap saved is the one on screen: the result, else the auto-preview', () => {
  assert.equal(heightmapSource({ job_id: 'j1', status: 'completed' }, 'ready'), 'j1')
  assert.equal(heightmapSource({ job_id: 'j1', status: 'running' }, 'ready'), '__init__')
  assert.equal(heightmapSource(null, 'ready'), '__init__')
  assert.equal(heightmapSource(null, 'idle'), null)
  assert.equal(heightmapSource({ job_id: 'j1', status: 'failed' }, 'initializing'), null)
})

test('only a real heightmap entry is restored', () => {
  assert.equal(isSavedHeightmap({ heightmap: 'iVBOR', alpha: null, width: 1, height: 1, max_layer: 0 }), true)
  assert.equal(isSavedHeightmap({ heightmap: 'iVBOR' }), true)
  assert.equal(isSavedHeightmap({ heightmap: '' }), false)
  assert.equal(isSavedHeightmap({ heightmap: 'iVBOR', alpha: 5 }), false)
  assert.equal(isSavedHeightmap(null), false)
  assert.equal(isSavedHeightmap('/uploads/x.png'), false)
})

test('embedded images round-trip and keep their format', async () => {
  assert.equal(isImageDataUrl('data:image/png;base64,AAEC'), true)
  assert.equal(isImageDataUrl('/uploads/abc.png'), false)
  assert.equal(isImageDataUrl('data:text/html;base64,AAEC'), false)
  const blob = dataUrlToBlob('data:image/jpeg;base64,AAEC/w==')
  assert.equal(blob.type, 'image/jpeg')
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 255])
  assert.equal(embeddedImageName('data:image/jpeg;base64,AA', 'project-image'), 'project-image.jpg')
  assert.equal(embeddedImageName('data:image/png;base64,AA', 'focus-areas'), 'focus-areas.png')
})
