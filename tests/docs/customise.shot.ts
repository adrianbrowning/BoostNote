import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { quitWithoutDialog } from '../e2e/fixtures.ts'
import { type DocsApp, expect, launchDocsApp, test } from './fixtures.ts'

const DEFAULT_SHOW_HIDE = { globalHotkey: 'CommandOrControl+Shift+Space' }

/** Opens the Markdown tour and waits until its math has rendered. */
async function openTour({ page }: DocsApp): Promise<void> {
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()
}

test.describe('with the default preferences', () => {
  // The harness turns the show/hide hotkey off; a new install has it on.
  test.use({ ui: DEFAULT_SHOW_HIDE })

  test('the Preferences dialog', async ({ docsApp }) => {
    const { page } = docsApp
    await openTour(docsApp)
    await docsApp.clickMenu('preferences')
    const dialog = page.getByRole('dialog', { name: 'Preferences' })
    await expect(dialog.getByRole('group', { name: 'Show/hide Boostnote from anywhere' })).toContainText('Active.')
    // The first field takes the focus; the shot shows the dialog at rest.
    await dialog.getByRole('combobox', { name: 'Theme' }).blur()
    await docsApp.shot('customise-preferences', dialog, { padding: 16 })
  })
})

/** Opens the Markdown tour, then hides the sidebar and the note list, so the editor is wider than the line width. */
async function openTourAlone(docsApp: DocsApp): Promise<void> {
  await openTour(docsApp)
  await docsApp.clickMenu('toggle-sidebar')
  await docsApp.clickMenu('toggle-note-list')
  await expect(docsApp.page.locator('[data-note="Markdown tour.md"]')).toBeHidden()
}

test.describe('at the default line width', () => {
  test.use({ ui: DEFAULT_SHOW_HIDE })

  test('the default line width', async ({ docsApp }) => {
    await openTourAlone(docsApp)
    await docsApp.shot('customise-line-width-default')
  })
})

test.describe('at full line width', () => {
  test.use({ ui: { ...DEFAULT_SHOW_HIDE, lineWidth: 0 } })

  test('the full line width', async ({ docsApp }) => {
    await openTourAlone(docsApp)
    await docsApp.shot('customise-line-width-full')
  })
})

/**
 * The app with its update check pointed at a local server that offers version 99.0.0
 * (`BOOSTNOTE_UPDATE_URL`, read at launch; it also turns the automatic check on outside a packaged app).
 */
const updateTest = test.extend<{ docsApp: DocsApp }>({
  docsApp: async ({ theme }, use) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/adrianbrowning/BoostNote/releases' }),
      )
    })
    await once(server.listen(0, '127.0.0.1'), 'listening')
    const { port } = server.address() as AddressInfo
    process.env.BOOSTNOTE_UPDATE_URL = `http://127.0.0.1:${port}/`
    try {
      const app = await launchDocsApp(theme)
      try {
        await use(app)
      } finally {
        await quitWithoutDialog(app.electronApp)
        await rm(app.dir, { recursive: true, force: true })
      }
    } finally {
      delete process.env.BOOSTNOTE_UPDATE_URL
      server.close()
    }
  },
})

updateTest('the update notice in the status bar', async ({ docsApp }) => {
  updateTest.setTimeout(60_000)
  const { page } = docsApp
  await page.locator('[data-note="Welcome.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Welcome')
  // The first check runs 10 seconds after launch.
  const notice = page.locator('[data-update-notice]')
  await expect(notice).toContainText('Boostnote 99.0.0 is available', { timeout: 30_000 })
  await docsApp.shot('customise-update-notice', notice, { padding: 12 })
})
