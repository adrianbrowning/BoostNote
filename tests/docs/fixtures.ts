import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test as base, type CDPSession, type Locator } from '@playwright/test'

import type { UiPatch } from '../../src/main/settings.ts'
import { type AppHandle, type LaunchOptions, launchApp, quitWithoutDialog, type VaultFiles } from '../e2e/fixtures.ts'

const projectRoot = path.resolve(import.meta.dirname, '../..')
/** The demo vault every shot starts from (a temp copy; this folder is only read). */
export const DOCS_VAULT = path.join(projectRoot, 'tests/fixtures/docs-vault')
/** Where the site reads the shots from: `<name>-light.png` and `<name>-dark.png`. */
export const SHOTS_DIR = path.join(projectRoot, 'site/src/assets/shots')
/** The window's content size in CSS pixels; the PNGs are twice that (SCALE). */
export const WINDOW = { width: 1200, height: 760 }
const SCALE = 2
/** The name the demo vault shows in the app. */
const VAULT_NAME = 'My notes'
/**
 * Shot-only CSS: hides the vault's temp path in the status bar (a reader sees their own path there;
 * the note count beside it hides with it), the caret (CodeMirror draws its own), and transitions.
 */
const SHOT_STYLE = `footer > span[title] { visibility: hidden; }
.cm-cursorLayer { display: none !important; }
* { caret-color: transparent !important; transition: none !important; animation: none !important; }`

export type Theme = 'light' | 'dark'

export interface DocsApp extends AppHandle {
  /**
   * Saves `<name>-<theme>.png`: the whole window, or only `target` (with `padding` CSS pixels of the
   * page around it, so a dialog keeps its shadow).
   */
  shot(name: string, target?: Locator, options?: { padding?: number }): Promise<void>
}

/** Launches the app on a copy of the demo vault in `theme`, at the docs window size. */
export async function launchDocsApp(
  theme: Theme,
  files: VaultFiles = {},
  options: Omit<LaunchOptions, 'vaultCopyOf'> = {},
): Promise<DocsApp> {
  const ui: UiPatch = { ...options.ui, theme }
  const handle = await launchApp(files, { vaultName: VAULT_NAME, ...options, vaultCopyOf: DOCS_VAULT, ui })
  const cdp = await fitWindow(handle, theme)
  return Object.assign(handle, {
    shot: async (name: string, target?: Locator, { padding = 0 } = {}) => {
      let clip = { x: 0, y: 0, ...WINDOW }
      if (target) {
        const box = await target.boundingBox()
        if (!box) throw new Error(`Shot ${name}: the target is not visible`)
        const x = Math.max(0, box.x - padding)
        const y = Math.max(0, box.y - padding)
        clip = {
          x,
          y,
          width: Math.min(WINDOW.width - x, box.width + 2 * padding),
          height: Math.min(WINDOW.height - y, box.height + 2 * padding),
        }
      }
      // A constructed sheet (CSSOM), as the app's CSP blocks a <style> element without its nonce.
      await handle.page.evaluate(async (css) => {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(css)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        await document.fonts.ready
      }, SHOT_STYLE)
      // CDP, not page.screenshot: Playwright scales Electron shots to 1 device pixel per CSS pixel.
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })
      await handle.page.evaluate(() => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.slice(0, -1)
      })
      await mkdir(SHOTS_DIR, { recursive: true })
      await writeFile(path.join(SHOTS_DIR, `${name}-${theme}.png`), Buffer.from(data, 'base64'))
    },
  })
}

/**
 * Sets the window's content to WINDOW at SCALE device pixels per CSS pixel (so the shots are sharp on
 * any display), and the page's colour scheme to the app's theme: Playwright emulates `light` in
 * Electron pages unless told otherwise, which would hide the dark theme.
 */
async function fitWindow(app: AppHandle, theme: Theme): Promise<CDPSession> {
  await app.page.emulateMedia({ colorScheme: theme })
  await app.electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
  }, WINDOW)
  const cdp = await app.electronApp.context().newCDPSession(app.page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...WINDOW, deviceScaleFactor: SCALE, mobile: false })
  await app.page.waitForFunction(
    ({ size, scale }) => window.innerWidth === size.width && window.devicePixelRatio === scale,
    { size: WINDOW, scale: SCALE },
  )
  return cdp
}

/** The option each project of `playwright.config.ts` sets. */
export interface ThemeOption {
  theme: Theme
}

/** `docsApp`: one app per shot spec, in the project's theme, closed and removed afterwards. */
export const test = base.extend<ThemeOption & { files: VaultFiles; ui: UiPatch; docsApp: DocsApp }>({
  theme: ['light', { option: true }],
  files: [{}, { option: true }],
  ui: [{}, { option: true }],
  docsApp: async ({ theme, files, ui }, use) => {
    const app = await launchDocsApp(theme, files, { ui })
    await use(app)
    await quitWithoutDialog(app.electronApp)
    await rm(app.dir, { recursive: true, force: true })
  },
})

export { expect } from '@playwright/test'
