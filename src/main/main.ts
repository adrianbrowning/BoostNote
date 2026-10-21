import * as path from 'node:path'
import { app, type BrowserWindow } from 'electron'

import { eventHub } from './events.ts'
import { installMenu } from './menu.ts'
import { handleBoostProtocol, registerBoostScheme } from './protocol.ts'
import { createMainWindow } from './window.ts'

// Legacy Boostnote (Electron 4) owns `<appData>/Boostnote`. Sharing it would make the two apps fight
// over the single-instance lock and let Chromium 140+ migrate the legacy profile in place.
app.setPath('userData', path.join(app.getPath('appData'), 'Boostnote Modern'))
registerBoostScheme()

let mainWindow: BrowserWindow | undefined

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  app.on('activate', showMainWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => eventHub.close())

  // No top-level `await` here: Electron emits `ready` only after the ESM entry graph has evaluated.
  void app.whenReady().then(() => {
    handleBoostProtocol()
    installMenu((command) => eventHub.broadcast({ type: 'menu', command }))
    showMainWindow()
  })
}
