import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { FAST_SETTINGS, activePalette, byTestId, openApp, presetSettings, resetBackend, uploadAndWaitForPreview, waitForJob } from '../helpers'

// A project file is shared with other people, so it must open without
// anything only the saving server had. Loading one used to rebuild a fresh
// auto-preview heightmap from the photo — a different surface than the
// result's, with the result's color layers painted onto it.
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test('a saved project opens with its own heightmap and colors on another server', async ({ page, request, baseURL }, testInfo) => {
  await resetBackend(baseURL!)
  await activePalette(request)
  await presetSettings(request, FAST_SETTINGS)
  await openApp(page)
  await uploadAndWaitForPreview(page)
  await byTestId(page, 'top-start-btn').click()
  await expect(byTestId(page, 'job-progress').or(byTestId(page, 'three-d-view'))).toBeVisible({ timeout: 30000 })
  const jobId = (await (await request.get('/api/optimize/latest')).json()).job_id
  expect((await waitForJob(request, jobId)).status).toBe('completed')
  await expect(byTestId(page, 'three-d-view')).toBeVisible({ timeout: 15000 })
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('autoforge:mesh-loaded').length), { timeout: 30000 }).toBeGreaterThan(0)

  // A hand edit, so the saved colors aren't just what the optimizer chose.
  const td = byTestId(page, 'td-input-0')
  await td.click()
  await td.press('ControlOrMeta+a')
  await td.pressSequentially('9')
  await td.press('Enter')
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('autoforge:mesh-recolored').length), { timeout: 10000 }).toBeGreaterThan(0)

  await byTestId(page, 'file-menu-btn').click()
  const [download] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'file-menu-save').click()])
  const file = testInfo.outputPath('saved.json')
  await download.saveAs(file)
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const resultHeightmap = await (await request.get(`/api/project/heightmap?job_id=${jobId}`)).json()
  expect(saved.heightmap.heightmap).toBe(resultHeightmap.heightmap)
  expect(saved.inputImageData).toMatch(/^data:image\/png;base64,/)
  const resultMesh = await (await request.get(`/api/outputs/colored-ply/${jobId}`)).body()

  // Another server: none of this project's filaments, no auto-preview, and
  // no file under the name the saving server gave the image.
  await resetBackend(baseURL!)
  await request.post('/api/init/reset')
  saved.settings.input_image = 'not-on-this-server.png'
  saved.inputImage = '/uploads/not-on-this-server.png'
  fs.writeFileSync(file, JSON.stringify(saved))

  await openApp(page)
  const requests: string[] = []
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`))
  await byTestId(page, 'file-menu-load-input').setInputFiles(file)

  await expect(byTestId(page, 'init-three-d-view')).toBeVisible({ timeout: 30000 })
  await expect(byTestId(page, 'input-image')).toBeVisible()
  await page.waitForTimeout(2000)
  expect(requests.filter((r) => r === 'POST /api/init/run')).toEqual([])

  const loadedHeightmap = await (await request.get('/api/project/heightmap?job_id=__init__')).json()
  expect(loadedHeightmap.heightmap).toBe(saved.heightmap.heightmap)
  // Same heightmap and layers: the very mesh the result showed.
  const loadedMesh = await (await request.get('/api/init/mesh')).body()
  expect(loadedMesh.equals(resultMesh)).toBe(true)
  await expect(page.locator('[data-testid^="toast-"]')).toHaveCount(0)
})
