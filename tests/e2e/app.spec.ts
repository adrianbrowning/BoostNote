import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

test('Cmd-click on a `note.md/#anchor` link opens the note', async ({ app }) => {
  const { page, vault } = app
  await writeFiles(vault, { 'book.md': 'See [the second chapter](second.md/#user-content-intro) for more.\n' })
  await expect(page.locator('[data-note="book.md"]')).toBeAttached({ timeout: 15_000 })
  await page.locator('[data-note="book.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('book')
  await page
    .locator('[data-editor] .cm-lp-link')
    .first()
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('[data-note-title]')).toHaveText('second')
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
    // capturePage() before the first frame fails with UnknownVizError on GPU-less CI runners;
    // a hidden window still paints, and `ready-to-show` fires after that first paint.
    const painted = Promise.withResolvers<void>()
    window.once('ready-to-show', () => painted.resolve())
    await window.loadFile(file)
    await painted.promise
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

test('opens .md files from the command line and through open-file in the vault that holds them', async () => {
  const app = await launchApp(
    { 'inside.md': '# Inside\n', 'other/b.md': '# Bee\n', 'c.md': '# Cee\n', 'd.md': '# Dee\n' },
    { openFiles: { 'readme.md': '# Loose readme\n' } },
  )
  try {
    const { page } = app
    const openFiles = (...files: string[]) =>
      app.electronApp.evaluate(({ app: electronApp }, targets) => {
        for (const target of targets) electronApp.emit('open-file', { preventDefault() {} }, target)
      }, files)
    await expect(page.locator('[data-reader-tab="readme.md"]')).toBeVisible({ timeout: 20_000 })

    // macOS Finder / `open -a` (`open-file`), in a subfolder of the open vault: a note of that vault.
    await openFiles(path.join(app.vault, 'other', 'b.md'))
    await expect(page.locator('[data-note-title]')).toHaveText('b', { timeout: 20_000 })
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'other/b.md')

    // Two open-file events back to back: both open, in order (each one also sends its own SSE event).
    await openFiles(path.join(app.vault, 'c.md'), path.join(app.vault, 'd.md'))
    await expect(page.locator('[data-note-title]')).toHaveText('d', { timeout: 20_000 })
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'd.md')
    await expect(page.locator('[role="tab"][data-tab="c.md"]')).toBeVisible()
  } finally {
    await app.electronApp.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('opens a .md outside every vault read-only in a reader tab, without touching the vault', async () => {
  const app = await launchApp(
    { 'inside.md': '# Inside\n' },
    { openFiles: { 'readme.md': '# Loose readme\n\nSome *text*.\n' } },
  )
  try {
    const { page, dir } = app
    const openFiles = (...files: string[]) =>
      app.electronApp.evaluate(({ app: electronApp }, targets) => {
        for (const target of targets) electronApp.emit('open-file', { preventDefault() {} }, target)
      }, files)
    const readme = path.join(dir, 'loose', 'readme.md')
    const reader = page.locator('[role="tab"][data-reader-tab="readme.md"]')

    // argv: the rendered file in a reader tab; the vault, Recent and lastVault stay as they were.
    await expect(reader).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await expect(page.locator('[data-reader-banner]')).toContainText('readme.md is not in a vault')
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')
    await expect(page.locator('[data-reader-body] em')).toHaveText('text')
    await expect(page.locator('[data-editor]')).toBeHidden()
    await expect(page.locator('[data-note="inside.md"]')).toBeVisible()
    await expect(page.locator('[data-note="readme.md"]')).toHaveCount(0)
    const settings = async () => JSON.parse(await readFile(path.join(app.userDataDir, 'settings.json'), 'utf8'))
    // Main stores the vault's real path (macOS temp folders sit behind the `/var` symlink).
    const vaultRoot = await realpath(app.vault)
    expect(await settings()).toMatchObject({ vaults: [vaultRoot], lastVault: vaultRoot })
    // The page never names the file's path.
    expect(await page.content()).not.toContain(path.join(dir, 'loose'))

    // The same file again activates its tab instead of opening a second one.
    await page.locator('[data-note="inside.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('inside')
    await openFiles(readme)
    await expect(reader).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await expect(page.locator('[data-reader-tab]')).toHaveCount(1)
    // It is read again each time the tab shows.
    await writeFile(readme, '# Edited elsewhere\n')
    await page.locator('[role="tab"][data-tab="inside.md"]').click()
    await reader.click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Edited elsewhere')

    // Closing the vault keeps the reader tab; it is then the only tab.
    await page.locator('[data-vault-switcher]').click()
    await page.getByRole('menuitem', { name: 'Close Vault' }).click()
    await expect(page.locator('[data-vault="none"]')).toBeVisible()
    await expect(page.locator('[role="tab"]')).toHaveCount(1)
    await expect(reader).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Edited elsewhere')

    // With no vault open, another outside file opens in its own reader tab, and a note of a recent
    // vault reopens that vault next to the reader tabs.
    await writeFiles(path.join(dir, 'loose'), { 'second.md': '# Second\n' })
    await openFiles(path.join(dir, 'loose', 'second.md'))
    await expect(page.locator('[role="tab"][data-reader-tab="second.md"]')).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    })
    await expect(page.locator('[data-vault="none"]')).toBeVisible()
    // Each reader tab shows its own file.
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Second')
    await expect(page.locator('[data-reader-banner]')).toContainText('second.md is not in a vault')
    await reader.click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Edited elsewhere')
    await expect(page.locator('[data-reader-banner]')).toContainText('readme.md is not in a vault')
    await openFiles(path.join(app.vault, 'inside.md'))
    await expect(page.locator('[data-note-title]')).toHaveText('inside', { timeout: 20_000 })
    await expect(page.locator('[data-reader-tab]')).toHaveCount(2)

    // Close in the banner closes the tab; the file opened again gets a fresh tab that still reads.
    await reader.click()
    await page.locator('[data-reader-close]').click()
    await expect(reader).toHaveCount(0)
    await expect(page.locator('[data-reader-tab]')).toHaveCount(1)
    await openFiles(readme)
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Edited elsewhere', { timeout: 20_000 })

    // Reader tabs are not restored with the vault's tabs.
    const saved = await page.evaluate((root) => localStorage.getItem(`boostnote.tabs:${root}`), vaultRoot)
    expect(JSON.parse(saved ?? 'null')?.tabs).toEqual(['inside.md'])
  } finally {
    await app.electronApp.close()
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('opens every file queued before the window loads, in order', async () => {
  // Both argv files are queued in main before the page's EventSource connects, so only the
  // workspace's hydration take runs: it has to drain the whole queue.
  const app = await launchApp(
    { 'inside.md': '# Inside\n' },
    { openFiles: { 'one.md': '# One\n', 'two.md': '# Two\n' } },
  )
  try {
    const { page } = app
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-reader-tab', 'two.md', {
      timeout: 20_000,
    })
    const tabs = await page
      .locator('[data-reader-tab]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-reader-tab')))
    expect(tabs).toEqual(['one.md', 'two.md'])
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
