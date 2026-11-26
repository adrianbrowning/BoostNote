import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

import { expect, test } from './fixtures.ts'

test.use({ files: { 'doc.mdx': '# Doc\n\n<Callout type="x">inner</Callout>\n' } })

test('an .mdx note opens in the editor and edits are saved to the .mdx file', async ({ app }) => {
  const { page, vault } = app
  const note = page.locator('[data-note="doc.mdx"]')
  await expect(note).toBeVisible()
  await note.click()
  const editor = page.locator('[data-editor] .cm-content')
  await expect(editor).toContainText('<Callout type="x">inner</Callout>')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nTyped in MDX.')
  await expect
    .poll(() => readFile(path.join(vault, 'doc.mdx'), 'utf8').catch(() => ''), { timeout: 10_000 })
    .toContain('Typed in MDX.')
})
