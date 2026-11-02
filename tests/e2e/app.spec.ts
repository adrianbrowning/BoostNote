import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { createLegacyStorage } from '../migrate/fixture.ts'
import { expect, launchApp, quitWithoutDialog, test, writeFiles } from './fixtures.ts'

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
    await quitWithoutDialog(app.electronApp)
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

    // Close in the banner closes the tab and revokes its ticket; the file opened again gets a fresh
    // tab that still reads.
    await reader.click()
    const [closeResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /^\/api\/reader\/[^/]+\/close$/.test(new URL(response.url()).pathname),
      ),
      page.locator('[data-reader-close]').click(),
    ])
    expect(closeResponse.status()).toBe(200)
    const closedTicket = new URL(closeResponse.url()).pathname.split('/')[3]
    await expect(reader).toHaveCount(0)
    expect(await page.evaluate((ticket) => fetch(`/api/reader/${ticket}`).then((r) => r.status), closedTicket)).toBe(
      404,
    )
    await expect(page.locator('[data-reader-tab]')).toHaveCount(1)
    await openFiles(readme)
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Edited elsewhere', { timeout: 20_000 })

    // Reader tabs are not restored with the vault's tabs.
    const saved = await page.evaluate((root) => localStorage.getItem(`boostnote.tabs:${root}`), vaultRoot)
    expect(JSON.parse(saved ?? 'null')?.tabs).toEqual(['inside.md'])
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('"Open folder as vault" in a reader opens the file’s folder as the vault and turns the tab into the note’s tab', async () => {
  const app = await launchApp(
    { 'inside.md': '# Inside\n' },
    { openFiles: { 'readme.md': '# Loose readme\n', 'second.md': '# Second\n' } },
  )
  try {
    const { page, dir } = app
    const tabs = page.locator('[role="tab"]')
    const readme = page.locator('[role="tab"][data-reader-tab="readme.md"]')
    await expect(page.locator('[role="tab"][data-reader-tab="second.md"]')).toBeVisible({ timeout: 20_000 })
    await expect(tabs).toHaveCount(2)
    await readme.click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')

    const [response] = await Promise.all([
      page.waitForResponse((r) => /^\/api\/reader\/[^/]+\/open-folder$/.test(new URL(r.url()).pathname)),
      page.locator('[data-reader-open-folder]').click(),
    ])
    expect(response.status()).toBe(200)
    // The page sent the ticket only, no path.
    expect(response.request().postData() ?? '').not.toContain(dir)

    // The reader tab is the note's tab now, at the same position, next to the other reader tab.
    await expect(page.locator('[data-note-title]')).toHaveText('readme', { timeout: 20_000 })
    await expect(tabs.nth(0)).toHaveAttribute('data-tab', 'readme.md')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('data-reader-tab', 'second.md')
    await expect(tabs).toHaveCount(2)
    await expect(page.locator('[data-note="readme.md"]')).toBeVisible()
    await expect(page.locator('[data-note="second.md"]')).toBeVisible()
    await expect(page.locator('[data-vault-switcher]')).toContainText('loose')

    // Recent and lastVault: the folder is the vault now; the ticket is revoked.
    const loose = await realpath(path.join(dir, 'loose'))
    const settings = JSON.parse(await readFile(path.join(app.userDataDir, 'settings.json'), 'utf8'))
    expect(settings).toMatchObject({ lastVault: loose, vaults: [loose, await realpath(app.vault)] })
    const ticket = new URL(response.url()).pathname.split('/')[3]
    expect(await page.evaluate((t) => fetch(`/api/reader/${t}`).then((r) => r.status), ticket)).toBe(404)
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('"Add to vault…" in a reader imports the file and its images into the chosen folder; the tab becomes the note’s', async () => {
  const app = await launchApp(
    { 'inside.md': '# Inside\n', 'work/keep.md': '# Keep\n' },
    { openFiles: { 'readme.md': '# Loose readme\n\n![dot](img/dot.svg)\n', 'second.md': '# Second\n' } },
  )
  try {
    const { page, dir } = app
    const dot = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'
    await writeFiles(path.join(dir, 'loose'), { 'img/dot.svg': dot })
    const tabs = page.locator('[role="tab"]')
    await expect(page.locator('[role="tab"][data-reader-tab="second.md"]')).toBeVisible({ timeout: 20_000 })
    await expect(tabs).toHaveCount(2)
    await page.locator('[role="tab"][data-reader-tab="readme.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')

    // The folder is picked in the page from the open vault's folders (the selected one by default).
    await page.locator('[data-reader-add]').click()
    const dialog = page.getByRole('dialog', { name: 'Add to vault' })
    await expect(dialog.locator('select')).toHaveValue('')
    await dialog.locator('select').selectOption('work')
    const [response] = await Promise.all([
      page.waitForResponse((r) => /^\/api\/reader\/[^/]+\/import$/.test(new URL(r.url()).pathname)),
      dialog.getByRole('button', { name: 'Add' }).click(),
    ])
    expect(response.status()).toBe(201)
    // The page sent the ticket and a folder id, no path.
    expect(response.request().postData() ?? '').not.toContain(dir)

    // The reader tab is the new note's tab now, at the same position; the note is in the tree.
    await expect(page.locator('[data-note-title]')).toHaveText('readme', { timeout: 20_000 })
    await expect(tabs.nth(0)).toHaveAttribute('data-tab', 'work/readme.md')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('data-reader-tab', 'second.md')
    await expect(tabs).toHaveCount(2)
    await expect(page.locator('[data-note="work/readme.md"]')).toBeVisible()
    await expect(page.locator('[data-notice]')).toContainText('Imported 1 note into work (1 image copied)')
    const imported = await readFile(path.join(app.vault, 'work', 'readme.md'), 'utf8')
    const asset = /^# Loose readme\n\n!\[dot\]\(\.\/readme\.assets\/([0-9a-f]+\.svg)\)\n$/.exec(imported)?.[1]
    expect(asset).toBeDefined()
    expect(await readFile(path.join(app.vault, 'work', 'readme.assets', asset ?? ''), 'utf8')).toBe(dot)
    // The outside file stays where it was; its ticket is gone, so a second import is refused.
    expect(await readFile(path.join(dir, 'loose', 'readme.md'), 'utf8')).toBe('# Loose readme\n\n![dot](img/dot.svg)\n')
    const ticket = new URL(response.url()).pathname.split('/')[3]
    const again = await page.evaluate(
      (t) =>
        fetch(`/api/reader/${t}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: '' }),
        }).then((r) => r.status),
      ticket,
    )
    expect(again).toBe(404)

    // With no vault open the button is disabled and says why.
    await page.locator('[data-vault-switcher]').click()
    await page.getByRole('menuitem', { name: 'Close Vault' }).click()
    await expect(page.locator('[data-vault="none"]')).toBeVisible()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Second')
    const add = page.locator('[data-reader-add]')
    await expect(add).toBeDisabled()
    await expect(add).toHaveAccessibleDescription('Open a vault to add this file to it')
    await expect(page.locator('[data-reader-banner]')).toContainText('Open a vault to add this file to it')
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('"Add to vault…" that imports nothing keeps the reader tab, so another folder can be chosen', async () => {
  const app = await launchApp({
    'inside.md': '# Inside\n',
    'work/keep.md': '# Keep\n',
    'README.MD': '# Upper readme\n',
  })
  try {
    const { page } = app
    await expect(page.locator('[data-note="inside.md"]')).toBeVisible({ timeout: 20_000 })
    // An upper-case .MD of the vault is no note there: it opens in a reader tab.
    await app.electronApp.evaluate(
      ({ app: electronApp }, target) => {
        electronApp.emit('open-file', { preventDefault() {} }, target)
      },
      path.join(app.vault, 'README.MD'),
    )
    const reader = page.locator('[role="tab"][data-reader-tab="README.MD"]')
    await expect(reader).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Upper readme')

    // Into its own folder (the vault root, the default): nothing imported, the reader stays.
    await page.locator('[data-reader-add]').click()
    const dialog = page.getByRole('dialog', { name: 'Add to vault' })
    await expect(dialog.locator('select')).toHaveValue('')
    await dialog.getByRole('button', { name: 'Add' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-notice]')).toContainText(
      'Nothing imported: README.MD is already in the vault root',
    )
    await expect(reader).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Upper readme')

    // Into another folder: imported, and the reader tab becomes the note's tab.
    await page.locator('[data-reader-add]').click()
    await dialog.locator('select').selectOption('work')
    await dialog.getByRole('button', { name: 'Add' }).click()
    await expect(page.locator('[data-notice]')).toContainText('Imported 1 note into work')
    await expect(page.locator('[data-reader-tab]')).toHaveCount(0)
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'work/README.md')
    await expect(page.locator('[data-note="work/README.md"]')).toBeVisible()
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

declare global {
  interface Window {
    /** The page-side fetch wrapper of the next test: holds the import's answer, fails saves on demand. */
    importHold?: { held: boolean; failSaves: boolean; release(): void }
    /** The page-side fetch wrapper of the test after it: records requests, fails saves on demand. */
    saveGuard?: { failSaves: boolean; sent: string[] }
  }
}

test('"Add to vault…" answering while another, unsavable note is active turns the reader tab into the note’s and keeps that note', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' }, { openFiles: { 'readme.md': '# Loose readme\n' } })
  try {
    const { page } = app
    const tabs = page.locator('[role="tab"]')
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme', { timeout: 20_000 })
    await page.locator('[data-note="inside.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('inside')
    await page.locator('[role="tab"][data-reader-tab="readme.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')

    // Hold the import's answer (main has imported and revoked the ticket; the page has not heard back
    // yet) and, on demand, fail every save.
    // (`page.route` does not see `boost://` requests, so the page's fetch is wrapped.)
    await page.evaluate(() => {
      const original = window.fetch
      const hold = Promise.withResolvers<void>()
      const state = { held: false, failSaves: false, release: () => hold.resolve() }
      window.importHold = state
      window.fetch = async (input, init) => {
        const pathname = new URL(String(input), location.href).pathname
        if (pathname === '/api/notes/save' && state.failSaves) {
          return new Response(JSON.stringify({ error: 'IO', message: 'Disk full' }), { status: 500 })
        }
        const response = await original(input, init)
        if (/^\/api\/reader\/[^/]+\/import$/.test(pathname)) {
          state.held = true
          await hold.promise
        }
        return response
      }
    })
    const held = () => page.evaluate(() => window.importHold?.held)
    const failSaves = (on: boolean) =>
      page.evaluate((value) => {
        if (window.importHold) window.importHold.failSaves = value
      }, on)

    await page.locator('[data-reader-add]').click()
    await page.getByRole('dialog', { name: 'Add to vault' }).getByRole('button', { name: 'Add' }).click()
    await expect.poll(held, { timeout: 20_000 }).toBe(true)

    // While main's answer is on its way, the user edits another note whose save fails.
    await page.locator('[role="tab"][data-tab="inside.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('inside')
    await failSaves(true)
    await editor(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('\nMine.', { delay: 20 })
    await expect(page.locator('[data-save-state="error"]')).toBeVisible({ timeout: 20_000 })
    await page.evaluate(() => window.importHold?.release())

    // The reader tab is the new note's tab at its position; the edited note stays active and unsaved.
    await expect(tabs.nth(0)).toHaveAttribute('data-tab', 'readme.md', { timeout: 20_000 })
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
    await expect(tabs.nth(1)).toHaveAttribute('data-tab', 'inside.md')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs).toHaveCount(2)
    await expect(page.locator('[data-note-title]')).toHaveText('inside')
    await expect(editor(page)).toContainText('Mine.')
    await expect(page.locator('[data-note="readme.md"]')).toBeVisible()
    await expect(page.locator('[data-notice]')).toContainText('Imported 1 note')
    expect(await readFile(path.join(app.vault, 'readme.md'), 'utf8')).toBe('# Loose readme\n')

    // Saving works again: the edit reaches the disk, so the app quits without asking about it.
    await failSaves(false)
    await page.keyboard.type('More', { delay: 20 })
    await expect
      .poll(() => readFile(path.join(app.vault, 'inside.md'), 'utf8'), { timeout: 20_000 })
      .toMatch(/\n# Inside\n\nMine\.More$/)
  } finally {
    // Saves work again before quitting, so main's flush leaves nothing unsaved and shows no native
    // "Quit Anyway" dialog (which Playwright cannot answer), also when an assertion above failed.
    await app.page
      .evaluate(() => {
        if (window.importHold) window.importHold.failSaves = false
      })
      .catch(() => undefined)
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('"Add to vault…" sends nothing when the open note cannot be saved; the reader and its ticket stay', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' }, { openFiles: { 'readme.md': '# Loose readme\n' } })
  try {
    const { page } = app
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme', { timeout: 20_000 })
    await page.locator('[data-note="inside.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('inside')

    // Record every request and, on demand, fail every save.
    // (`page.route` does not see `boost://` requests, so the page's fetch is wrapped.)
    await page.evaluate(() => {
      const original = window.fetch
      const state: NonNullable<Window['saveGuard']> = { failSaves: false, sent: [] }
      window.saveGuard = state
      window.fetch = (input, init) => {
        const pathname = new URL(String(input), location.href).pathname
        state.sent.push(pathname)
        if (pathname === '/api/notes/save' && state.failSaves) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'IO', message: 'Disk full' }), { status: 500 }))
        }
        return original(input, init)
      }
    })
    const sent = () => page.evaluate(() => window.saveGuard?.sent ?? [])
    const failSaves = (on: boolean) =>
      page.evaluate((value) => {
        if (window.saveGuard) window.saveGuard.failSaves = value
      }, on)
    await page.locator('[role="tab"][data-reader-tab="readme.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')
    const ticket = (await sent()).find((pathname) => /^\/api\/reader\/[^/]+$/.test(pathname))?.split('/')[3]
    expect(ticket).toBeDefined()

    // While the folder is being chosen, the user moves to the note (Next Tab) and edits it; its save fails.
    await page.locator('[data-reader-add]').click()
    const dialog = page.getByRole('dialog', { name: 'Add to vault' })
    await expect(dialog).toBeVisible()
    await app.clickMenu('next-tab')
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'inside.md')
    await failSaves(true)
    await editor(page).focus()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('\nMine.', { delay: 20 })
    await expect(page.locator('[data-save-state="error"]')).toBeVisible({ timeout: 20_000 })
    await dialog.getByRole('button', { name: 'Add' }).click()

    // The save was refused, so the import was never asked for: no note, the ticket is still live.
    await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('could not be saved')
    expect((await sent()).filter((pathname) => pathname.endsWith('/import'))).toEqual([])
    await expect(page.locator('[role="tab"][data-reader-tab="readme.md"]')).toHaveCount(1)
    await expect(page.locator('[data-note="readme.md"]')).toHaveCount(0)
    await expect(readFile(path.join(app.vault, 'readme.md'), 'utf8')).rejects.toThrow()
    expect(await page.evaluate((t) => fetch(`/api/reader/${t}`).then((r) => r.status), ticket)).toBe(200)

    // Once the note saves again, the reader still shows its file.
    await failSaves(false)
    await editor(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('More', { delay: 20 })
    await expect
      .poll(() => readFile(path.join(app.vault, 'inside.md'), 'utf8'), { timeout: 20_000 })
      .toMatch(/\n# Inside\n\nMine\.More$/)
    await page.locator('[role="tab"][data-reader-tab="readme.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')
  } finally {
    // Saves work again before quitting, so main shows no native "Quit Anyway" dialog.
    await app.page
      .evaluate(() => {
        if (window.saveGuard) window.saveGuard.failSaves = false
      })
      .catch(() => undefined)
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('a reader’s Add to vault and vault switch wait for a running open-request drain, so they never interleave', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' })
  try {
    const { page, dir } = app
    // A second known vault, so an `open-file` of its note makes the drain switch vaults.
    const other = path.join(dir, 'other')
    await writeFiles(other, { 'b.md': '# Bee\n' })
    await writeFiles(path.join(dir, 'loose'), { 'readme.md': '# Loose readme\n', 'second.md': '# Second\n' })
    const openVault = (root: string) =>
      page.evaluate(
        (body) =>
          fetch('/api/vaults/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          }).then((r) => r.status),
        JSON.stringify({ path: root }),
      )
    expect(await openVault(other)).toBe(200)
    expect(await openVault(app.vault)).toBe(200)
    await page.reload()
    await expect(page.locator('[data-note="inside.md"]')).toBeVisible({ timeout: 20_000 })
    const openFiles = (...files: string[]) =>
      app.electronApp.evaluate(({ app: electronApp }, targets) => {
        for (const target of targets) electronApp.emit('open-file', { preventDefault() {} }, target)
      }, files)
    await openFiles(path.join(dir, 'loose', 'readme.md'), path.join(dir, 'loose', 'second.md'))
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Second', { timeout: 20_000 })
    await page.locator('[role="tab"][data-reader-tab="readme.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Loose readme')

    // Hold each answer to a drain's vault switch: main has switched, the page has not heard back yet.
    // (`page.route` does not see `boost://` requests, so the page's fetch is wrapped.)
    await page.evaluate(() => {
      const original = window.fetch
      let hold = Promise.withResolvers<void>()
      const state = {
        held: [] as string[],
        sent: [] as string[],
        release() {
          hold.resolve()
          hold = Promise.withResolvers<void>()
        },
      }
      Object.assign(window, { switchHold: state })
      window.fetch = async (input, init) => {
        const pathname = new URL(String(input), location.href).pathname
        state.sent.push(pathname)
        const response = await original(input, init)
        if (pathname === '/api/vaults/open') {
          state.held.push(String(init?.body))
          await hold.promise
        }
        return response
      }
    })
    const hold = () => page.evaluate(() => Reflect.get(window, 'switchHold') as { held: string[]; sent: string[] })
    const release = () => page.evaluate(() => (Reflect.get(window, 'switchHold') as { release(): void }).release())
    const sentTo = async (suffix: string) => (await hold()).sent.filter((pathname) => pathname.endsWith(suffix))

    // Add to vault while the drain switches to the other vault: it waits for the drain, then asks
    // for a folder of the vault the drain left open and imports there.
    await openFiles(path.join(other, 'b.md'))
    await expect
      .poll(async () => (await hold()).held, { timeout: 20_000 })
      .toEqual([JSON.stringify({ path: await realpath(other) })])
    await page.locator('[data-reader-add]').click()
    const dialog = page.getByRole('dialog', { name: 'Add to vault' })
    await page.waitForTimeout(500)
    await expect(dialog).toHaveCount(0)
    await release()
    await expect(page.locator('[data-vault-switcher]')).toContainText('other', { timeout: 20_000 })
    await expect(dialog.locator('option')).toHaveText(['other'])
    await dialog.getByRole('button', { name: 'Add' }).click()
    // The drain left b.md active, so it stays active; the reader tab became readme.md's tab.
    await expect(page.locator('[role="tab"][data-tab="readme.md"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[role="tab"][data-reader-tab="readme.md"]')).toHaveCount(0)
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'b.md')
    await expect(page.locator('[data-note-title]')).toHaveText('b')
    await expect(page.locator('[data-note="readme.md"]')).toBeVisible()
    await expect(page.locator('[data-note="b.md"]')).toBeVisible()
    expect(await readFile(path.join(other, 'readme.md'), 'utf8')).toBe('# Loose readme\n')
    expect(await sentTo('/import')).toHaveLength(1)
    await page.locator('[role="tab"][data-reader-tab="second.md"]').click()
    await expect(page.locator('[data-reader-body] h1')).toHaveText('Second')

    // Open folder as vault while the drain switches back to the first vault: it waits as well.
    await openFiles(path.join(app.vault, 'inside.md'))
    await expect.poll(async () => (await hold()).held.length, { timeout: 20_000 }).toBe(2)
    await page.locator('[data-reader-open-folder]').click()
    await page.waitForTimeout(500)
    expect(await sentTo('/open-folder')).toEqual([])
    await release()

    // The drain finished in the first vault, then the reader's folder became the vault.
    await expect(page.locator('[data-vault-switcher]')).toContainText('loose', { timeout: 20_000 })
    await expect(page.locator('[data-note-title]')).toHaveText('second')
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'second.md')
    await expect(page.locator('[data-note="second.md"]')).toBeVisible()
    await expect(page.locator('[data-notice][data-kind="error"]')).toHaveCount(0)
    const settings = JSON.parse(await readFile(path.join(app.userDataDir, 'settings.json'), 'utf8'))
    expect(settings.lastVault).toBe(await realpath(path.join(dir, 'loose')))
    // The vaults the drains opened kept their notes.
    const saved = async (root: string) =>
      JSON.parse(
        (await page.evaluate((r) => localStorage.getItem(`boostnote.tabs:${r}`), await realpath(root))) ?? 'null',
      )?.tabs
    expect((await saved(other)).sort()).toEqual(['b.md', 'readme.md'])
    expect(await saved(app.vault)).toEqual(['inside.md'])
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('"Opening a .md outside a vault" defaults to Read only; "Open its folder as vault" opens outside files as vaults', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' })
  try {
    const { page, dir } = app
    const openFiles = (...files: string[]) =>
      app.electronApp.evaluate(({ app: electronApp }, targets) => {
        for (const target of targets) electronApp.emit('open-file', { preventDefault() {} }, target)
      }, files)
    await app.clickMenu('preferences')
    const select = page.locator('[data-preferences] select[name="outsideFile"]')
    await expect(select).toHaveValue('reader')
    await expect(select.locator('option')).toHaveText(['Read only', 'Open its folder as vault'])
    await select.selectOption('vault')
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(app.userDataDir, 'settings.json'), 'utf8')).ui?.outsideFile)
      .toBe('vault')
    await page.keyboard.press('Escape')

    // An outside file opens its folder as the vault, as before reader tabs.
    await writeFiles(path.join(dir, 'loose'), { 'readme.md': '# Loose readme\n' })
    await openFiles(path.join(dir, 'loose', 'readme.md'))
    await expect(page.locator('[data-note-title]')).toHaveText('readme', { timeout: 20_000 })
    await expect(page.locator('[data-vault-switcher]')).toContainText('loose')
    await expect(page.locator('[data-reader-tab]')).toHaveCount(0)

    // A note of a recent vault still opens in that vault.
    await openFiles(path.join(app.vault, 'inside.md'))
    await expect(page.locator('[data-note-title]')).toHaveText('inside', { timeout: 20_000 })
    await expect(page.locator('[data-vault-switcher]')).toContainText('vault')
    await expect(page.locator('[data-note="readme.md"]')).toHaveCount(0)
  } finally {
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  }
})

test('a reader tab shows images next to its file; only http(s) links open, in the browser', async () => {
  const app = await launchApp({ 'inside.md': '# Inside\n' })
  try {
    const { page, dir } = app
    // Record instead of opening a real browser.
    await app.electronApp.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedUrls: opened })
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    const opened = () => app.electronApp.evaluate((): unknown => Reflect.get(globalThis, 'openedUrls'))
    // Only pics.md is opened from the OS; its image and the .md it links to just sit next to it.
    await writeFiles(path.join(dir, 'loose'), {
      'pics.md': '# Pics\n\n![dot](img/dot.svg)\n\n[site](https://example.com/) [other](other.md) [[other]]\n',
      'img/dot.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      'other.md': '# Other\n',
    })
    await app.electronApp.evaluate(
      ({ app: electronApp }, target) => {
        electronApp.emit('open-file', { preventDefault() {} }, target)
      },
      path.join(dir, 'loose', 'pics.md'),
    )
    const body = page.locator('[data-reader-body]')
    await expect(body.locator('h1')).toHaveText('Pics', { timeout: 20_000 })
    const image = body.locator('img[alt="dot"]')
    await expect(image).toHaveAttribute('src', /^\/reader-assets\/[0-9a-f]{48}\?src=img%2Fdot\.svg$/)
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(10)

    await body.getByRole('link', { name: 'other' }).click()
    await expect(body).toContainText('[[other]]')
    await body.getByRole('link', { name: 'site' }).click()
    await expect.poll(opened).toEqual(['https://example.com/'])
    // The relative .md link did nothing: still the same reader, no navigation.
    await expect(body.locator('h1')).toHaveText('Pics')
    await expect(page.locator('[data-reader-tab]')).toHaveCount(1)
  } finally {
    await quitWithoutDialog(app.electronApp)
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
    await quitWithoutDialog(app.electronApp)
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
