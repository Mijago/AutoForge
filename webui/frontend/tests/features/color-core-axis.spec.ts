import { test, expect } from '@playwright/test'
import { activePalette, byTestId, openApp, resetBackend, uploadAndWaitForPreview } from '../helpers'

/**
 * The color column runs from layer 0 (the base) to the top layer of the
 * current heightmap. It used to stop at the highest band, so on the first
 * auto-preview (bands from the default stack, heightmap from the photo) the
 * column showed a different print than the 3D view.
 */

test.beforeEach(async ({ baseURL }) => {
  await resetBackend(baseURL!)
})

test('the color column spans the auto-preview heightmap, base to top', async ({ page, request }) => {
  await activePalette(request)
  await openApp(page)
  await uploadAndWaitForPreview(page)
  const status = await (await request.get('/api/init/status')).json()
  const top = Number(status.max_layer)
  expect(top).toBeGreaterThan(0)

  const core = byTestId(page, 'color-core')
  await expect(core).toHaveAttribute('data-top-layer', String(top))
  // The topmost drawn layer is the heightmap's top, whatever the bands say.
  const segments = page.locator('[data-testid^="color-core-segment-"]')
  await expect(segments.first()).toHaveAttribute('data-layer', String(top))
  await expect(segments).toHaveCount(top)
  await expect(byTestId(page, 'color-core-base')).toBeVisible()

  // The base row sits at the very bottom of the column.
  const coreBox = (await page.locator('[data-testid="color-core-segments"]').boundingBox())!
  const baseBox = (await byTestId(page, 'color-core-base').boundingBox())!
  expect(Math.abs(baseBox.y + baseBox.height - (coreBox.y + coreBox.height))).toBeLessThan(2)
})
