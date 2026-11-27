import { expect, test } from './fixtures.ts'

test('the folder menu with its colour swatches', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-folder="Work"]').click({ button: 'right' })
  await expect(page.getByRole('menuitemradio', { name: 'Colour #E10051' })).toBeVisible()
  await docsApp.shot('organise-notes-folder-menu')
})

test('the Update links dialog after renaming a linked note', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Work/Projects/Website redesign.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Website redesign')
  await page.locator('[data-rename-note]').click()
  await expect(page.locator('[data-note-title-input]')).toBeFocused()
  await page.keyboard.type('Website relaunch', { delay: 20 })
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Update links?' })
  await expect(dialog.locator('[data-link-notes] li')).toHaveCount(2)
  await docsApp.shot('organise-notes-update-links', dialog, { padding: 16 })
})

test('the properties panel on Website redesign', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Work/Projects/Website redesign.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Website redesign')
  await docsApp.clickMenu('toggle-properties')
  await expect(page.locator('[data-properties] [data-property="owner"]')).toBeVisible()
  await docsApp.shot('organise-notes-properties')
})

test('the Trash with two deleted notes', async ({ docsApp }) => {
  const { page } = docsApp
  for (const id of ['Personal/Travel plans.md', 'Recipes/Banana bread.md']) {
    await page.locator(`[data-note="${id}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
    await page.getByRole('dialog', { name: 'Move to Trash' }).getByRole('button', { name: 'Move to Trash' }).click()
    await expect(page.locator(`[data-note="${id}"]`)).toHaveCount(0)
  }
  await page.locator('[data-sidebar="trash"]').click()
  await expect(page.locator('[data-trash]')).toHaveCount(2)
  await docsApp.shot('organise-notes-trash')
})
