import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'

import type { ExportServices } from '../app/services.ts'
import { APP_ORIGIN } from './protocol.ts'

/** The mermaid window is closed after this long without a diagram to lay out. */
const MERMAID_IDLE_MS = 60_000

/** Invisible, sandboxed window; `backgroundThrottling: false` so a hidden window still lays out promptly. */
function hiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
}

/**
 * Loads a standalone export document (no scripts: its CSP forbids them) into a hidden window via
 * a temp file, waits for its web fonts (KaTeX) and hands the window to `use`.
 */
async function withDocument<T>(html: string, use: (window: BrowserWindow) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(app.getPath('temp'), 'boostnote-export-'))
  const window = hiddenWindow()
  try {
    const file = path.join(dir, 'note.html')
    await writeFile(file, html)
    await window.loadFile(file)
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    return await use(window)
  } finally {
    window.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}

/** Electron side of export: save dialogs, a hidden window for mermaid, PDF and printing. */
export function createExportServices(parentWindow: () => BrowserWindow | undefined): ExportServices {
  let mermaidWindow: Promise<BrowserWindow> | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const closeMermaidWindow = () => {
    const pending = mermaidWindow
    mermaidWindow = undefined
    void pending?.then((window) => window.destroy()).catch(() => undefined)
  }

  const loadMermaidWindow = (): Promise<BrowserWindow> => {
    mermaidWindow ??= (async () => {
      const window = hiddenWindow()
      try {
        await window.loadURL(`${APP_ORIGIN}/export/mermaid`)
      } catch (error) {
        window.destroy()
        throw error
      }
      return window
    })()
    // A failed load is not cached: the next diagram tries again.
    mermaidWindow.catch(() => closeMermaidWindow())
    return mermaidWindow
  }

  app.on('before-quit', closeMermaidWindow)

  return {
    async saveFile({ title, defaultPath, filters }) {
      const options = { title, defaultPath: path.resolve(app.getPath('documents'), defaultPath), filters }
      const parent = parentWindow()
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },

    async renderMermaid(source) {
      clearTimeout(idleTimer)
      try {
        const window = await loadMermaidWindow()
        // Errors are passed back as values: `executeJavaScript` would replace their message.
        const result: { svg?: unknown; error?: unknown } = await window.webContents.executeJavaScript(
          `window.boostRenderMermaid(${JSON.stringify(source)}).then((svg) => ({ svg }), (error) => ({ error: String(error && error.message || error) }))`,
          true,
        )
        if (typeof result.svg !== 'string') throw new Error(String(result.error ?? 'Mermaid returned no SVG'))
        return result.svg
      } finally {
        idleTimer = setTimeout(closeMermaidWindow, MERMAID_IDLE_MS)
      }
    },

    printToPdf(html) {
      return withDocument(html, (window) =>
        // Margins in inches (about 15 mm).
        window.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        }),
      )
    },

    print(html) {
      return withDocument(
        html,
        (window) =>
          new Promise<void>((resolve, reject) => {
            window.webContents.print({ printBackground: true }, (success, reason) => {
              // Cancelling the dialog is not an error.
              if (success || reason === 'cancelled') resolve()
              else reject(new Error(`Printing failed: ${reason}`))
            })
          }),
      )
    },
  }
}
