import type { Locator } from '@playwright/test'

import { type AppHandle, expect, openLooseFile, readSettings, test } from './fixtures.ts'

const sentence =
  'The customer asked for a refund after the parcel arrived late and the box was badly damaged in transit'

const NOTE = `# Tables

A paragraph of prose that is long enough to fill the whole text column of the reader pane, so its width is the line width.

| Customer | Notes | Outcome | Follow-up | Owner |
| --- | --- | --- | --- | --- |
| Acme | ${sentence} | ${sentence} | ${sentence} | ${sentence} |

> | Quoted | Table |
> | --- | --- |
> | ${sentence} | ${sentence} |
`

test.use({ ui: { lineWidth: 600 } })

/** Opens the note in the reader and returns the reader's body. */
async function openInReader(app: AppHandle): Promise<Locator> {
  await openLooseFile(app, 'tables.md', NOTE)
  const reader = app.page.locator('[data-reader-body]')
  await expect(reader.locator('h1')).toHaveText('Tables', { timeout: 20_000 })
  return reader
}

const width = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('element is not visible')
  return rect.width
}

test('with the default table width a reader table keeps the line width', async ({ app }) => {
  const reader = await openInReader(app)
  await expect(app.page.locator('[data-vault]')).toHaveCSS('--table-max-width', '600px')
  await expect(reader.locator('> table')).toHaveCSS('max-width', '600px')
  expect(await width(reader.locator('> table'))).toBeLessThanOrEqual(600)
})

test.describe('a full table width', () => {
  test.use({ ui: { lineWidth: 600, tableWidth: 'full' } })

  test('lets a wide top-level table grow to the pane while prose keeps the line width', async ({ app }) => {
    const reader = await openInReader(app)
    await expect(app.page.locator('[data-vault]')).toHaveCSS('--table-max-width', 'none')
    const table = reader.locator('> table')
    const tableWidth = await width(table)
    expect(tableWidth).toBeGreaterThan(600)
    // It fits the pane: the reader body does not scroll sideways.
    expect(await reader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(reader.locator('> p')).toHaveCSS('max-width', '600px')
    await expect(reader.locator('> h1')).toHaveCSS('max-width', '600px')
    expect(await width(reader.locator('> p'))).toBeLessThanOrEqual(600)
    // Tables inside a blockquote keep the width of their container.
    expect(await width(reader.locator('blockquote table'))).toBeLessThanOrEqual(600)
  })
})

test.describe('a pixel table width', () => {
  test.use({ ui: { lineWidth: 700, tableWidth: 500 } })

  test('never limits tables to less than the line width', async ({ app }) => {
    await expect(app.page.locator('[data-vault]')).toHaveCSS('--table-max-width', '700px')
  })
})

test.describe('a zero line width', () => {
  test.use({ ui: { lineWidth: 0, tableWidth: 900 } })

  test('lets tables fill the pane whatever the table width', async ({ app }) => {
    await expect(app.page.locator('[data-vault]')).toHaveCSS('--table-max-width', 'none')
  })
})

test('the preferences dialog sets the table width and the reader follows without a reload', async ({ app }) => {
  const { page } = app
  const reader = await openInReader(app)
  const table = reader.locator('> table')
  await app.clickMenu('preferences')
  const select = page.getByRole('combobox', { name: 'Table width', exact: true })
  await expect(select).toHaveValue('line')
  await expect(select.locator('option')).toHaveText(['Line width', 'Full pane width', 'Custom'])

  await select.selectOption('full')
  await expect.poll(async () => (await readSettings(app)).ui.tableWidth).toBe('full')
  await expect(table).toHaveCSS('max-width', 'none')
  expect(await width(table)).toBeGreaterThan(600)

  await select.selectOption('custom')
  const pixels = page.getByRole('spinbutton', { name: 'Table width (px)' })
  await pixels.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('900')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await readSettings(app)).ui.tableWidth).toBe(900)
  await expect(table).toHaveCSS('max-width', '900px')

  await select.selectOption('line')
  await expect.poll(async () => (await readSettings(app)).ui.tableWidth).toBe('line')
  await expect(table).toHaveCSS('max-width', '600px')
})
