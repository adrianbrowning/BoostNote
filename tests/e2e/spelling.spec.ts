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

/** Main-process state of the test: `params.misspelledWord` of each `context-menu` event. */
type SpellingCapture = { misspelledWords?: string[] }

test('a spelling suggestion from the native menu replaces the word, is saved and undoes', async ({ app }) => {
  const { page, vault, electronApp } = app
  const file = path.join(vault, 'spelling.md')
  const menus = await captureContextMenus(electronApp)
  // What Chromium reported for each right-click, recorded in main before the menu is built.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const reported: string[] = []
    ;(globalThis as SpellingCapture).misspelledWords = reported
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.on('context-menu', (_event, params) => reported.push(params.misspelledWord))
  })
  await page.locator('[data-note="spelling.md"]').click()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  // Chromium marks a typed sentence once a space ends it; text loaded into the editor stays unchecked.
  await page.keyboard.type('\nThe wrod is here. ')
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toContain('\nThe wrod is here.')

  // Marking runs after the typing, so right-click until a menu pops up that does not lead with Cut
  // (an editable-field menu without spelling items: Chromium marked no word yet).
  const word = await wordCentre(page, 'wrod')
  // The first item of the last menu popped up, read after a completed right-click. expect.poll drops a
  // callback still running at its deadline, so the callback assigns this only after it reads the labels.
  let first: string | undefined
  try {
    await expect
      .poll(
        async () => {
          await page.mouse.click(word.x, word.y, { button: 'right' })
          const label = (await menus.labels()).at(-1)?.[0]
          first = label
          return label !== undefined && label !== 'Cut'
        },
        { timeout: 10_000 },
      )
      .toBe(true)
  } catch (error) {
    // Skip only when Chromium marked no word on any right-click: macOS always has the system checker,
    // elsewhere Chromium may have no dictionary to mark with. A reported word with a menu lacking
    // spelling items is a regression in main and fails the test, as does any other failure.
    const reported = await electronApp.evaluate(() => (globalThis as SpellingCapture).misspelledWords ?? [])
    test.skip(
      process.platform !== 'darwin' && reported.length > 0 && reported.every((w) => w === ''),
      `Chromium marks no misspelled word on ${process.platform}: no spellcheck dictionary (manual check in PLAN.md)`,
    )
    throw error
  }
  if (first === undefined || first === 'No suggestions') throw new Error(`no spelling suggestion: ${first}`)
  const suggestion = first

  await menus.click(suggestion)
  await expect(editor(page)).toContainText(`The ${suggestion} is here.`)
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toContain(`\nThe ${suggestion} is here.`)
  expect(await readFile(file, 'utf8')).not.toContain('wrod')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).toContainText('The wrod is here.')
})
