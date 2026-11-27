import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { type DocsApp, expect, SHOTS_DIR, test, WINDOW } from './fixtures.ts'

/**
 * Opens an exported HTML file in a new window of the app's own Chromium (a browser would show the same) at the docs
 * window size, and saves it as `<name>-<theme>.png` at 2×. Exported pages always use the light palette
 * (src/markdown/document.ts), so both themes show the same page.
 */
async function shootExport(
  { electronApp }: DocsApp,
  file: string,
  name: string,
  theme: string,
  scrollTo?: string,
): Promise<void> {
  const [page] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(
      ({ BrowserWindow }, { url, size }) => {
        const window = new BrowserWindow({ ...size, show: false, useContentSize: true })
        void window.loadURL(url)
      },
      { url: pathToFileURL(file).href, size: WINDOW },
    ),
  ])
  try {
    await page.waitForLoadState('load')
    const cdp = await electronApp.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...WINDOW, deviceScaleFactor: 2, mobile: false })
    await page.evaluate(() => document.fonts.ready)
    if (scrollTo)
      await page
        .locator(scrollTo)
        .first()
        .evaluate((node) => node.scrollIntoView({ block: 'start' }))
    // The clip is in page coordinates, so it starts at the scrolled-to position.
    const y = await page.evaluate(() => window.scrollY)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y, ...WINDOW, scale: 1 },
    })
    await writeFile(path.join(SHOTS_DIR, `${name}-${theme}.png`), Buffer.from(data, 'base64'))
  } finally {
    await page.close()
  }
}

test('a note exported as HTML, opened in a browser', async ({ docsApp, theme }) => {
  const { page, dir } = docsApp
  await page.locator('[data-note="Markdown tour.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Markdown tour')
  const target = path.join(dir, 'Markdown tour.html')
  await docsApp.answerSaveDialog(target)
  await docsApp.clickMenu('export-html')
  await expect
    .poll(() => readFile(target, 'utf8').catch(() => ''), { timeout: 30_000 })
    .toContain('<div class="mermaid-diagram"><svg')
  await shootExport(docsApp, target, 'share-and-export-html-note', theme)
  await shootExport(docsApp, target, 'share-and-export-html-diagram', theme, 'h2#math')
})

test('a folder menu with Export as HTML', async ({ docsApp }) => {
  const { page } = docsApp
  await page.locator('[data-folder="Recipes"]').getByTitle('Recipes').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Export as HTML…' })).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Export as HTML…' }).hover()
  await docsApp.shot('share-and-export-folder-menu')
})

test('a vault exported as a website, opened in a browser', async ({ docsApp, theme }) => {
  const { dir } = docsApp
  await docsApp.answerOpenDialog(dir)
  // The app reveals the new folder in Finder/Explorer; no window needed for that here.
  await docsApp.electronApp.evaluate(({ shell }) => {
    shell.showItemInFolder = () => undefined
  })
  await docsApp.clickMenu('export-vault')
  const index = path.join(dir, 'My notes (HTML)', 'index.html')
  await expect.poll(() => readFile(index, 'utf8').catch(() => ''), { timeout: 30_000 }).toContain('Website redesign')
  await shootExport(docsApp, index, 'share-and-export-site-index', theme)
})
