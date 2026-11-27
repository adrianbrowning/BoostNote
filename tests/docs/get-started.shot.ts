import { expect, test } from './fixtures.ts'

test('the main window with the Markdown tour open', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()
  await docsApp.shot('main-window')
})
