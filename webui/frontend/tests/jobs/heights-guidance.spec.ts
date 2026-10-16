import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { FAST_SETTINGS, activePalette, byTestId, openApp, presetSettings, resetBackend, uploadAndWaitForPreview, waitForJob, waitForSnapshot } from '../helpers'

// A real run with height guidance set in Heights mode: the suggestions go
// to the optimizer, the result says how it followed them, and a saved
// project carries them (the painted regions embedded) to another server.
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

test('a run follows the guidance from Heights mode, and the project keeps it', async ({ page, request, baseURL }, testInfo) => {
  await resetBackend(baseURL!)
  const palette = await activePalette(request)
  await presetSettings(request, { ...FAST_SETTINGS, iterations: 400 })
  await openApp(page)
  await uploadAndWaitForPreview(page)

  // A pin near the top, and a painted raised region.
  await byTestId(page, 'heights-btn').click()
  const core = byTestId(page, 'color-core')
  const box = (await core.boundingBox())!
  const yellow = palette[2]
  await page.locator(`[data-testid="filament-${yellow.uuid}"]`).dragTo(core, { targetPosition: { x: box.width / 2, y: box.height * 0.15 } })
  await expect(byTestId(page, 'color-core-pin-0')).toBeVisible()
  const canvas = byTestId(page, 'height-regions-canvas')
  const cbox = (await canvas.boundingBox())!
  await page.mouse.move(cbox.x + cbox.width * 0.4, cbox.y + cbox.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(cbox.x + cbox.width * 0.6, cbox.y + cbox.height * 0.5, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await (await request.get('/api/project/state')).json()).settings.height_regions, { timeout: 10000 })
    .not.toBe('')
  await byTestId(page, 'heights-done-btn').click()
  await waitForSnapshot(page)

  const started = page.waitForResponse((r) => r.url().endsWith('/api/optimize/start') && r.request().method() === 'POST')
  await byTestId(page, 'top-start-btn').click()
  const response = await started
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = response.request().postDataJSON()
  expect(body.height_guidance.pins).toEqual([{ uuid: yellow.uuid, position: expect.any(Number) }])
  expect(body.height_regions).toBeTruthy()
  const jobId = (await response.json()).job_id
  const done = await waitForJob(request, jobId, 280_000)
  expect(done.status, done.error ?? '').toBe('completed')
  expect(done.guidance_report.pins).toHaveLength(1)
  expect(done.guidance_report.pins[0].uuid).toBe(yellow.uuid)
  expect(done.guidance_report.pixel_mean_distance).toEqual(expect.any(Number))

  // The result says how it followed the suggestions.
  const chip = byTestId(page, 'result-guidance')
  await expect(chip).toBeVisible({ timeout: 30000 })
  await expect(chip).toHaveAttribute('data-total', '1')
  await expect(chip).toContainText('pins')

  // Saved and opened on another server: the guidance and the regions come along.
  await byTestId(page, 'file-menu-btn').click()
  const [download] = await Promise.all([page.waitForEvent('download'), byTestId(page, 'file-menu-save').click()])
  const file = testInfo.outputPath('heights.json')
  await download.saveAs(file)
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
  expect(saved.settings.height_guidance.pins[0].uuid).toBe(yellow.uuid)
  expect(saved.heightRegionsData).toMatch(/^data:image\/png;base64,/)
  saved.settings.height_regions = 'not-on-this-server.png'
  fs.writeFileSync(file, JSON.stringify(saved))

  await resetBackend(baseURL!)
  await openApp(page)
  await byTestId(page, 'file-menu-load-input').setInputFiles(file)
  await expect(byTestId(page, 'heights-btn')).toHaveAttribute('data-active', 'true', { timeout: 30000 })
  await waitForSnapshot(page)
  const state = await (await request.get('/api/project/state')).json()
  expect(state.settings.height_guidance.pins[0].uuid).toBe(yellow.uuid)
  expect(state.settings.height_regions).toBeTruthy()
  expect(state.settings.height_regions).not.toBe('not-on-this-server.png')
  const regions = await request.get(`/uploads/${encodeURIComponent(state.settings.height_regions)}`)
  expect(regions.ok()).toBeTruthy()
})
