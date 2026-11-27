import type { Page } from '@playwright/test'

import type { DocsApp } from './fixtures.ts'
import { expect, test } from './fixtures.ts'

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const scratchTab = (page: Page) => page.locator('[role="tab"][data-scratch-tab]')

/** Opens Welcome, then a new scratch note, and types `text` into it. */
async function newScratch(docsApp: DocsApp, text: string): Promise<void> {
  const { page } = docsApp
  await page.locator('[data-note="Welcome.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Welcome')
  await docsApp.clickMenu('new-scratch-note')
  await expect(scratchTab(page)).toHaveAttribute('aria-selected', 'true')
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).not.toHaveAttribute('aria-readonly', 'true')
  await page.keyboard.type(text)
  await expect(scratchTab(page)).toContainText(text.split('\n')[0]?.replace(/^# /, '') ?? '')
}

/** A new scratch note with `text`, then its tab closed, so the scratch list keeps it. */
async function keepScratch(docsApp: DocsApp, text: string): Promise<void> {
  await newScratch(docsApp, text)
  await docsApp.clickMenu('close-tab')
  await expect(scratchTab(docsApp.page)).toHaveCount(0)
  await expect(editor(docsApp.page)).not.toHaveAttribute('aria-readonly', 'true')
}

test('a new scratch note with its banner', async ({ docsApp }) => {
  const { page } = docsApp
  await newScratch(docsApp, '# Call back Sam\n\nAbout the venue for Friday.')
  await expect(page.locator('[data-scratch-banner]')).toBeVisible()
  await expect(page.locator('[data-save-status]')).toHaveText('Saved')
  // Unfocused, so the editor draws no cursor.
  await editor(page).blur()
  await docsApp.shot('quick-capture-scratch-note')
})

test('the Scratch list in the sidebar', async ({ docsApp }) => {
  const { page } = docsApp
  await keepScratch(docsApp, '# Gift ideas\n\nA book for Mum.')
  await keepScratch(docsApp, '# Call back Sam\n\nAbout the venue for Friday.')
  const list = page.getByRole('navigation', { name: 'Vault' }).getByRole('region', { name: 'Scratch' })
  await expect(list.locator('[data-scratch-row]')).toHaveCount(2)
  await docsApp.shot('quick-capture-scratch-list', list, { padding: 4 })
})

test('the Save to vault dialog', async ({ docsApp }) => {
  const { page } = docsApp
  await newScratch(docsApp, '# Call back Sam\n\nAbout the venue for Friday.')
  await page.locator('[data-scratch-save]').click()
  const dialog = page.getByRole('dialog', { name: 'Save to vault' })
  await dialog.locator('select').selectOption('Work')
  await docsApp.shot('quick-capture-save-to-vault', dialog, { padding: 16 })
})

test.describe('with the default show/hide hotkey', () => {
  test.use({ ui: { globalHotkey: 'CommandOrControl+Shift+Space' } })

  test('the two hotkeys in Preferences, Quick capture just recorded', async ({ docsApp }) => {
    const { page } = docsApp
    await expect(page.locator('[data-note="Welcome.md"]')).toBeVisible()
    await docsApp.clickMenu('preferences')
    const dialog = page.getByRole('dialog', { name: 'Preferences' })
    const show = dialog.getByRole('group', { name: 'Show/hide Boostnote from anywhere' })
    await expect(show.locator('[data-hotkey-status]')).toHaveText('Active.')
    await docsApp.shot('quick-capture-show-hide-hotkey', show, { padding: 8 })

    const capture = dialog.getByRole('group', { name: 'Quick capture: a new scratch note from anywhere' })
    await expect(capture.locator('[data-hotkey-status]')).toHaveText('No Quick capture hotkey.')
    await capture.locator('[data-hotkey-record]').click()
    await page.keyboard.press('ControlOrMeta+Alt+Shift+K')
    await expect(capture.locator('[data-hotkey-status]')).toHaveText(/^Registered .+\+Alt\+Shift\+K\.$/)
    await capture.locator('[data-hotkey-record]').blur()
    await docsApp.shot('quick-capture-hotkey', capture, { padding: 8 })
  })
})
