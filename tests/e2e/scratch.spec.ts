import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import {
  type AppHandle,
  expect,
  pressGlobalShortcut,
  readSettings,
  relaunchApp,
  takeGlobalShortcut,
  test,
  writeFiles,
} from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const scratchTab = (page: Page) => page.locator('[role="tab"][data-scratch-tab]')

/** The text of each scratch note file under `<userData>/scratch`, by file name (none yet: `{}`). */
async function scratchFiles({ userDataDir }: Pick<AppHandle, 'userDataDir'>): Promise<Record<string, string>> {
  const dir = path.join(userDataDir, 'scratch')
  const names = await readdir(dir).catch(() => [])
  const files: Record<string, string> = {}
  for (const name of names.filter((file) => file.endsWith('.md'))) {
    files[name] = await readFile(path.join(dir, name), 'utf8').catch(() => '')
  }
  return files
}

/** Closes the vault on screen from the vault menu; the page then has no vault. */
async function closeVault(page: Page): Promise<void> {
  await page.locator('[data-vault-switcher]').click()
  // The text entry, not the open vault's ×, which has the same accessible name.
  await page.getByRole('menu').getByRole('menuitem').filter({ hasText: 'Close vault' }).click()
  await expect(page.locator('[data-vault="none"]')).toBeVisible()
}

test('New Scratch Note opens a focused scratch tab whose text autosaves outside the vault, and stays when the vault closes', async ({
  app,
}) => {
  const { page, vault } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const vaultFiles = await readdir(vault, { recursive: true })

  await app.clickMenu('new-scratch-note')
  const tab = scratchTab(page)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab.locator('[data-scratch-badge]')).toHaveText('Scratch')
  await expect(editor(page)).toBeFocused()

  await page.keyboard.type('# Groceries\n\nMilk')
  await expect(tab).toContainText('Groceries')
  const id = await tab.getAttribute('data-scratch-tab')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: '# Groceries\n\nMilk' })
  expect((await readdir(vault, { recursive: true })).sort()).toEqual(vaultFiles.sort())

  await closeVault(page)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toContainText('Milk')
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and eggs')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: '# Groceries\n\nMilk and eggs' })
})

test('New Scratch Note works with no vault open: its tab shows in the editor and typing saves it', async ({ app }) => {
  const { page } = app
  await closeVault(page)
  await expect(page.getByRole('main', { name: 'Welcome' })).toBeVisible()

  await app.clickMenu('new-scratch-note')
  const tab = scratchTab(page)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab.locator('[data-scratch-badge]')).toHaveText('Scratch')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('Call the plumber')
  await expect(tab).toContainText('Call the plumber')
  const id = await tab.getAttribute('data-scratch-tab')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'Call the plumber' })

  const save = page.locator('[data-scratch-save]')
  await expect(save).toHaveText('Save to vault…')
  await expect(save).toBeDisabled()
  await expect(save).toHaveAccessibleDescription('Open a vault to save this scratch note to it')
  await expect(page.locator('[data-scratch-save-reason]')).toBeVisible()
})

test('closing a scratch tab with nothing typed removes its file; one with text keeps its file', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="a.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('a')

  await app.clickMenu('new-scratch-note')
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => Object.keys(await scratchFiles(app)).length).toBe(1)
  await app.clickMenu('close-tab')
  await expect(scratchTab(page)).toHaveCount(0)
  // Nothing at all stays: neither the note nor its `<id>.json` sidecar.
  await expect.poll(() => readdir(path.join(app.userDataDir, 'scratch')).catch(() => [])).toEqual([])
  // The close's hold loads a.md after that discard and keeps the editor read-only until it settles: keys typed into
  // the next scratch tab before then would be dropped.
  await expect(editor(page)).toContainText('A')
  await expect(editor(page)).not.toHaveAttribute('aria-readonly', 'true')

  await app.clickMenu('new-scratch-note')
  const tab = scratchTab(page)
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).not.toHaveAttribute('aria-readonly', 'true')
  await page.keyboard.type('Keep this')
  const id = await tab.getAttribute('data-scratch-tab')
  await app.clickMenu('close-tab')
  await expect(tab).toHaveCount(0)
  // The close's discard decision runs inside its hold, which keeps the next note's (a.md's) editor read-only until it
  // settles.
  await expect(editor(page)).toContainText('A')
  await expect(editor(page)).not.toHaveAttribute('aria-readonly', 'true')
  expect(await scratchFiles(app)).toEqual({ [`${id}.md`]: 'Keep this' })
})

test('a scratch tab shows the vault-note banner and none of the note header buttons; its relative links are inert, http(s) links and Find work', async ({
  app,
}) => {
  const { page } = app
  // Record instead of opening a real browser.
  await app.electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { openedUrls: opened })
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  const opened = () => app.electronApp.evaluate((): unknown => Reflect.get(globalThis, 'openedUrls'))
  await page.locator('[data-note="a.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('a')

  await app.clickMenu('new-scratch-note')
  const tab = scratchTab(page)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-scratch-banner] > span')).toHaveText(
    'Scratch note, kept outside the vault. Links to notes, images and properties need a vault note.',
  )
  const editorPane = page.getByRole('main', { name: 'Editor' })
  for (const name of ['Properties', 'Pin note', 'Star note', 'Note actions']) {
    await expect(editorPane.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(page.locator('[data-rename-note]')).toHaveCount(0)

  await page.keyboard.type('See [the note](a.md) and [site](https://example.com/)\n\nEnd')
  const links = page.locator('[data-editor] .cm-lp-link')
  await links.filter({ hasText: 'the note' }).click({ modifiers: ['ControlOrMeta'] })
  await links.filter({ hasText: 'site' }).click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(opened).toEqual(['https://example.com/'])
  // The relative .md link opened nothing: the scratch tab is still the active one, and no tab was added.
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab')).toHaveCount(2)
  await expect(page.locator('[data-note-title]')).toHaveCount(0)

  await app.clickMenu('find')
  await expect(page.locator('[data-editor] .cm-search')).toBeVisible()
})

test('Toggle Properties opens no properties panel in a scratch tab, nor for the note shown after it', async ({
  app,
}) => {
  const { page } = app
  await page.locator('[data-note="a.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('a')
  await app.clickMenu('new-scratch-note')
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')

  // View › Toggle Properties (⇧⌘P is its native menu accelerator, the same command).
  await app.clickMenu('toggle-properties')
  await expect(page.locator('[data-properties]')).toHaveCount(0)

  await page.locator('[role="tab"][data-tab="a.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('a')
  await expect(page.locator('[data-toggle-properties]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-properties]')).toHaveCount(0)
})

test('an image pasted over selected text in a scratch tab is refused with the notice and keeps the text, writing no file', async ({
  app,
}) => {
  const { page, vault } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const vaultFiles = (await readdir(vault, { recursive: true })).sort()
  await app.clickMenu('new-scratch-note')
  const tab = scratchTab(page)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('Keep this')
  const id = await tab.getAttribute('data-scratch-tab')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'Keep this' })

  await page.keyboard.press('ControlOrMeta+a')
  await editor(page).evaluate((target) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }))
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-notice]')).toContainText(
    'Images need a vault note: save this scratch note to the vault to add images.',
  )
  await expect(editor(page)).toHaveText('Keep this')
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('!')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'Keep this!' })
  // Only the note (and its creation-time sidecar): no image file.
  const names = await readdir(path.join(app.userDataDir, 'scratch'))
  expect(names.filter((name) => name !== `${id}.md` && name !== `${id}.json`)).toEqual([])
  expect((await readdir(vault, { recursive: true })).sort()).toEqual(vaultFiles)
})

test('a scratch tab comes back after a restart, active, with its text, and Save to vault turns it into a note’s tab', async ({
  app,
}) => {
  await expect(app.page.locator('[data-note="a.md"]')).toBeVisible()
  await app.page.locator('[data-note="a.md"]').click()
  await expect(app.page.locator('[data-note-title]')).toHaveText('a')
  await app.clickMenu('new-scratch-note')
  await expect(editor(app.page)).toBeFocused()
  await app.page.keyboard.type('# Kept\n\nAcross restarts')
  const id = (await scratchTab(app.page).getAttribute('data-scratch-tab')) ?? ''
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: '# Kept\n\nAcross restarts' })
  // A folder to save into, seeded by this test.
  await writeFiles(app.vault, { 'work/plan.md': '# Plan\n' })

  await relaunchApp(app)
  const { page } = app
  await expect(page.locator('[role="tab"][data-tab="a.md"]')).toBeVisible()
  await expect(scratchTab(page)).toHaveAttribute('data-scratch-tab', id)
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(scratchTab(page)).toContainText('Kept')
  await expect(editor(page)).toContainText('Across restarts')
  await expect(page.locator('[data-notice]')).toHaveCount(0)
  // A note tab after the scratch tab: the save must turn the scratch tab into the note's, not close it and append.
  await page.locator('[data-note="work/plan.md"]').click({ modifiers: ['ControlOrMeta'] })
  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveCount(3)
  await expect(tabs.nth(2)).toHaveAttribute('data-tab', 'work/plan.md')
  await scratchTab(page).click()
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')

  await page.locator('[data-scratch-save]').click()
  const dialog = page.getByRole('dialog', { name: 'Save to vault' })
  await dialog.locator('select').selectOption('work')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(tabs.nth(1)).toHaveAttribute('data-tab', 'work/Kept.md')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs).toHaveCount(3)
  expect(await tabs.evaluateAll((all) => all.map((tab) => tab.getAttribute('data-tab')))).toEqual([
    'a.md',
    'work/Kept.md',
    'work/plan.md',
  ])
  await expect(page.locator('[data-note-title]')).toHaveText('Kept')
  await expect(page.locator('[data-note="work/Kept.md"]')).toBeVisible()
  expect(await readFile(path.join(app.vault, 'work', 'Kept.md'), 'utf8')).toMatch(
    /^---\ncreated: .+\nupdated: .+\n---\n# Kept\n\nAcross restarts$/,
  )
  expect(await scratchFiles(app)).toEqual({})
  expect((await readdir(path.join(app.userDataDir, 'scratch'))).sort()).toEqual([])
})

test('a scratch tab comes back after a restart with no vault open', async ({ app }) => {
  await app.clickMenu('new-scratch-note')
  await expect(editor(app.page)).toBeFocused()
  await app.page.keyboard.type('No vault needed')
  const id = (await scratchTab(app.page).getAttribute('data-scratch-tab')) ?? ''
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'No vault needed' })
  await closeVault(app.page)

  await relaunchApp(app)
  const { page } = app
  await expect(page.locator('[data-vault="none"]')).toBeVisible()
  await expect(scratchTab(page)).toHaveAttribute('data-scratch-tab', id)
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toHaveText('No vault needed')
  await expect(page.locator('[data-notice]')).toHaveCount(0)
})

const scratchRow = (page: Page) => page.locator('[data-scratch-row]')

/** Opens a new scratch note, types `text` into it and closes its tab; its id. */
async function keepScratch(app: AppHandle, text: string): Promise<string> {
  await app.clickMenu('new-scratch-note')
  await expect(editor(app.page)).toBeFocused()
  await app.page.keyboard.type(text)
  const id = (await scratchTab(app.page).getAttribute('data-scratch-tab')) ?? ''
  await app.clickMenu('close-tab')
  await expect(scratchTab(app.page)).toHaveCount(0)
  return id
}

test('a scratch note closed with text is listed in the sidebar Scratch section by title; its row opens it again', async ({
  app,
}) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const id = await keepScratch(app, '# Groceries\n\nMilk')

  const list = page.getByRole('navigation', { name: 'Vault' }).getByRole('region', { name: 'Scratch' })
  await expect(list.locator('[data-scratch-row]')).toHaveCount(1)
  await expect(list.locator(`[data-scratch-row="${id}"] [data-scratch-open]`)).toHaveText('Groceries')
  await expect(list.getByRole('button', { name: 'Save to vault…' })).toBeEnabled()

  await list.locator('[data-scratch-open]').click()
  await expect(scratchTab(page)).toHaveAttribute('data-scratch-tab', id)
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toContainText('Milk')
  expect(await scratchFiles(app)).toEqual({ [`${id}.md`]: '# Groceries\n\nMilk' })
})

test('a scratch row’s Save to vault… saves the note into the chosen folder and opens it', async ({ app }) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  await keepScratch(app, '# Groceries\nMilk')

  await scratchRow(page).getByRole('button', { name: 'Save to vault…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save to vault' })
  await dialog.locator('select').selectOption('')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(scratchRow(page)).toHaveCount(0)
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'Groceries.md')
  await expect(page.locator('[data-note="Groceries.md"]')).toBeVisible()
  expect(await readdir(path.join(app.userDataDir, 'scratch'))).toEqual([])
})

test('Discard with confirmDelete on asks first: Cancel keeps the row and its tab, Discard deletes the file, the row and the tab', async ({
  app,
}) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const id = await keepScratch(app, 'Throw away')
  await scratchRow(page).locator('[data-scratch-open]').click()
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')

  await scratchRow(page).getByRole('button', { name: 'Discard' }).click()
  const dialog = page.getByRole('dialog', { name: 'Discard scratch note' })
  await expect(dialog).toContainText('Discard “Throw away”? Its text is deleted for good.')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  // A discard wrongly sent would win over this write: the note's file must take the typed text and keep it.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('!')
  await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'Throw away!' })
  await expect(scratchRow(page)).toHaveCount(1)
  await expect(scratchTab(page)).toHaveCount(1)
  expect(await scratchFiles(app)).toEqual({ [`${id}.md`]: 'Throw away!' })

  await scratchRow(page).getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('dialog', { name: 'Discard scratch note' }).getByRole('button', { name: 'Discard' }).click()
  await expect(scratchRow(page)).toHaveCount(0)
  await expect(scratchTab(page)).toHaveCount(0)
  await expect.poll(() => readdir(path.join(app.userDataDir, 'scratch')).catch(() => [])).toEqual([])
})

test.describe('with confirmDelete off', () => {
  test.use({ ui: { confirmDelete: false } })

  test('Discard deletes a kept scratch note without asking', async ({ app }) => {
    const { page } = app
    await expect(page.locator('[data-note="a.md"]')).toBeVisible()
    await keepScratch(app, 'Gone at once')
    await expect(scratchRow(page)).toHaveCount(1)

    await scratchRow(page).getByRole('button', { name: 'Discard' }).click()
    await expect(scratchRow(page)).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => readdir(path.join(app.userDataDir, 'scratch')).catch(() => [])).toEqual([])
  })
})

test('with no vault open the welcome screen lists the kept scratch notes and reopens one', async ({ app }) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const id = await keepScratch(app, 'Call the plumber')
  await closeVault(page)

  const welcome = page.getByRole('main', { name: 'Welcome' })
  const row = welcome.locator(`[data-scratch-row="${id}"]`)
  await expect(row.locator('[data-scratch-open]')).toHaveText('Call the plumber')
  const save = row.getByRole('button', { name: 'Save to vault…' })
  await expect(save).toBeDisabled()
  await expect(save).toHaveAccessibleDescription('Open a vault to save a scratch note to it')

  await row.locator('[data-scratch-open]').click()
  await expect(scratchTab(page)).toHaveAttribute('data-scratch-tab', id)
  await expect(editor(page)).toHaveText('Call the plumber')
})

test('with no vault open and tabs open the scratch list shows beside the editor pane: rows reopen, Save is disabled, Discard works', async ({
  app,
}) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  const first = await keepScratch(app, 'Call the plumber')
  const second = await keepScratch(app, 'Buy stamps')
  await closeVault(page)

  await page.getByRole('main', { name: 'Welcome' }).locator(`[data-scratch-row="${first}"] [data-scratch-open]`).click()
  await expect(scratchTab(page)).toHaveAttribute('data-scratch-tab', first)
  await expect(page.getByRole('main', { name: 'Welcome' })).toHaveCount(0)

  const list = page.getByRole('complementary', { name: 'Scratch notes' }).getByRole('region', { name: 'Scratch' })
  await expect(list.locator('[data-scratch-open]')).toHaveText(['Buy stamps', 'Call the plumber'])
  const row = list.locator(`[data-scratch-row="${second}"]`)
  const save = row.getByRole('button', { name: 'Save to vault…' })
  await expect(save).toBeDisabled()
  await expect(save).toHaveAccessibleDescription('Open a vault to save a scratch note to it')
  await expect(editor(page)).toBeVisible()
  const panel = await page.getByRole('complementary', { name: 'Scratch notes' }).boundingBox()
  const pane = await page.locator('[data-editor]').boundingBox()
  if (!panel || !pane) throw new Error('the scratch panel or the editor pane has no box')
  expect(panel.x + panel.width).toBeLessThanOrEqual(pane.x)
  expect(panel.y).toBeLessThan(pane.y + pane.height)
  expect(pane.y).toBeLessThan(panel.y + panel.height)

  await row.locator('[data-scratch-open]').click()
  await expect(page.locator(`[role="tab"][data-scratch-tab="${second}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toHaveText('Buy stamps')

  await row.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('dialog', { name: 'Discard scratch note' }).getByRole('button', { name: 'Discard' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.locator(`[role="tab"][data-scratch-tab="${second}"]`)).toHaveCount(0)
  await expect(list.locator('[data-scratch-open]')).toHaveText(['Call the plumber'])
  expect(Object.keys(await scratchFiles(app))).toEqual([`${first}.md`])
})

/** Whether the app window is shown (the hidden export windows do not count). */
function appWindowVisible({ electronApp }: Pick<AppHandle, 'electronApp'>): Promise<boolean> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().startsWith('boost://app/') && window.isVisible(),
    ),
  )
}

test.describe('with a Quick capture hotkey', () => {
  test.use({ ui: { captureHotkey: 'CommandOrControl+Alt+Shift+K' } })

  test('the stored Quick capture hotkey shows the hidden window with a new focused scratch tab', async ({ app }) => {
    const { page } = app
    await page.locator('[data-note="a.md"]').click()
    await expect(page.locator('[data-note-title]')).toHaveText('a')
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().startsWith('boost://app/')) window.hide()
      }
    })
    await expect.poll(() => appWindowVisible(app)).toBe(false)

    await pressGlobalShortcut(app, 'CommandOrControl+Alt+Shift+K')
    await expect.poll(() => appWindowVisible(app)).toBe(true)
    const tab = scratchTab(page)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('Captured')
    const id = await tab.getAttribute('data-scratch-tab')
    await expect.poll(() => scratchFiles(app)).toEqual({ [`${id}.md`]: 'Captured' })
  })

  test('the Quick capture hotkey keeps the window shown when it is in front, with a new scratch tab', async ({
    app,
  }) => {
    const { page } = app
    await expect(page.locator('[data-note="a.md"]')).toBeVisible()
    // background-windows.cjs keeps windows unfocused on macOS: report the app window focused, as when it is in front.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.prototype.isFocused = () => true
    })

    await pressGlobalShortcut(app, 'CommandOrControl+Alt+Shift+K')
    await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
    expect(await appWindowVisible(app)).toBe(true)
  })

  test('Preferences says the stored Quick capture hotkey is active, and a refused replacement keeps it working', async ({
    app,
  }) => {
    const { page } = app
    await expect(page.locator('[data-note="a.md"]')).toBeVisible()
    await app.clickMenu('preferences')
    const dialog = page.getByRole('dialog', { name: 'Preferences' })
    const capture = dialog.getByRole('group', { name: 'Quick capture: a new scratch note from anywhere' })
    const status = capture.locator('[data-hotkey-status]')
    await expect(status).toHaveText('Active.')

    await takeGlobalShortcut(app, 'Control+Alt+K')
    await capture.locator('[data-hotkey-record]').click()
    await page.keyboard.press('Control+Alt+K')
    await expect(status).toHaveText('Control+Alt+K could not be registered. Another app may already use it.')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toHaveCount(0)
    expect((await readSettings(app)).ui.captureHotkey).toBe('CommandOrControl+Alt+Shift+K')
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().startsWith('boost://app/')) window.hide()
      }
    })
    await expect.poll(() => appWindowVisible(app)).toBe(false)

    await pressGlobalShortcut(app, 'CommandOrControl+Alt+Shift+K')
    await expect.poll(() => appWindowVisible(app)).toBe(true)
    await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  })
})

test('Preferences records a Quick capture hotkey beside the show/hide hotkey, and says why a taken one is refused', async ({
  app,
}) => {
  const { page } = app
  await expect(page.locator('[data-note="a.md"]')).toBeVisible()
  await app.clickMenu('preferences')
  const dialog = page.getByRole('dialog', { name: 'Preferences' })
  // The Quick capture recorder is the group right after the show/hide one.
  const groups = dialog.getByRole('group')
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(0)).toHaveAccessibleName('Show/hide Boostnote from anywhere')
  await expect(groups.nth(1)).toHaveAccessibleName('Quick capture: a new scratch note from anywhere')
  const capture = dialog.getByRole('group', { name: 'Quick capture: a new scratch note from anywhere' })
  const status = capture.locator('[data-hotkey-status]')
  await expect(capture.locator('[data-hotkey]')).toHaveText('None')
  await expect(status).toHaveText('No Quick capture hotkey.')

  await takeGlobalShortcut(app, 'Control+Alt+K')
  await capture.locator('[data-hotkey-record]').click()
  await page.keyboard.press('Control+Alt+K')
  await expect(status).toHaveText('Control+Alt+K could not be registered. Another app may already use it.')
  await expect(capture.locator('[data-hotkey]')).toHaveText('None')
  expect((await readSettings(app)).ui.captureHotkey).toBe('')

  await capture.locator('[data-hotkey-record]').click()
  await page.keyboard.press('Control+Alt+J')
  await expect(status).toHaveText('Registered Control+Alt+J.')
  await expect(capture.locator('[data-hotkey]')).toHaveText('Control+Alt+J')
  await expect.poll(async () => (await readSettings(app)).ui.captureHotkey).toBe('Control+Alt+J')

  // Esc while recording cancels the recording only: Preferences stays open and nothing is saved.
  await capture.locator('[data-hotkey-record]').click()
  await expect(capture.locator('[data-hotkey]')).toHaveText('Recording…')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(capture.locator('[data-hotkey]')).toHaveText('Control+Alt+J')
  expect((await readSettings(app)).ui.captureHotkey).toBe('Control+Alt+J')

  await dialog.getByRole('button', { name: 'Done' }).click()
  await pressGlobalShortcut(app, 'Control+Alt+J')
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toBeFocused()
})
