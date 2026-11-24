import { expect, test, writeFiles } from './fixtures.ts'

test.use({ files: { 'work/third.md': '# Third\n' } })

test('the title-rename report lists an assets folder that stayed for an extension-case twin', async ({ app }) => {
  const { page, vault } = app
  await writeFiles(vault, { 'work/meeting-notes.md': '# Meeting notes\n' })
  await expect(page.locator('[data-note="work/meeting-notes.md"]')).toBeAttached({ timeout: 15_000 })
  // Twins can't exist on a case-insensitive disk (default APFS), so to run the same on every CI runner the apply answer gets the twin's `assetsLeftBehind` added.
  // (`page.route` does not see `boost://` requests, so the page's fetch is wrapped.)
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      if (new URL(String(input), location.href).pathname !== '/api/notes/title-renames/apply') return response
      const report = await response.json()
      for (const rename of report.renamed) rename.assetsLeftBehind = 'work/meeting-notes.assets'
      return new Response(JSON.stringify(report), { status: response.status, headers: response.headers })
    }
  })
  await app.clickMenu('rename-from-titles')
  const dialog = page.getByRole('dialog', { name: 'Rename files from titles' })
  await expect(dialog.locator('[data-title-renames-count]')).toContainText('stays in place')
  await dialog.locator('[data-title-renames-apply]').click()
  const stayed = dialog.locator('[data-title-renames-assets-stayed]')
  await expect(stayed).toContainText('work/Meeting notes.md')
  await expect(stayed).toContainText('work/meeting-notes.assets stayed in place')
})

test('the title-rename report stays when the lists cannot be refreshed after the renames, with a notice', async ({
  app,
}) => {
  const { page, vault } = app
  await writeFiles(vault, { 'work/meeting-notes.md': '# Meeting notes\n' })
  await expect(page.locator('[data-note="work/meeting-notes.md"]')).toBeAttached({ timeout: 15_000 })
  // Once the renames are applied, every list refresh fails (`page.route` does not see `boost://`).
  await page.evaluate(() => {
    const original = window.fetch
    let applied = false
    window.fetch = async (input, init) => {
      const pathname = new URL(String(input), location.href).pathname
      if (applied && pathname === '/api/workspace') {
        return Response.json({ error: 'IO', message: 'Disk full' }, { status: 500 })
      }
      const response = await original(input, init)
      if (pathname === '/api/notes/title-renames/apply') applied = true
      return response
    }
  })
  await app.clickMenu('rename-from-titles')
  const dialog = page.getByRole('dialog', { name: 'Rename files from titles' })
  await dialog.locator('[data-title-renames-apply]').click()
  await expect(dialog.locator('[data-title-renames-report]')).toContainText(/Renamed \d+ files\./)
  await expect(page.locator('[data-notice]')).toContainText('Could not refresh: Disk full')
})
