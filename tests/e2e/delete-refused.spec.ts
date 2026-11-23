import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, failableSaves, test } from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n\nStart.\n', 'work/n.md': '# N\n\nStart.\n' }, ui: { confirmDelete: false } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const notice = (page: Page) => page.locator('[data-notice][data-kind="error"]')

/** Opens note `id` and types "Mine." at its end while its saves fail, leaving the editor: the error bar shows. */
async function typeUnsavable(page: Page, id: string) {
  await page.locator(`[data-note="${id}"]`).click()
  await expect(editor(page)).toContainText('Start.')
  const saves = await failableSaves(page)
  await saves.fail(true)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nMine.')
  await editor(page).blur()
  await expect(page.locator('[data-conflict="error"]')).toBeVisible({ timeout: 20_000 })
  return saves
}

test('deleting the open note while its save fails is refused: the note stays on disk, open with its edits', async ({
  app,
}) => {
  const { page, vault } = app
  await typeUnsavable(page, 'a.md')

  await page.locator('[data-note="a.md"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(notice(page)).toContainText('unsaved changes that could not be saved')
  expect(await readFile(path.join(vault, 'a.md'), 'utf8')).toBe('# A\n\nStart.\n')
  await expect(page.locator('[data-note="a.md"]')).toHaveCount(1)
  await expect(page.locator('[role="tab"][data-tab="a.md"]')).toHaveCount(1)
  await expect(editor(page)).toContainText('Mine.')
})

test('deleting the folder of the open note while that note is in conflict is refused, trashing nothing', async ({
  app,
}) => {
  const { page, vault } = app
  const saves = await typeUnsavable(page, 'work/n.md')
  const file = path.join(vault, 'work/n.md')
  await writeFile(file, '# N\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  await saves.fail(false)

  await page.locator('[data-folder="work"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(notice(page)).toContainText('unsaved changes that could not be saved')
  expect(await readFile(file, 'utf8')).toBe('# N\n\nTheirs.\n')
  await expect(page.locator('[data-folder="work"]')).toHaveCount(1)
  await expect(editor(page)).toContainText('Mine.')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible()
})
