import { test, expect } from '@playwright/test'
import { byTestId, openApp, resetBackend } from '../helpers'

test.beforeEach(async ({ baseURL }) => {
  await resetBackend(baseURL!)
})

test('a hex color pasted from the web changes the filament color', async ({ page }) => {
  await openApp(page)
  await byTestId(page, 'new-filament-btn').click()

  const hex = byTestId(page, 'filament-hex-input')
  const picker = page.locator('input[type="color"]').last()
  // fill() types the text in one go, like a paste does.
  for (const [pasted, expected] of [['#1E90FF', '#1e90ff'], ['ff8800', '#ff8800'], [' #0f8 ', '#00ff88'], ['"#336699"', '#336699']]) {
    await hex.fill(pasted)
    await expect(picker).toHaveValue(expected)
  }

  // Half-typed or invalid text doesn't change the color, and the field goes
  // back to the real color when you leave it.
  await hex.fill('#12')
  await expect(picker).toHaveValue('#336699')
  await hex.blur()
  await expect(hex).toHaveValue('#336699')
})
