import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { cspViolations, expect, openLooseFile, test, writeFiles } from './fixtures.ts'

// The app policy allows style elements only from the app origin or with the request nonce, so
// every inline <style> the app inserts (Mermaid's SVG styles among them) must carry that nonce.
const DIAGRAM = `# Diagram

<style>h1 { color: rgb(255, 0, 0); }</style>

Euler: $e^{i\\pi} + 1 = 0$

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

| Left | Right |
| :--- | ----: |
| a    | b     |

\`\`\`mermaid
graph TD
  A[Write] --> B[Export]
\`\`\`
`

test.use({ files: { 'diagram.md': DIAGRAM } })

/** Each `<style>` of the diagram carries the page nonce and its rules applied. */
async function expectStampedStyles(page: Page, svg: Locator) {
  // As Remix's runtime reads it: header CSP hides the nonce attribute, not the property.
  const nonce = await page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="rmx-nonce"]')?.nonce ?? '',
  )
  expect(nonce).not.toBe('')
  const styles = await svg.evaluate((node) =>
    [...node.querySelectorAll('style')].map((style) => ({
      nonce: style.nonce,
      rules: style.sheet?.cssRules.length ?? 0,
    })),
  )
  expect(styles.length).toBeGreaterThan(0)
  for (const style of styles) {
    expect(style.nonce).toBe(nonce)
    expect(style.rules).toBeGreaterThan(0)
  }
}

test('the main window reports no CSP violations: startup, a Mermaid and KaTeX note, editing and the reader', async ({
  app,
}) => {
  const { page } = app

  await page.locator('[data-note="diagram.md"]').click()
  const diagram = page.locator('[data-editor] .cm-lp-mermaid svg')
  await expect(diagram).toBeVisible({ timeout: 20_000 })
  // Inline SVG: its labels are text in the page, so they can be selected.
  await expect(diagram).toContainText('Write')
  await expectStampedStyles(page, diagram)
  await expect(page.locator('[data-editor] .katex').first()).toBeVisible()

  await page.locator('[data-editor] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nMore text.')
  await expect(page.locator('[data-editor] .cm-content')).toContainText('More text.')

  await openLooseFile(app, 'readme.md', DIAGRAM.replace('# Diagram', '# Loose diagram'))
  const body = page.locator('[data-reader-body]')
  await expect(body.locator('h1')).toHaveText('Loose diagram', { timeout: 20_000 })
  const readerDiagram = body.locator('.mermaid-diagram svg')
  await expect(readerDiagram).toBeVisible({ timeout: 20_000 })
  await expect(readerDiagram).toContainText('Write')
  await expectStampedStyles(page, readerDiagram)
  await expect(body.locator('.katex').first()).toBeVisible()
  await expect(body.locator('th').nth(1)).toHaveCSS('text-align', 'right')
  // A <style> written in the note is sanitised out in main, so it never reaches the page.
  const strayStyles = await body.evaluate(
    (node) => [...node.querySelectorAll('style')].filter((style) => !style.closest('svg')).length,
  )
  expect(strayStyles).toBe(0)
  await expect(body.locator('h1')).not.toHaveCSS('color', 'rgb(255, 0, 0)')

  expect(await cspViolations(page)).toEqual([])
})

declare global {
  interface Window {
    /** Set by the style-scope test: a style made outside Mermaid's container during a render. */
    styleProbe?: { wrapped: boolean; nonceAttribute: string | null }
  }
}

test('a style created outside Mermaid’s container while a diagram renders keeps no nonce attribute', async ({
  app,
}) => {
  const { page } = app
  // When Mermaid appends its measuring container (`#d<id>`) the render is running, so the
  // createElement wrap is active: a style made then, outside the container (as CodeMirror's
  // StyleModule might), must have no nonce attribute once the wrap's microtasks have run.
  await page.evaluate(() => {
    const observer = new MutationObserver((records) => {
      const added = records.flatMap((record) => [...record.addedNodes])
      if (!added.some((node) => node instanceof HTMLElement && node.id.startsWith('dboost-mermaid-'))) return
      observer.disconnect()
      const wrapped = Object.hasOwn(document, 'createElement')
      const style = document.createElement('style')
      document.head.append(style)
      setTimeout(() => {
        window.styleProbe = { wrapped, nonceAttribute: style.getAttribute('nonce') }
        style.remove()
      })
    })
    observer.observe(document.body, { childList: true })
  })

  await page.locator('[data-note="diagram.md"]').click()
  await expect(page.locator('[data-editor] .cm-lp-mermaid svg')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => window.styleProbe)).toEqual({ wrapped: true, nonceAttribute: null })
  expect(await cspViolations(page)).toEqual([])
})

test('the hidden Mermaid renderer reports no CSP violations while it lays out an export', async ({ app }) => {
  const { page, dir, electronApp } = app
  await page.locator('[data-note="diagram.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('diagram')

  const target = path.join(dir, 'diagram.html')
  await app.answerSaveDialog(target)
  await app.clickMenu('export-html')
  await expect
    .poll(() => readFile(target, 'utf8').catch(() => ''), { timeout: 30_000 })
    .toContain('<div class="mermaid-diagram"><svg')
  // The exported SVG keeps its styles, without the renderer's nonce.
  const html = await readFile(target, 'utf8')
  expect(html).toMatch(/<div class="mermaid-diagram"><svg[\s\S]*?<style>/)
  expect(html).not.toContain('nonce')

  const renderer = electronApp.windows().find((window) => new URL(window.url()).pathname === '/export/mermaid')
  if (!renderer) throw new Error('the Mermaid renderer window is not open')
  expect(await cspViolations(renderer)).toEqual([])
  expect(await cspViolations(page)).toEqual([])
})

test.describe('vault and reader asset documents', () => {
  const STYLED_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>rect { fill: rgb(255, 0, 0); }</style><rect width="10" height="10"/></svg>'
  test.use({
    files: {
      'assets.md': '# Assets\n\n![styled](styled.svg)\n',
      'styled.svg': STYLED_SVG,
      'page.html': '<!doctype html><style>p { color: rgb(255, 0, 0); }</style><p>Styled</p>',
    },
  })

  /**
   * Loads `href` (an app path) as a document in a hidden window sandboxed like the app's own
   * (`src/main/window.ts`) and returns its page; the caller closes it.
   */
  async function openDocument({ electronApp }: { electronApp: ElectronApplication }, href: string): Promise<Page> {
    const url = new URL(href, 'boost://app/').href
    await electronApp.evaluate(async ({ BrowserWindow }, target) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
      })
      await window.loadURL(target)
    }, url)
    const page = electronApp.windows().find((window) => window.url() === url)
    if (!page) throw new Error(`no window shows ${url}`)
    return page
  }

  test('an .svg asset keeps only its sandbox policy, so its <style> applies without violations', async ({ app }) => {
    const { page, dir } = app
    await page.locator('[data-note="assets.md"]').click()
    const vaultSvg = await page.locator('[data-editor] img[alt="styled"]').getAttribute('src')
    if (!vaultSvg) throw new Error('the note shows no image')

    await writeFiles(path.join(dir, 'loose'), { 'styled.svg': STYLED_SVG })
    await openLooseFile(app, 'pics.md', '# Pics\n\n![styled](styled.svg)\n')
    const readerSvg = await page
      .locator('[data-reader-body] img[alt="styled"]')
      .getAttribute('src', { timeout: 20_000 })
    if (!readerSvg) throw new Error('the reader shows no image')

    for (const href of [vaultSvg, readerSvg]) {
      const asset = await openDocument(app, href)
      await expect(asset.locator('rect')).toHaveCSS('fill', 'rgb(255, 0, 0)')
      expect(await cspViolations(asset)).toEqual([])
      await asset.close()
    }
  })

  test('an .html vault asset also gets the app policy, which blocks its <style> (accepted)', async ({ app }) => {
    const { page } = app
    await page.locator('[data-note="assets.md"]').click()
    const svg = await page.locator('[data-editor] img[alt="styled"]').getAttribute('src')
    if (!svg) throw new Error('the note shows no image')
    const href = new URL(svg, 'boost://app/')
    href.searchParams.set('src', 'page.html')

    const asset = await openDocument(app, `${href.pathname}${href.search}`)
    await expect(asset.locator('p')).toHaveText('Styled')
    await expect(asset.locator('p')).not.toHaveCSS('color', 'rgb(255, 0, 0)')
    expect(await cspViolations(asset)).toEqual([expect.stringMatching(/^style-src-elem: inline/)])
    await asset.close()
  })
})
