import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { activePalette, byTestId, openApp, resetBackend, uploadAndWaitForPreview, waitForSnapshot } from '../helpers'

/**
 * Heights mode: suggestions where colors sit in the print, set before a run
 * (settings.height_guidance / height_regions). The preview estimate comes
 * from the real /api/guidance/preview; no optimization runs here
 * (tests/jobs/heights-guidance.spec.ts runs one).
 */

const savedGuidance = async (request: APIRequestContext) => {
  const state = await (await request.get('/api/project/state')).json()
  return { guidance: state.settings.height_guidance ?? null, regions: state.settings.height_regions ?? '' }
}

test.beforeEach(async ({ baseURL }) => {
  await resetBackend(baseURL!)
})

async function openHeights(page: Page, request: APIRequestContext) {
  const palette = await activePalette(request)
  await openApp(page)
  await uploadAndWaitForPreview(page)
  await byTestId(page, 'heights-btn').click()
  await expect(byTestId(page, 'heights-view')).toBeVisible()
  return palette
}

test('Heights mode shows the targets, a quick real preview and how it follows them', async ({ page, request }) => {
  test.setTimeout(180_000)
  await openHeights(page, request)
  await expect(byTestId(page, 'heights-toolbar')).toBeVisible()
  await expect(byTestId(page, 'color-core-pins-hint')).toBeVisible()
  await expect(byTestId(page, 'color-core-pin-lane')).toBeVisible()
  expect(await savedGuidance(request)).toEqual({ guidance: null, regions: '' })

  // Targets: nothing pulled yet, then the photo depth.
  await byTestId(page, 'heights-view-targets').click()
  await expect(byTestId(page, 'heights-status')).toContainText('No part of the picture is pulled yet')
  await byTestId(page, 'heights-depth').check()
  await expect(byTestId(page, 'heights-view-overlay')).toHaveAttribute('data-view', 'targets', { timeout: 60000 })
  await expect(byTestId(page, 'heights-depth-flip')).toBeVisible()
  await byTestId(page, 'heights-order-dark_to_light').click()
  await expect(byTestId(page, 'heights-order-dark_to_light')).toHaveAttribute('aria-pressed', 'true')
  // (Edits within half a second are one undo step.)
  await waitForSnapshot(page)

  // Towards "follow heights".
  const strength = byTestId(page, 'heights-strength')
  await strength.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await strength.blur()
  await expect(byTestId(page, 'heights-strength-value')).toHaveAttribute('data-strength', /^(?!1$)/)
  await waitForSnapshot(page)
  const { guidance } = await savedGuidance(request)
  expect(guidance).toMatchObject({ order: 'dark_to_light', depth: true })
  expect(guidance.strength).toBeGreaterThan(1)

  // A quick real run: its heights, its colors, then how it follows the targets.
  await byTestId(page, 'heights-quick-preview').click()
  await expect(byTestId(page, 'heights-quick-summary')).toBeVisible({ timeout: 120000 })
  await expect(byTestId(page, 'heights-view-overlay')).toHaveAttribute('data-view', 'preview')
  // The 3D view shows that same run while Heights mode is on.
  await expect(byTestId(page, 'quick-preview-3d')).toBeVisible()
  await expect(byTestId(page, 'quick-preview-3d-label')).not.toHaveAttribute('data-stale', 'true')
  await byTestId(page, 'heights-preview-colors').click()
  await expect(byTestId(page, 'heights-preview-colors')).toHaveAttribute('aria-pressed', 'true')
  await byTestId(page, 'heights-view-followed').click()
  await expect(byTestId(page, 'heights-view-overlay')).toHaveAttribute('data-view', 'followed')
  await expect(byTestId(page, 'heights-followed-status')).toContainText('of the guided picture within reach in the quick preview')
  // Changing a suggestion makes the preview out of date.
  await byTestId(page, 'heights-depth-flip').check()
  await byTestId(page, 'heights-view-preview').click()
  await expect(byTestId(page, 'heights-preview-stale')).toBeVisible()
  await expect(byTestId(page, 'quick-preview-3d-label')).toHaveAttribute('data-stale', 'true')

  // Done: back to the image, the button says suggestions are set.
  await byTestId(page, 'heights-done-btn').click()
  await expect(byTestId(page, 'heights-view')).toHaveCount(0)
  await expect(byTestId(page, 'quick-preview-3d')).toHaveCount(0)
  await expect(byTestId(page, 'heights-btn')).toHaveAttribute('data-active', 'true')
  await expect(byTestId(page, 'heights-count')).toHaveText('2')
  await expect(byTestId(page, 'color-core-pins-hint')).toHaveCount(0)

  // One undo step per change.
  await waitForSnapshot(page)
  await page.keyboard.press('Control+z')
  await waitForSnapshot(page)
  expect((await savedGuidance(request)).guidance.depth_flip).toBe(false)
})

test('a filament dropped on the color column is pinned, moved and removed', async ({ page, request }) => {
  const palette = await openHeights(page, request)
  const red = palette[1]
  const core = byTestId(page, 'color-core')
  const box = (await core.boundingBox())!
  // Dropped near the top of the column.
  await page.locator(`[data-testid="filament-${red.uuid}"]`).dragTo(core, { targetPosition: { x: box.width / 2, y: box.height * 0.15 } })
  const pin = byTestId(page, 'color-core-pin-0')
  await expect(pin).toBeVisible()
  await expect(byTestId(page, 'heights-pin-chip-0')).toContainText('E2E Red')
  await waitForSnapshot(page)
  let { guidance } = await savedGuidance(request)
  expect(guidance.pins).toHaveLength(1)
  expect(guidance.pins[0].uuid).toBe(red.uuid)
  expect(guidance.pins[0].position).toBeGreaterThan(0.6)
  const top = Number(await core.getAttribute('data-top-layer'))
  expect(Number(await pin.getAttribute('data-layer'))).toBe(Math.round(guidance.pins[0].position * top))

  // Dragged down to the lower part of the column.
  const pinBox = (await pin.boundingBox())!
  await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(pinBox.x + pinBox.width / 2, box.y + box.height * 0.8, { steps: 8 })
  await page.mouse.up()
  await waitForSnapshot(page)
  guidance = (await savedGuidance(request)).guidance
  expect(guidance.pins[0].position).toBeLessThan(0.4)

  // Arrow keys move it a layer.
  const before = Number(await pin.getAttribute('data-layer'))
  await pin.focus()
  await page.keyboard.press('ArrowUp')
  await expect(pin).toHaveAttribute('data-layer', String(before + 1))

  await byTestId(page, 'color-core-pin-remove-0').click()
  await expect(byTestId(page, 'color-core-pin-0')).toHaveCount(0)
  await waitForSnapshot(page)
  expect((await savedGuidance(request)).guidance).toBeNull()
})

test('painted regions are uploaded and picked colors raise or lower', async ({ page, request }) => {
  await openHeights(page, request)
  const canvas = byTestId(page, 'height-regions-canvas')
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!
  await byTestId(page, 'heights-tool-raise').click()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await savedGuidance(request)).regions, { timeout: 10000 }).not.toBe('')
  await expect(byTestId(page, 'heights-count')).toHaveCount(0) // the count shows outside Heights mode only

  // Pick a color: a raised color appears, the arrow flips it to lowered.
  await byTestId(page, 'heights-tool-pick').click()
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.2)
  await expect(byTestId(page, 'heights-color-chip-0')).toBeVisible()
  await expect(byTestId(page, 'heights-color-direction-0')).toHaveAttribute('data-direction', 'raise')
  await byTestId(page, 'heights-color-direction-0').click()
  await expect(byTestId(page, 'heights-color-direction-0')).toHaveAttribute('data-direction', 'lower')
  await waitForSnapshot(page)
  const { guidance } = await savedGuidance(request)
  expect(guidance.colors).toHaveLength(1)
  expect(guidance.colors[0].direction).toBe('lower')
  expect(guidance.colors[0].color).toMatch(/^#[0-9a-f]{6}$/)

  // Clear removes the painted regions.
  await byTestId(page, 'heights-clear-regions').click()
  await expect.poll(async () => (await savedGuidance(request)).regions).toBe('')
})

test('clicking a band in Heights mode pins its filament there', async ({ page, request }) => {
  const palette = await openHeights(page, request)
  // Give the column a band to click: drop a filament outside Heights mode.
  await byTestId(page, 'heights-done-btn').click()
  await page.locator(`[data-testid="filament-${palette[2].uuid}"]`).dragTo(byTestId(page, 'color-core'))
  await expect(page.locator('[data-testid^="color-core-handle-"]').first()).toBeVisible()
  await byTestId(page, 'heights-btn').click()
  // The dropped filament's band is the top one (the lower default columns
  // have no filament to pin).
  const handle = page.locator('[data-testid^="color-core-handle-"]').last()
  const layer = Number(await handle.getAttribute('data-layer'))
  const segments = byTestId(page, 'color-core-segments')
  const seg = page.locator(`[data-testid^="color-core-segment-"][data-layer="${Math.max(1, layer - 1)}"]`)
  const segBox = (await seg.boundingBox())!
  const segmentsBox = (await segments.boundingBox())!
  await page.mouse.click(segmentsBox.x + segmentsBox.width / 2, segBox.y + segBox.height / 2)
  await expect(byTestId(page, 'color-core-pin-0')).toBeVisible()
  await waitForSnapshot(page)
  const { guidance } = await savedGuidance(request)
  expect(guidance.pins[0].uuid).toBe(palette[2].uuid)
})
