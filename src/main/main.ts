import * as path from 'node:path'
import { app, type BrowserWindow, dialog, type OpenDialogOptions, shell } from 'electron'

import { createAppRouter } from '../app/router.ts'
import { findLegacyStorages } from '../migrate/index.ts'
import { eventHub } from './events.ts'
import { installMenu } from './menu.ts'
import { handleBoostProtocol, registerBoostScheme } from './protocol.ts'
import { SettingsStore } from './settings.ts'
import { VaultSession } from './vault-session.ts'
import { createMainWindow } from './window.ts'

/** How long quitting waits for the renderer to save the open note. */
const FLUSH_TIMEOUT_MS = 3000

// Legacy Boostnote (Electron 4) owns `<appData>/Boostnote`. Sharing it would make the two apps fight
// over the single-instance lock and let Chromium 140+ migrate the legacy profile in place.
// `--user-data-dir` (tests, side-by-side profiles) wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Boostnote Modern'))
}
registerBoostScheme()

const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
const vaults = new VaultSession({ settings, events: eventHub })

let mainWindow: BrowserWindow | undefined
/** Set once unsaved work has been dealt with; from then on quitting/closing proceeds. */
let leaving = false

function liveWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
}

const router = createAppRouter({
  events: eventHub,
  vaults,
  async pickFolder({ title, buttonLabel, createDirectory, defaultPath }) {
    const options: OpenDialogOptions = {
      title,
      buttonLabel,
      ...(defaultPath ? { defaultPath } : {}),
      properties: createDirectory ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    }
    const window = liveWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  },
  openExternal: (url) => shell.openExternal(url),
  showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
  findLegacyStorages: () => findLegacyStorages({ appDataDir: path.join(app.getPath('appData'), 'Boostnote') }),
})

function showMainWindow(): void {
  const window = liveWindow()
  if (!window) {
    mainWindow = createMainWindow({ settings, isQuitting: () => leaving })
    mainWindow.on('focus', () => void vaults.current?.refresh().catch(() => undefined))
    if (process.platform !== 'darwin') guardClose(mainWindow)
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * Asks the renderer to save the open note (`window.boostFlushPendingSave`). When something could not
 * be saved (a conflict, a failed write) the user decides whether to leave anyway.
 */
async function confirmLeave(): Promise<boolean> {
  const window = liveWindow()
  if (!window) return true
  const { promise: timeout, resolve } = Promise.withResolvers<'timeout'>()
  const timer = setTimeout(() => resolve('timeout'), FLUSH_TIMEOUT_MS)
  const clean = await Promise.race([
    window.webContents
      .executeJavaScript('window.boostFlushPendingSave ? window.boostFlushPendingSave() : true', true)
      .catch(() => true),
    timeout,
  ])
  clearTimeout(timer)
  if (clean !== false) return true
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    message: 'The open note has changes that are not saved.',
    detail: 'It conflicts with the file on disk or could not be written. Quitting now discards your edits.',
  })
  return response === 1
}

/** Windows/Linux: closing the window quits, so it saves first. */
function guardClose(window: BrowserWindow): void {
  window.on('close', (event) => {
    if (leaving) return
    event.preventDefault()
    void confirmLeave().then((ok) => {
      if (!ok) return
      leaving = true
      window.close()
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.on('activate', showMainWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (leaving) {
      eventHub.close()
      void vaults.dispose()
      return
    }
    event.preventDefault()
    void confirmLeave().then((ok) => {
      if (!ok) return
      leaving = true
      app.quit()
    })
  })

  // No top-level `await` here: Electron emits `ready` only after the ESM entry graph has evaluated.
  void app.whenReady().then(async () => {
    handleBoostProtocol(router)
    installMenu((command) => eventHub.broadcast({ type: 'menu', command }))
    // Reopen the last vault first, so the first page already shows it.
    await vaults.restore().catch((error: unknown) => console.error('Could not reopen the last vault', error))
    showMainWindow()
  })
}
