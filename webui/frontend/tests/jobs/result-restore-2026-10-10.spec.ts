import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { FAST_SETTINGS, activePalette, byTestId, openApp, presetSettings, resetBackend, uploadAndWaitForPreview, waitForJob } from '../helpers'

// Pruning only worked while the server still held the result in memory: after
// a restart, a History jump or loading a project from another machine it
// failed with "No optimization pipeline result found". Results are saved with
// their solution now and rebuilt when needed; a loaded project prunes from
// its own heightmap and color layers.
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

async function runAndSaveProject(page, request, baseURL: string, file: string) {
  await resetBackend(baseURL)
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

  await byTestId(page, 'file-menu-btn').click()
  const [download] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'file-menu-save').click()])
  await download.saveAs(file)
  return jobId
}

async function pruneFromDialog(page) {
  await expect(byTestId(page, 'top-pruning-btn')).toBeEnabled()
  await byTestId(page, 'top-pruning-btn').click()
  await expect(byTestId(page, 'pruning-modal')).toBeVisible()
  await byTestId(page, 'pruning-mode-manual').click()
  const colors = byTestId(page, 'pruning-max-colors')
  const startColors = Number(await byTestId(page, 'pruning-current-colors').getAttribute('data-value'))
  await colors.fill(String(Math.max(2, startColors - 1)))
  await colors.dispatchEvent('change')
  await byTestId(page, 'pruning-start-btn').click()
  await expect(byTestId(page, 'pruning-modal-status')).toHaveText('Pruning finished — the color layers were updated.', { timeout: 240_000 })
}

test('a project loaded on another server can be pruned', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(300_000)
  const file = testInfo.outputPath('saved.json')
  await runAndSaveProject(page, request, baseURL!, file)

  // Another server: nothing of this run, and the image under a name it never had.
  await resetBackend(baseURL!)
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
  saved.settings.input_image = 'not-on-this-server.png'
  saved.inputImage = '/uploads/not-on-this-server.png'
  fs.writeFileSync(file, JSON.stringify(saved))

  await openApp(page)
  await byTestId(page, 'file-menu-load-input').setInputFiles(file)
  await expect(byTestId(page, 'init-three-d-view')).toBeVisible({ timeout: 30000 })

  await pruneFromDialog(page)
  // The pruned result is now what's on screen.
  await expect(byTestId(page, 'three-d-view')).toBeVisible({ timeout: 30000 })
  const latest = await (await request.get('/api/optimize/latest')).json()
  expect(latest.job_id).toMatch(/^prune-/)
  expect(latest.status).toBe('completed')
  await expect(page.locator('[data-testid^="toast-"]').filter({ hasText: /failed|not available|no optimization/i })).toHaveCount(0)
})

test('a result the server no longer holds can still be pruned and re-colored', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(300_000)
  const jobId = await runAndSaveProject(page, request, baseURL!, testInfo.outputPath('saved.json'))

  // Prune it once through the API, then come back to the original result
  // (what an undo does): the server now holds only the pruned one.
  const first = await request.post('/api/pruning/start', {
    data: { job_id: jobId, pruning_max_colors: 3, pruning_max_swaps: 4, pruning_max_layer: 75, seed_search_count: 5 },
  })
  expect(first.ok()).toBe(true)
  expect((await waitForJob(request, (await first.json()).job_id)).status).toBe('completed')

  const recolor = await request.post('/api/preview/render-with-sliders', {
    data: { job_id: jobId, sliders: (await (await request.get(`/api/sliders/from-optimizer?job_id=${jobId}`)).json()).sliders },
  })
  expect(recolor.status()).toBe(200)

  const again = await request.post('/api/pruning/start', {
    data: { job_id: jobId, pruning_max_colors: 3, pruning_max_swaps: 4, pruning_max_layer: 75, seed_search_count: 5 },
  })
  expect(again.ok()).toBe(true)
  const status = await waitForJob(request, (await again.json()).job_id)
  expect(status.error ?? null).toBeNull()
  expect(status.status).toBe('completed')
})
