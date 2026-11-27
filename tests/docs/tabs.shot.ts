import { expect, test } from './fixtures.ts'

test('several notes open in tabs', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Welcome.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Welcome')
  for (const note of ['Work/Projects/Website redesign.md', 'Personal/Reading list.md', 'Markdown tour.md']) {
    await page.locator(`[data-note="${note}"]`).click({ modifiers: ['ControlOrMeta'] })
  }
  await expect(page.getByRole('tablist', { name: 'Open notes' }).getByRole('tab')).toHaveCount(4)
  await page.locator('[role="tab"][data-tab="Work/Projects/Website redesign.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Website redesign')
  await docsApp.shot('tabs-strip')
})

test('the note menu with Open in New Tab', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Welcome.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Welcome')
  await page.locator('[data-note="Markdown tour.md"]').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Open in New Tab' })).toBeVisible()
  await docsApp.shot('tabs-note-menu')
})
