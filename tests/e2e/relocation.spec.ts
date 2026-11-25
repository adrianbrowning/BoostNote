import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n\n[b](./b.md)\n', 'b.md': '# B\n', 'work/x.md': '# X\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const onDisk = (vault: string, id: string) => () => readFile(path.join(vault, id), 'utf8')
/** The file's text after its frontmatter (saves add `created`/`updated`). */
const body = (vault: string, id: string) => async () => (await onDisk(vault, id)()).replace(/^---\n[\s\S]*?\n---\n/, '')

test('moving the open note shows its rebased links: the next edit saves them, undo works', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="a.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('a')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('Typed.')
  await expect.poll(body(vault, 'a.md'), { timeout: 10_000 }).toBe('# A\n\n[b](./b.md)\nTyped.')

  await page.locator('[data-note="a.md"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move note' })
  await dialog.locator('select').selectOption('work')
  await dialog.getByRole('button', { name: 'Move' }).click()
  await expect(page.locator('[role="tab"][data-tab="work/a.md"]')).toBeVisible()
  // The vault rebased the note's own link on its new folder.
  await expect.poll(body(vault, 'work/a.md')).toBe('# A\n\n[b](../b.md)\nTyped.')

  // Undo history survived the move: the text typed before it is undone, and the rebased link stays.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(body(vault, 'work/a.md'), { timeout: 10_000 }).toBe('# A\n\n[b](../b.md)\n')

  // The next edit saves on top of the rebased text (no stale link, no conflict).
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('More.')
  await expect.poll(body(vault, 'work/a.md'), { timeout: 10_000 }).toBe('# A\n\n[b](../b.md)\nMore.')
  await expect(page.locator('[data-conflict]')).toHaveCount(0)
})
