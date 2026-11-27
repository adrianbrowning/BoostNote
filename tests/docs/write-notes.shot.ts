import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { failableSaves } from '../e2e/fixtures.ts'
import { expect, test } from './fixtures.ts'

const editor = (page: Page) => page.locator('[data-editor] .cm-content')

/** Waits until the slash menu takes keys (see tests/e2e/slash-table.spec.ts). */
async function openSlashMenu(page: Page, query: string) {
  await page.keyboard.type(query)
  const menu = page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)')
  await expect(menu).toBeVisible()
  await page.waitForTimeout(100)
  return menu
}

test('a new note, then its name being typed in the header', async ({ docsApp }) => {
  const { page } = docsApp
  await docsApp.clickMenu('new-note')
  await expect(page.locator('[data-note-title]')).toHaveText('Untitled')
  await docsApp.shot('write-notes-new-note')

  await page.locator('[data-rename-note]').click()
  const field = page.locator('[data-note-title-input]')
  await expect(field).toBeFocused()
  await page.keyboard.type('Shopping list')
  await expect(field).toHaveValue('Shopping list')
  await docsApp.shot('write-notes-rename', page.getByRole('main', { name: 'Editor' }).locator('header'))
})

test('live preview: the line with the cursor shows its markers', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()
  // Markers show for the construct holding the cursor: here, the bold word.
  await editor(page).getByText('markers', { exact: true }).click()
  await expect(editor(page)).toContainText('**markers**')
  await docsApp.shot('write-notes-live-preview', undefined, { cursor: true })
})

test('the slash menu and the table size grid', async ({ docsApp }) => {
  const { page } = docsApp
  await docsApp.clickMenu('new-note')
  await expect(page.locator('[data-note-title]')).toHaveText('Untitled')
  await editor(page).click()
  const menu = await openSlashMenu(page, '/')
  await expect(menu.getByRole('option', { name: /Heading 1/ })).toBeVisible()
  await docsApp.shot('write-notes-slash-menu')

  await page.keyboard.type('table')
  await expect(menu.getByRole('option', { name: /Table/ })).toBeVisible()
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter')
  const grid = page.getByRole('dialog', { name: 'Table size' })
  await expect(grid).toBeFocused()
  await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await expect(grid.getByRole('status')).toHaveText('3 × 4')
  await docsApp.shot('write-notes-table-grid', grid, { padding: 16 })
})

test('task progress on Website redesign', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Work/Projects/Website redesign.md"]').click()
  await expect(page.getByRole('progressbar', { name: 'Tasks done' })).toContainText('3/6 · 50%')
  await expect(page.locator('[data-editor] .cm-lp-checkbox')).toHaveCount(6)
  await docsApp.shot('write-notes-tasks')
})

test('a Mermaid diagram and highlighted code in the Markdown tour', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  // The diagram renders once it scrolls into view: scroll down until it is there, then centre it.
  const scroller = page.locator('[data-editor] .cm-scroller')
  const diagram = page.locator('[data-editor] .cm-lp-mermaid')
  await expect(async () => {
    await scroller.evaluate((element) => element.scrollBy(0, 200))
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 20_000 })
  await diagram.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect(editor(page)).toContainText('greet(name: string)')
  await docsApp.shot('write-notes-diagram')
})

test('the conflict bar after another app changed the open note', async ({ docsApp }) => {
  const { page, vault } = docsApp
  await page.locator('[data-note="Personal/Ideas.md"]').click()
  await expect(editor(page)).toContainText('A weekly review template.')
  const saves = await failableSaves(page)
  // Saves fail while typing, so the edit is still unsaved when the file changes on disk.
  await saves.fail(true)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  // The file ends in a newline, so the cursor is on the empty line under the list.
  await page.keyboard.type('- Plant herbs on the balcony.', { delay: 20 })
  await editor(page).blur()
  await expect(page.locator('[data-conflict="error"]')).toBeVisible({ timeout: 20_000 })
  await writeFile(
    path.join(vault, 'Personal/Ideas.md'),
    '---\ntags: [ideas]\ncreated: 2026-11-01T07:45:00Z\nupdated: 2026-11-27T08:00:00Z\n---\n# Ideas\n\n' +
      '- A weekly review template.\n- Export the recipes as a small website for the family.\n' +
      '- Learn to draw diagrams in Mermaid.\n- Start a book club.\n',
  )
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  await saves.fail(false)
  await docsApp.shot('write-notes-conflict')
})
