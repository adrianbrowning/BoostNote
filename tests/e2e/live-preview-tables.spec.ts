import type { Locator } from '@playwright/test'

import { expect, test } from './fixtures.ts'

const sentence =
  'The customer asked for a refund after the parcel arrived late and the box was badly damaged in transit'
const longWord = 'x'.repeat(400)

test.use({
  files: {
    'table.md': `# Table\n\nIntro paragraph.\n\n| Customer | Notes | Outcome | Follow-up | Owner |\n| --- | --- | --- | --- | --- |\n| Acme | ${sentence} | ${sentence} | ${sentence} | ${sentence} |\n\n${longWord}\n`,
  },
})

/** How many lines the text of `locator` is laid out on. */
const textLines = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
  })

test('live-preview table cells break only between words and stay within the text column', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="table.md"]').click()
  const table = page.locator('[data-editor] .cm-lp-table table')
  await expect(table).toBeVisible()

  const header = table.locator('th').first()
  await expect(header).toHaveText('Customer')
  expect(await textLines(header)).toBe(1)
  // Long cell text still wraps (between words).
  expect(await textLines(table.locator('td').nth(1))).toBeGreaterThan(1)

  const content = await page.locator('[data-editor] .cm-content').boundingBox()
  const tableBox = await table.boundingBox()
  if (!content || !tableBox) throw new Error('not visible')
  expect(tableBox.width).toBeLessThanOrEqual(content.width)

  // Prose outside tables still wraps long unbroken words.
  const prose = page.locator('[data-editor] .cm-line', { hasText: longWord.slice(0, 50) })
  expect(await textLines(prose)).toBeGreaterThan(1)
})
