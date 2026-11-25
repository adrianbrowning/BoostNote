import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

test.use({ files: { 'note.md': '# Note\n\nIntro.\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
/** The note's text after its frontmatter (saves add `created`/`updated`). */
const body = (vault: string) => async () =>
  (await readFile(path.join(vault, 'note.md'), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '')

/**
 * Opens note.md, runs `prepare` (if any), types `prefix` and `/table` on a new line after the intro and picks Table:
 * the size grid opens.
 */
async function openTableGrid(
  page: Page,
  { prefix = '', prepare }: { prefix?: string; prepare?: () => Promise<void> } = {},
) {
  await page.locator('[data-note="note.md"]').click()
  await expect(editor(page)).toContainText('Intro.')
  await prepare?.()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(`\n${prefix}/table`)
  // CodeMirror ignores Enter (the editor then inserts a newline) while the menu is disabled, waiting on the query
  // for the last keystroke, and for 75 ms (`interactionDelay`) after the menu first opens. The menu opens before
  // it is enabled, so 100 ms after it is enabled clears both.
  const menu = page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)')
  await expect(menu.getByRole('option', { name: /Table/ })).toBeVisible()
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter')
  const grid = page.getByRole('dialog', { name: 'Table size' })
  await expect(grid).toBeFocused()
  return grid
}

test('/table opens a size grid: arrows pick 3 × 4 and Enter inserts that table, cursor in the first header cell', async ({
  app,
}) => {
  const { page, vault } = app
  const grid = await openTableGrid(page)
  const size = grid.getByRole('status')
  await expect(size).toHaveText('2 × 1')
  await page.keyboard.press('ArrowRight')
  await expect(size).toHaveText('3 × 1')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await expect(size).toHaveText('3 × 4')
  await page.keyboard.press('Enter')

  await expect(grid).toBeHidden()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('X')
  await expect
    .poll(body(vault), { timeout: 10_000 })
    .toBe(
      '# Note\n\nIntro.\n\n| XColumn 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n' +
        '|  |  |  |\n|  |  |  |\n|  |  |  |\n|  |  |  |',
    )
})

test('the size grid clamps at 1 and 10; Esc closes it, inserts nothing and leaves the /query removed', async ({
  app,
}) => {
  const { page, vault } = app
  const grid = await openTableGrid(page)
  const size = grid.getByRole('status')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowUp')
  await expect(size).toHaveText('1 × 1')
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown')
  await expect(size).toHaveText('10 × 10')
  await page.keyboard.press('Escape')

  await expect(grid).toBeHidden()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('Y')
  await expect.poll(body(vault), { timeout: 10_000 }).toBe('# Note\n\nIntro.\n\nY')
})

test('hovering a cell of the size grid shows its size and clicking it inserts that table', async ({ app }) => {
  const { page, vault } = app
  const grid = await openTableGrid(page)
  const cell = grid.locator('[data-columns="1"][data-rows="2"]')
  await cell.hover()
  await expect(grid.getByRole('status')).toHaveText('1 × 2')
  await cell.click()

  await expect(grid).toBeHidden()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('Z')
  await expect.poll(body(vault), { timeout: 10_000 }).toBe('# Note\n\nIntro.\n\n| ZColumn 1 |\n| --- |\n|  |\n|  |')
})

test('a click outside the size grid closes it and inserts nothing', async ({ app }) => {
  const { page, vault } = app
  const grid = await openTableGrid(page)
  await page.locator('[data-note-title]').click()

  await expect(grid).toBeHidden()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('W')
  await expect.poll(body(vault), { timeout: 10_000 }).toBe('# Note\n\nIntro.\n\nW')
})

/** The grid's box and the window's size, from the page. */
const gridBox = (page: Page) =>
  page.getByRole('dialog', { name: 'Table size' }).evaluate((grid) => ({
    ...grid.getBoundingClientRect().toJSON(),
    width: window.innerWidth,
    height: window.innerHeight,
  }))

test.describe('near the bottom of a long note', () => {
  test.use({ files: { 'note.md': `# Note\n\nIntro.\n${'\nLine.\n'.repeat(60)}` } })

  test('the size grid opens above the cursor inside the window; its last cell and size label can be used', async ({
    app,
  }) => {
    const { page, vault } = app
    const grid = await openTableGrid(page)
    const box = await gridBox(page)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(box.height)
    const cursorLine = await page.locator('[data-editor] .cm-line').last().boundingBox()
    expect(cursorLine).not.toBeNull()
    expect(box.bottom).toBeLessThanOrEqual(cursorLine?.y ?? 0)
    const cell = grid.locator('[data-columns="10"][data-rows="10"]')
    await cell.hover()
    await expect(grid.getByRole('status')).toHaveText('10 × 10')
    await expect(grid.getByRole('status')).toBeInViewport()
    await cell.click()

    await expect(grid).toBeHidden()
    await expect
      .poll(body(vault), { timeout: 10_000 })
      .toContain(`| ${Array.from({ length: 10 }, (_, i) => `Column ${i + 1}`).join(' | ')} |`)
  })
})

test('in a narrow window the size grid is clamped so its right edge stays inside the window', async ({ app }) => {
  const { electronApp, page } = app
  await openTableGrid(page, {
    prefix: 'A few words before it ',
    prepare: async () => {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(800, 700))
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(800)
    },
  })
  const box = await gridBox(page)
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(box.width)
})
