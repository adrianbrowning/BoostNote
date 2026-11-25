import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

test.use({ files: { 'note.md': '# Note\n\nIntro.\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
/** The note's text after its frontmatter (saves add `created`/`updated`). */
const body = (vault: string) => async () =>
  (await readFile(path.join(vault, 'note.md'), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '')

/** Opens note.md, types `/table` on a new line after the intro and picks Table: the size grid opens. */
async function openTableGrid(page: Page) {
  await page.locator('[data-note="note.md"]').click()
  await expect(editor(page)).toContainText('Intro.')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n/table')
  await expect(page.getByRole('option', { name: /Table/ })).toBeVisible()
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
