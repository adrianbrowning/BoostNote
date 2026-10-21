import { readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { createLegacyStorage } from '../migrate/fixture.ts'
import { expect, launchApp, test, writeFiles } from './fixtures.ts'

const DIAGRAM = `---
title: Diagram
tags: [demo]
---
# Diagram

Euler: $e^{i\\pi} + 1 = 0$

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`mermaid
graph TD
  A[Write] --> B[Export]
\`\`\`
`

test.use({
  files: {
    'diagram.md': DIAGRAM,
    'second.md': '# Second\n\nPlain text.\n',
    'work/third.md': '# Third\n',
  },
})

const editor = (page: Page) => page.locator('[data-editor] .cm-content')

test('opens the vault and renders a note with mermaid and KaTeX', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="diagram.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Diagram')
  await expect(page.locator('[data-editor] .cm-lp-mermaid svg')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()
  // Unfocused, the note looks fully rendered: no markdown markers on any line.
  await expect(editor(page)).not.toContainText('# Diagram')
  await page.screenshot({ path: '/tmp/boost-phase6/e2e-note.png' })
})

test('edits are saved to disk', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="second.md"]').click()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nTyped in the app.')
  await expect
    .poll(() => readFile(path.join(vault, 'second.md'), 'utf8'), { timeout: 10_000 })
    .toContain('Typed in the app.')
})

test('external edits reload the open note', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="second.md"]').click()
  await expect(editor(page)).toContainText('Plain text.')
  await writeFile(path.join(vault, 'second.md'), '# Second\n\nChanged on disk.\n')
  await expect(editor(page)).toContainText('Changed on disk.', { timeout: 15_000 })
})

test('tabs are restored after a reload', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="diagram.md"]').click()
  await page.locator('[data-note="second.md"]').click({ modifiers: ['ControlOrMeta'] })
  const tabs = page.locator('[role="tab"]')
  await expect(tabs).toHaveCount(2)
  await page.reload()
  await expect(tabs).toHaveCount(2)
  await expect(page.locator('[role="tab"][data-tab="diagram.md"]')).toBeVisible()
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'second.md')
  await expect(page.locator('[data-note-title]')).toHaveText('Second')
})

test('imports a legacy Boostnote storage through the dialog', async ({ app }) => {
  const { page, dir } = app
  const storage = path.join(dir, 'legacy')
  const target = path.join(dir, 'imported')
  await createLegacyStorage(storage)
  await app.clickMenu('import-storage')
  const dialog = page.getByRole('dialog', { name: 'Import Boostnote storage' })
  await dialog.locator('input[name="source"]').fill(storage)
  await dialog.locator('input[name="target"]').fill(target)
  await dialog.locator('[data-import-preview]').click()
  await expect(dialog.locator('[data-import-summary="preview"]')).toBeVisible()
  await dialog.locator('[data-import-run]').click()
  await expect(dialog.locator('[data-import-summary="done"]')).toBeVisible()
  await dialog.locator('[data-open-imported]').click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-note]').first()).toBeVisible()
  expect(await page.locator('[data-note]').count()).toBeGreaterThan(2)
})

test('exports a note to HTML with mermaid SVG and KaTeX markup', async ({ app }) => {
  const { page, dir } = app
  await page.locator('[data-note="diagram.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Diagram')
  const target = path.join(dir, 'diagram.html')
  await app.answerSaveDialog(target)
  await app.clickMenu('export-html')
  await expect
    .poll(() => readFile(target, 'utf8').catch(() => ''), { timeout: 30_000 })
    .toContain('<div class="mermaid-diagram"><svg')
  const html = await readFile(target, 'utf8')
  expect(html).toContain('class="katex"')
  expect(html).toContain('<math')
  expect(html).not.toContain('<script')

  // The exported file renders on its own.
  const viewer = await app.electronApp.evaluate(async ({ BrowserWindow }, file) => {
    const window = new BrowserWindow({ show: false, width: 900, height: 900 })
    await window.loadFile(file)
    return window.id
  }, target)
  const shot = await app.electronApp.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    if (!window) throw new Error('viewer window is gone')
    const image = await window.webContents.capturePage()
    window.destroy()
    return image.toPNG().toString('base64')
  }, viewer)
  await writeFile('/tmp/boost-phase6/e2e-export-html.png', Buffer.from(shot, 'base64'))
})

test('opens a loose .md file from the command line and through open-file', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' }, { 'readme.md': '# Loose readme\n' })
  try {
    const { page, dir } = app
    // argv: the file's folder becomes the vault and the note opens in a tab.
    await expect(page.locator('[data-note-title]')).toHaveText('Loose readme', { timeout: 20_000 })
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'readme.md')
    await expect(page.locator('[data-note="readme.md"]')).toBeVisible()

    // macOS Finder / `open -a`: the `open-file` event, while the app runs.
    await writeFiles(path.join(dir, 'loose'), { 'other/b.md': '# Bee\n' })
    await app.electronApp.evaluate(
      ({ app: electronApp }, file) => {
        electronApp.emit('open-file', { preventDefault() {} }, file)
      },
      path.join(dir, 'loose', 'other', 'b.md'),
    )
    await expect(page.locator('[data-note-title]')).toHaveText('Bee', { timeout: 20_000 })
    await expect(page.locator('[data-note="b.md"]')).toBeVisible()
  } finally {
    await app.electronApp.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('exports a note to PDF', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="diagram.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Diagram')
  // Kept for inspection (rendered to PNG in the phase 6 smoke run).
  const target = '/tmp/boost-phase6/diagram.pdf'
  await rm(target, { force: true })
  await app.answerSaveDialog(target)
  await app.clickMenu('export-pdf')
  await expect
    .poll(
      () =>
        readFile(target).then(
          (data) => data.length,
          () => 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(10_000)
  expect((await readFile(target)).subarray(0, 5).toString()).toBe('%PDF-')
  await expect(page.getByText(`Exported to ${target}`)).toBeVisible()
})
