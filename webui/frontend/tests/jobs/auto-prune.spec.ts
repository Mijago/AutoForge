import fs from 'node:fs'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { FAST_SETTINGS, FIXTURE_IMAGE, activePalette, byTestId, latestJob, openApp, presetSettings, resetBackend, waitForJob } from '../helpers'

/**
 * Automatic pruning in the browser, against a real (tiny) result: pick a
 * quality level, watch the passes, end up under the loss limit.
 */

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

async function runOptimization(request: APIRequestContext, baseURL: string) {
  await resetBackend(baseURL)
  await activePalette(request)
  await presetSettings(request, FAST_SETTINGS)
  const upload = await request.post('/api/images/upload', {
    multipart: { file: { name: 'cat.png', mimeType: 'image/png', buffer: fs.readFileSync(FIXTURE_IMAGE) } },
  })
  const filename = (await upload.json()).filename
  await presetSettings(request, { input_image: filename })
  const start = await request.post('/api/optimize/start', { data: { ...FAST_SETTINGS, input_image: filename } })
  expect(start.ok(), await start.text()).toBeTruthy()
  const jobId = (await start.json()).job_id
  const done = await waitForJob(request, jobId)
  expect(done.status, done.error ?? '').toBe('completed')
  const derived = await (await request.get(`/api/sliders/from-optimizer?job_id=${jobId}`)).json()
  const state = await (await request.get('/api/project/state')).json()
  await request.post('/api/project/state', { data: { ...state, color_sliders: derived.sliders } })
  return jobId
}

test('automatic pruning: pick a level, watch the passes, stay under the limit', async ({ page, request, baseURL }) => {
  await runOptimization(request, baseURL!)
  await openApp(page)
  await byTestId(page, 'top-pruning-btn').click()
  await expect(byTestId(page, 'pruning-modal')).toBeVisible()

  // Manual stays the default; the automatic tab swaps the limits for levels.
  await expect(byTestId(page, 'pruning-max-colors')).toBeVisible()
  await byTestId(page, 'pruning-mode-auto').click()
  await expect(byTestId(page, 'pruning-max-colors')).toHaveCount(0)
  for (const [id, loss] of [['extremely_good', 10], ['very_good', 20], ['good', 30], ['acceptable', 40]] as const) {
    await expect(byTestId(page, `pruning-preset-${id}`)).toContainText(`loss under ${loss}`)
  }

  // Each level explains itself on hover.
  await byTestId(page, 'pruning-preset-extremely_good').hover()
  await expect(byTestId(page, 'pruning-preset-help').first()).toContainText('indistinguishable')

  await byTestId(page, 'pruning-preset-acceptable').click()
  await byTestId(page, 'pruning-start-btn').click()
  await expect(byTestId(page, 'pruning-progress-view')).toBeVisible()
  await expect(byTestId(page, 'pruning-modal-pause')).toBeVisible()

  await expect(byTestId(page, 'pruning-again-btn')).toBeVisible({ timeout: 240_000 })
  const job = await latestJob(request)
  expect(job.status).toBe('completed')
  expect(job.auto_target_loss).toBe(30)
  expect(job.auto_outcome).toBeTruthy()
  if (job.auto_outcome === 'start_above_limit') {
    await expect(byTestId(page, 'pruning-modal-status')).toContainText('already over the loss limit')
  } else {
    const kept = job.auto_passes.filter((p: { kept: boolean }) => p.kept)
    expect(job.loss).toBeLessThanOrEqual(30)
    await expect(byTestId(page, 'pruning-auto-pass')).toHaveCount(job.auto_passes.length)
    if (kept.length) expect(job.result_colors).toBe(kept[kept.length - 1].colors)
  }
})

test('automatic pruning accepts a loss limit of your own', async ({ page, request, baseURL }) => {
  await runOptimization(request, baseURL!)
  await openApp(page)
  await byTestId(page, 'top-pruning-btn').click()
  await byTestId(page, 'pruning-mode-auto').click()

  await byTestId(page, 'pruning-custom-loss').fill('45.5')
  await expect(byTestId(page, 'pruning-preset-custom-radio')).toHaveAttribute('aria-checked', 'true')
  await byTestId(page, 'pruning-start-btn').click()
  await expect(byTestId(page, 'pruning-again-btn')).toBeVisible({ timeout: 240_000 })

  const job = await latestJob(request)
  expect(job.auto_target_loss).toBe(45.5)
  expect(job.auto_outcome).toBeTruthy()
})
