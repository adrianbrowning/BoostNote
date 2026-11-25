import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { captureContextMenus, expect, test } from './fixtures.ts'

test.use({ files: { 'spelling.md': '# Spelling\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')

/** The viewport centre of the first `word` in the editor's text. */
async function wordCentre(page: Page, word: string): Promise<{ x: number; y: number }> {
  return editor(page).evaluate((content, target) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(target) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + target.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    throw new Error(`no ${target} in the editor`)
  }, word)
}

test('a spelling suggestion from the native menu replaces the word, is saved and undoes', async ({ app }) => {
  const { page, vault, electronApp } = app
  const file = path.join(vault, 'spelling.md')
  const menus = await captureContextMenus(electronApp)
  await page.locator('[data-note="spelling.md"]').click()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  // Chromium marks a typed sentence once a space ends it; text loaded into the editor stays unchecked.
  await page.keyboard.type('\nThe wrod is here. ')
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toContain('\nThe wrod is here.')

  // Marking runs after the typing, so right-click until the menu leads with a suggestion (Cut first
  // means Chromium marked no word).
  const word = await wordCentre(page, 'wrod')
  let suggestion: string | undefined
  try {
    await expect
      .poll(
        async () => {
          await page.mouse.click(word.x, word.y, { button: 'right' })
          const first = (await menus.labels()).at(-1)?.[0]
          suggestion = first === 'Cut' || first === 'No suggestions' ? undefined : first
          return suggestion
        },
        { timeout: 10_000 },
      )
      .toBeDefined()
  } catch (error) {
    // macOS always has the system checker; elsewhere Chromium may have no dictionary to mark with.
    test.skip(
      process.platform !== 'darwin',
      `Chromium marks no misspelled word on ${process.platform}: no spellcheck dictionary (manual check in PLAN.md)`,
    )
    throw error
  }
  if (suggestion === undefined) throw new Error('unreachable: the poll above found a suggestion')

  await menus.click(suggestion)
  await expect(editor(page)).toContainText(`The ${suggestion} is here.`)
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toContain(`\nThe ${suggestion} is here.`)
  expect(await readFile(file, 'utf8')).not.toContain('wrod')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).toContainText('The wrod is here.')
})
