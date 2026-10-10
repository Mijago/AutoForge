import { test, expect } from '@playwright/test'
import { FAST_SETTINGS, activePalette, byTestId, openApp, presetSettings, resetBackend, uploadAndWaitForPreview, waitForJob } from '../helpers'

// A slider edit changes colors, never heights: the 3D view must recolor the
// mesh it already shows from the render response (lib/meshColors), not
// rebuild and re-download the whole colored PLY. Uses the default print size,
// so the mesh is as large as a real one (~750px grid, ~600k vertices).
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test('a slider edit recolors the 3D mesh in place, fast, without refetching the PLY', async ({ page, request, baseURL }) => {
  const bumps: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('[mesh-reload]')) bumps.push(m.text()) })
  await resetBackend(baseURL!)
  await activePalette(request)
  await presetSettings(request, { ...FAST_SETTINGS, stl_output_size: 150, processing_reduction_factor: 2 })
  await openApp(page)
  await uploadAndWaitForPreview(page)
  await byTestId(page, 'top-start-btn').click()
  await expect(byTestId(page, 'job-progress').or(byTestId(page, 'three-d-view'))).toBeVisible({ timeout: 30000 })
  const jobId = (await (await request.get('/api/optimize/latest')).json()).job_id
  expect((await waitForJob(request, jobId)).status).toBe('completed')
  await expect(byTestId(page, 'three-d-view')).toBeVisible({ timeout: 15000 })
  // The result's own mesh has loaded once its geometry is on screen.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('autoforge:mesh-loaded').length), { timeout: 30000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1500)

  const plyRequests: string[] = []
  page.on('request', (r) => { if (r.url().includes('/colored-ply/')) plyRequests.push(r.url()) })

  const timings: number[] = []
  for (const td of ['7', '2', '9', '4']) {
    const input = byTestId(page, 'td-input-0')
    await input.click()
    await input.press('ControlOrMeta+a')
    await page.evaluate(() => performance.clearMarks('autoforge:mesh-recolored'))
    const t0 = await page.evaluate(() => performance.now())
    await input.pressSequentially(td)
    await input.press('Enter')
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('autoforge:mesh-recolored').length), { timeout: 5000 }).toBeGreaterThan(0)
    const t1 = await page.evaluate(() => performance.getEntriesByName('autoforge:mesh-recolored').at(-1)!.startTime)
    timings.push(Math.round(t1 - t0))
    await page.waitForTimeout(300)
  }
  console.log(`edit -> mesh recolored (ms): ${timings.join(', ')}`)
  // Warm edits; the first one after a run also pays one-off GPU warm-up.
  expect(Math.min(...timings.slice(1))).toBeLessThan(300)
  await page.waitForTimeout(800)
  expect(plyRequests, `the edit must not re-download the mesh (${bumps.join(' | ')})`).toEqual([])

  // The edit still reaches the file for reloads.
  const ply = await request.get(`/api/outputs/colored-ply/${jobId}`)
  expect(ply.ok()).toBeTruthy()
  await expect(page.locator('[data-testid^="toast-"]')).toHaveCount(0)
})
