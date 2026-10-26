import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

const cliEntry = path.resolve(import.meta.dirname, '../../src/cli/index.js')

test.use({ files: { 'notes/inbox.md': '# Inbox\n\nFirst line.\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')

/** Runs `boostnote` from source on the test vault, as a separate process (like a shell or an agent). */
const cli = (vault: string, ...args: string[]) =>
  promisify(execFile)(process.execPath, [cliEntry, '--vault', vault, ...args])

test('the app reloads a note the CLI appends to, and shows the conflict bar when it is dirty', async ({ app }) => {
  const { page, vault, electronApp } = app
  const label = await electronApp.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('install-cli')?.label,
  )
  expect(label).toBe(process.platform === 'win32' ? 'Command Line Tool…' : 'Install Command Line Tool…')

  await page.locator('[data-folder="notes"]').click()
  await page.locator('[data-note="notes/inbox.md"]').click()
  await expect(editor(page)).toContainText('First line.')
  await cli(vault, 'append', 'inbox', '- [ ] added by the CLI')
  await expect(editor(page)).toContainText('added by the CLI', { timeout: 15_000 })
  await expect(page.locator('[data-conflict]')).toHaveCount(0)

  // Unsaved typing (autosave waits for a pause) while the CLI writes: the app must not overwrite it.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  let done = false
  const write = cli(vault, 'append', 'inbox', 'second CLI line').finally(() => {
    done = true
  })
  while (!done) await page.keyboard.type('x', { delay: 100 })
  await write
  for (let i = 0; i < 10; i++) await page.keyboard.type('y', { delay: 100 })
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  // "Load theirs" takes the CLI's version (so the app can quit without asking about unsaved work).
  await page.getByRole('button', { name: 'Load theirs' }).click()
  await expect(editor(page)).toContainText('second CLI line')
  await expect(page.locator('[data-conflict]')).toHaveCount(0)
})
