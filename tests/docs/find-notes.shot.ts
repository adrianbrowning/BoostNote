import { expect, test } from './fixtures.ts'

test('search results for "design"', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-sidebar="all"]').click()
  await page.getByLabel('Search notes').fill('design')
  await expect(page.locator('[data-note="Work/Projects/Website redesign.md"]')).toBeVisible()
  await expect(page.locator('[data-note="Recipes/Banana bread.md"]')).toHaveCount(0)
  await page.locator('[data-note="Work/Projects/Website redesign.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Website redesign')
  await docsApp.shot('find-notes-search')
})

test('the notes of one tag', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-tag="recipe"]').click()
  await expect(page.getByRole('listbox', { name: 'Notes in #recipe' })).toBeVisible()
  await expect(page.locator('[role="listbox"] [data-note]')).toHaveCount(3)
  await page.locator('[data-note="Recipes/Pasta al limone.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Pasta al limone')
  await docsApp.shot('find-notes-tag')
})

test('the Find bar in the open note', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  await docsApp.clickMenu('find')
  const search = page.locator('[data-editor] .cm-search')
  await expect(search).toBeVisible()
  // CodeMirror reads the query on key events, not on `fill`.
  await search.locator('input[name="search"]').pressSequentially('note')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-editor] .cm-searchMatch').first()).toBeVisible()
  await docsApp.shot('find-notes-find-bar')
})
