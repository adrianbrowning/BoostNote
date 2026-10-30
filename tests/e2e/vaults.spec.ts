import { readFile, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test, writeFiles } from './fixtures.ts'

test.use({ files: { 'in first.md': '# In first\n' } })

const switcher = (page: Page) => page.locator('[data-vault-switcher]')
const menu = (page: Page) => page.getByRole('menu')

test('switches between open vaults from the vault menu, each keeping its tabs', async ({ app }) => {
  const { page, dir, vault, userDataDir, answerOpenDialog } = app
  const second = path.join(dir, 'second')
  await writeFiles(second, { 'in second.md': '# In second\n' })

  await page.locator('[data-note="in first.md"]').click()
  await answerOpenDialog(second)
  await switcher(page).click()
  await menu(page).getByRole('menuitem', { name: 'Open Folder…' }).click()
  await expect(switcher(page)).toContainText('second')
  await page.locator('[data-note="in second.md"]').click()

  // Both open; the first keeps its tab while the second is on screen.
  await switcher(page).click()
  const first = menu(page).getByRole('menuitemradio', { name: /^vault/ })
  await expect(first).toContainText('1 tab')
  await expect(menu(page).getByRole('menuitemradio', { name: /^second/ })).toHaveAttribute('aria-checked', 'true')
  await first.click()
  await expect(switcher(page)).toContainText('vault')
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', 'in first.md')
  await expect(page.locator('[data-note-title]')).toHaveText('in first')

  // Closing the other vault leaves this one on screen; it moves to Recent.
  await switcher(page).click()
  await menu(page).getByRole('menuitem', { name: 'Close second' }).click()
  await switcher(page).click()
  await expect(menu(page).getByRole('menuitemradio')).toHaveCount(1)
  await expect(menu(page).getByRole('menuitem', { name: 'second' })).toBeVisible()
  await page.keyboard.press('Escape')

  const settings = JSON.parse(await readFile(path.join(userDataDir, 'settings.json'), 'utf8'))
  const root = await realpath(vault)
  expect(settings).toMatchObject({ openVaults: [root], lastVault: root })
})
