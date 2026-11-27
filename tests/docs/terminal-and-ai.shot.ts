import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from './fixtures.ts'

const cliEntry = path.resolve(import.meta.dirname, '../../src/cli/index.js')

test('the conflict bar after the CLI changes a note with unsaved edits', async ({ docsApp }) => {
  const { page, vault } = docsApp
  const editor = page.locator('[data-editor] .cm-content')
  await page.locator('[data-folder="Personal"]').click()
  await page.locator('[data-note="Personal/Travel plans.md"]').click()
  await expect(editor).toContainText('Find a cooking class.')

  // Keep typing (autosave waits for a pause) while the CLI appends, so the app holds unsaved edits.
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  let done = false
  const write = promisify(execFile)(process.execPath, [
    cliEntry,
    '--vault',
    vault,
    'append',
    'Travel plans',
    '- Book the train to Porto.',
  ]).finally(() => {
    done = true
  })
  const words = '- Ask Priya about a day in Porto.'
  let typed = 0
  while (!done && typed < words.length) await page.keyboard.type(words.charAt(typed++), { delay: 80 })
  await write
  // Finish the line; the edits stay unsaved until the bar is answered.
  await page.keyboard.type(words.slice(typed), { delay: 80 })
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  await docsApp.shot('terminal-and-ai-conflict-bar')
})
