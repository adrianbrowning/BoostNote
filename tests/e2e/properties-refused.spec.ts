import { expect, failableSaves, test } from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n\nStart.\n' } })

test('a property name or tag the note refuses to save stays in its input to try again', async ({ app }) => {
  const { page } = app
  const notice = page.locator('[data-notice][data-kind="error"]')
  await page.locator('[data-note="a.md"]').click()
  await expect(page.locator('[data-editor] .cm-content')).toContainText('Start.')
  await page.locator('[data-toggle-properties]').click()
  const saves = await failableSaves(page)
  await saves.fail(true)

  // The property first: leaving a tag input that holds text adds that tag, which would save again.
  const name = page.getByRole('textbox', { name: 'New property name' })
  await name.click()
  await page.keyboard.type('status')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(notice).toContainText('Could not update the note', { timeout: 20_000 })
  await expect(name).toHaveValue('status')
  await expect(page.locator('[data-property="status"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)

  const tags = page.locator('#property-tags')
  await tags.click()
  await page.keyboard.type('late')
  await page.keyboard.press('Enter')
  await expect(notice).toContainText('Could not update the note', { timeout: 20_000 })
  await expect(tags).toHaveValue('late')
  await expect(page.locator('[data-tag-chip="late"]')).toHaveCount(0)

  await saves.fail(false)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tag-chip="late"]')).toBeVisible({ timeout: 20_000 })
  await expect(tags).toHaveValue('')
})
