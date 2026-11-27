import * as path from 'node:path'

import { openLooseFile, writeFiles } from '../e2e/fixtures.ts'
import { expect, test } from './fixtures.ts'

test('the main window with the Markdown tour open', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()
  await docsApp.shot('main-window')
})

test('the welcome screen with no vault open', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-vault-switcher]').click()
  await page.getByRole('menu').getByRole('menuitem').filter({ hasText: 'Close My notes' }).click()
  const welcome = page.getByRole('main', { name: 'Welcome' })
  await expect(welcome).toBeVisible()
  // The Recent list names the vault's temp path; remove the entry as a reader could.
  await welcome.getByRole('button', { name: 'Remove My notes from the list' }).click()
  await expect(welcome.getByRole('region', { name: 'Recent vaults' })).toHaveCount(0)
  await docsApp.shot('get-started-welcome')
})

test('the editor with the sidebar and the note list hidden', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Work/Projects/Website redesign.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Website redesign')
  await docsApp.clickMenu('toggle-sidebar')
  await docsApp.clickMenu('toggle-note-list')
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeHidden()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeHidden()
  await docsApp.shot('get-started-hidden-panes')
})

test('a Markdown file from outside the vault in a reader tab', async ({ docsApp }) => {
  const { page } = docsApp
  await openLooseFile(
    docsApp,
    'readme.md',
    '# Packing list\n\nA file from the *Downloads* folder.\n\n- Passport\n- Charger\n- Rain jacket\n',
  )
  await expect(page.locator('[role="tab"][data-reader-tab="readme.md"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 20_000,
  })
  await expect(page.locator('[data-reader-banner]')).toContainText('readme.md is not in a vault')
  await expect(page.locator('[data-reader-body] h1')).toHaveText('Packing list')
  await docsApp.shot('get-started-reader')
})

test('the vault menu with two open vaults', async ({ docsApp }) => {
  const { page } = docsApp
  const switcher = page.locator('[data-vault-switcher]')
  const menu = page.getByRole('menu')
  await page.locator('[data-note="Welcome.md"]').click()
  const second = path.join(docsApp.dir, 'Archive')
  await writeFiles(second, { 'Old ideas.md': '# Old ideas\n\nNotes from last year.\n' })
  await docsApp.answerOpenDialog(second)
  await docsApp.clickMenu('open-folder')
  await expect(switcher).toContainText('Archive')
  await switcher.click()
  await menu.getByRole('menuitemradio', { name: /^My notes/ }).click()
  await expect(switcher).toContainText('My notes')
  await expect(page.locator('[data-note-title]')).toHaveText('Welcome')
  await switcher.click()
  await expect(menu.getByRole('menuitemradio', { name: /^My notes/ })).toHaveAttribute('aria-checked', 'true')
  await docsApp.shot('get-started-vault-menu')
})
