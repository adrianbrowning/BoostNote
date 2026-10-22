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
    'tasks.md': '# Tasks\n\n- [x] one\n- [ ] two\n- [ ] three\n',
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
  // The file name is the note's name, not its first heading.
  await expect(page.locator('[data-note-title]')).toHaveText('second')
})

test('renames the open note in place from the editor header', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="second.md"]').click()
  await page.locator('[data-rename-note]').click()
  const field = page.locator('[data-note-title-input]')
  await field.fill('Second: draft')
  await field.press('Enter')
  await expect(page.locator('[data-note-title]')).toHaveText('Second- draft')
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'Second- draft.md')
  await expect.poll(() => readFile(path.join(vault, 'Second- draft.md'), 'utf8')).toContain('Plain text.')

  // A taken name is refused inline; Escape gives up.
  await page.locator('[data-rename-note]').press('F2')
  await field.fill('diagram')
  await field.press('Enter')
  await expect(page.locator('[data-rename-error]')).toContainText('already exists')
  await field.press('Escape')
  await expect(page.locator('[data-rename-error]')).toBeHidden()
  await expect(page.locator('[data-note-title]')).toHaveText('Second- draft')

  // A note named by its frontmatter title: editing changes the title key, not the file.
  await page.locator('[data-note="diagram.md"]').click()
  await page.locator('[data-rename-note]').click()
  await field.fill('Diagrams')
  await field.press('Enter')
  await expect(page.locator('[data-note-title]')).toHaveText('Diagrams')
  await expect.poll(() => readFile(path.join(vault, 'diagram.md'), 'utf8')).toContain('title: Diagrams')
})

test('shows task progress and updates it when a checkbox is ticked', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="tasks.md"]').click()
  const bar = page.getByRole('progressbar', { name: 'Tasks done' })
  await expect(bar).toHaveAttribute('data-task-progress', '33')
  await expect(bar).toContainText('1/3 · 33%')
  await page.locator('[data-editor] .cm-lp-checkbox').nth(1).click()
  await expect(bar).toContainText('2/3 · 66%')
  await expect.poll(() => readFile(path.join(vault, 'tasks.md'), 'utf8')).toContain('- [x] two')
  // No tasks, no bar.
  await page.locator('[data-note="second.md"]').click()
  await expect(bar).toBeHidden()
})

test('renames a new note by typing into the header', async ({ app }) => {
  const { page, vault } = app
  await app.clickMenu('new-note')
  await expect(page.locator('[data-note-title]')).toHaveText('Untitled')
  await page.locator('[data-rename-note]').click()
  const field = page.locator('[data-note-title-input]')
  await expect(field).toBeFocused()
  // Real key presses, one input event each (fill() sets the value at once and missed a bug where
  // every keystroke was reverted).
  await page.keyboard.type('Weekly plan')
  await expect(field).toHaveValue('Weekly plan')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-note-title]')).toHaveText('Weekly plan')
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'Weekly plan.md')
  await expect
    .poll(() =>
      readFile(path.join(vault, 'Weekly plan.md'), 'utf8').then(
        () => true,
        () => false,
      ),
    )
    .toBe(true)
})

test('renames slug-named files from their titles', async ({ app }) => {
  const { page, vault } = app
  await writeFiles(vault, {
    'work/meeting-notes.md': '# Meeting notes\n\n[third](./third.md)\n',
    'links.md': '[m](work/meeting-notes.md)\n',
  })
  await expect(page.locator('[data-note="work/meeting-notes.md"]')).toBeAttached({ timeout: 15_000 })
  await page.locator('[data-note="work/meeting-notes.md"]').click()
  await app.clickMenu('rename-from-titles')
  const dialog = page.getByRole('dialog', { name: 'Rename files from titles' })
  await expect(dialog.locator('[data-title-rename="work/meeting-notes.md"]')).toContainText('Meeting notes')
  await dialog.locator('[data-title-renames-apply]').click()
  await expect(dialog.locator('[data-title-renames-report]')).toContainText('Renamed')
  await dialog.locator('[data-title-renames-close]').click()
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'work/Meeting notes.md')
  expect(await readFile(path.join(vault, 'links.md'), 'utf8')).toBe('[m](work/Meeting%20notes.md)\n')
})

test('imports a legacy Boostnote storage through the dialog', async ({ app }) => {
  const { page, dir } = app
  // Detected at the legacy default location (~/Boostnote) and offered as a button.
  const storage = path.join(dir, 'home', 'Boostnote')
  const target = path.join(dir, 'imported')
  await createLegacyStorage(storage)
  await app.clickMenu('import-storage')
  const dialog = page.getByRole('dialog', { name: 'Import Boostnote storage' })
  const source = dialog.locator('input[name="source"]')
  await dialog.locator(`[data-import-candidate="${storage}"]`).click()
  await expect(source).toHaveValue(storage)
  // Typing over it keeps exactly what was typed (found storages are never written in late).
  await source.fill(`${storage}-typed`)
  await expect(source).toHaveValue(`${storage}-typed`)
  await source.fill(storage)
  await dialog.locator('input[name="target"]').fill(target)
  await expect(source).toHaveValue(storage)
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
    await expect(page.locator('[data-note-title]')).toHaveText('readme', { timeout: 20_000 })
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
    await expect(page.locator('[data-note-title]')).toHaveText('b', { timeout: 20_000 })
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

test.describe('link updates after a rename', () => {
  const LINKER = '# Linker\n\n[s](../second.md#top) and ![a](../second.assets/a.png)\n'

  const renameOpenNote = async (page: Page, name: string) => {
    await page.locator('[data-note="second.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('second')
    await page.locator('[data-rename-note]').click()
    await expect(page.locator('[data-note-title-input]')).toBeFocused()
    await page.keyboard.type(name, { delay: 20 })
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-note-title]')).toHaveText(name)
  }

  test('asks, then rewrites the links on Update links (Enter)', async ({ app }) => {
    const { page, vault } = app
    await writeFiles(vault, { 'work/linker.md': LINKER, 'second.assets/a.png': 'A' })
    await expect(page.locator('[data-note="work/linker.md"]')).toBeAttached({ timeout: 15_000 })
    await renameOpenNote(page, 'Renamed second')

    const dialog = page.getByRole('dialog', { name: 'Update links?' })
    await expect(dialog).toContainText('2 links in 1 note point to “second”.')
    await expect(dialog.locator('[data-link-notes] li')).toHaveText([/linker\s*2 links/])
    await expect(dialog.getByRole('button', { name: 'Update links' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByText('Updated 2 links')).toBeVisible()
    expect(await readFile(path.join(vault, 'work/linker.md'), 'utf8')).toBe(
      '# Linker\n\n[s](../Renamed%20second.md#top) and ![a](../Renamed%20second.assets/a.png)\n',
    )
  })

  test('leaves the linking file byte-identical on Don’t update (Escape)', async ({ app }) => {
    const { page, vault } = app
    await writeFiles(vault, { 'work/linker.md': LINKER })
    await expect(page.locator('[data-note="work/linker.md"]')).toBeAttached({ timeout: 15_000 })
    const before = await readFile(path.join(vault, 'work/linker.md'))
    await renameOpenNote(page, 'Kept links')

    const dialog = page.getByRole('dialog', { name: 'Update links?' })
    await expect(dialog).toContainText('2 links in 1 note point to “second”.')
    await expect(dialog.getByRole('button', { name: 'Don’t update' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-note-title]')).toHaveText('Kept links')
    expect((await readFile(path.join(vault, 'work/linker.md'))).equals(before)).toBe(true)
  })

  test('renaming a folder rewrites links in the open note, which reloads and keeps saving', async ({ app }) => {
    const { page, vault } = app
    await writeFiles(vault, { 'index.md': '# Index\n\n[t](./work/third.md)\n' })
    await expect(page.locator('[data-note="index.md"]')).toBeAttached({ timeout: 15_000 })
    await page.locator('[data-note="index.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('index')

    await page.locator('[data-folder="work"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const prompt = page.getByRole('dialog', { name: 'Rename folder' })
    await expect(prompt.locator('input[name="value"]')).toBeFocused()
    await page.keyboard.type('Projects', { delay: 20 })
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Update links?' })
    await expect(dialog).toContainText('1 link in 1 note points to “work”.')
    await dialog.getByRole('button', { name: 'Update links' }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(() => readFile(path.join(vault, 'index.md'), 'utf8'))
      .toBe('# Index\n\n[t](./Projects/third.md)\n')

    // The editor took the rewritten text: a further edit saves on top of it (no conflict).
    await editor(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('\nMore.', { delay: 20 })
    await expect
      .poll(() => readFile(path.join(vault, 'index.md'), 'utf8'), { timeout: 10_000 })
      .toMatch(/\n# Index\n\n\[t\]\(\.\/Projects\/third\.md\)\n+More\.$/)
    await expect(page.locator('[data-conflict]')).toHaveCount(0)
  })
})
