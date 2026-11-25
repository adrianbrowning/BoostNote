import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { type AppHandle, expect, test, writeFiles } from './fixtures.ts'

test.use({ files: { 'in first.md': '# In first\n' } })

const QUOTA = 'The quota has been exceeded.'
const switcher = (page: Page) => page.locator('[data-vault-switcher]')
const menu = (page: Page) => page.getByRole('menu')
const notice = (page: Page) => page.locator('[data-notice][data-kind="error"]')

/**
 * Opens a second vault with "in second.md" in a tab, then goes back to the first vault. From then on the
 * restore of the second vault fails the way the real tab store can: its active note reads as gone
 * (`404`, deleted after the listing), so the restore closes that tab and saves the tabs, and
 * `localStorage.setItem` throws over its quota.
 */
async function secondVaultWhoseRestoreFails({ page, dir, answerOpenDialog }: AppHandle): Promise<string> {
  const second = path.join(dir, 'second')
  await writeFiles(second, { 'in second.md': '# In second\n' })
  await answerOpenDialog(second)
  await switcher(page).click()
  await menu(page).getByRole('menuitem', { name: 'Open Folder…' }).click()
  await expect(switcher(page)).toContainText('second')
  await page.locator('[data-note="in second.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('in second')
  await switcher(page).click()
  await menu(page)
    .getByRole('menuitemradio', { name: /^vault/ })
    .click()
  await expect(switcher(page)).toContainText('vault')

  await page.evaluate((message) => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('boostnote.tabs:')) throw new DOMException(message, 'QuotaExceededError')
      setItem.call(this, key, value)
    }
    const original = window.fetch
    window.fetch = async (input, init) => {
      const url = new URL(String(input), location.href)
      if (url.pathname === '/api/notes/read' && url.searchParams.get('id') === 'in second.md') {
        return new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Note not found' }), { status: 404 })
      }
      return original(input, init)
    }
  }, QUOTA)
  return second
}

test('a vault opened from the vault menu whose tab restore fails shows the failure', async ({ app }) => {
  const { page } = app
  await secondVaultWhoseRestoreFails(app)

  await switcher(page).click()
  await menu(page)
    .getByRole('menuitemradio', { name: /^second/ })
    .click()
  await expect(switcher(page)).toContainText('second')
  await expect(notice(page)).toContainText(QUOTA)
})

test('a vault picked with Open Folder… whose tab restore fails shows the failure', async ({ app }) => {
  const { page, answerOpenDialog } = app
  const second = await secondVaultWhoseRestoreFails(app)

  await answerOpenDialog(second)
  await switcher(page).click()
  await menu(page).getByRole('menuitem', { name: 'Open Folder…' }).click()
  await expect(switcher(page)).toContainText('second')
  await expect(notice(page)).toContainText(QUOTA)
})
