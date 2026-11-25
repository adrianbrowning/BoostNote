import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { type AppHandle, expect, test } from './fixtures.ts'

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
})
