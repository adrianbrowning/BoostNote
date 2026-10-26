import { statSync } from 'node:fs'
import * as path from 'node:path'
import {
  app,
  type BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  type MessageBoxOptions,
  type OpenDialogOptions,
  shell,
} from 'electron'
import { DropGrants } from '../app/drop-grants.ts'
import { createAppRouter } from '../app/router.ts'
import { type CliTarget, defaultShimDirs, installShim, loginShellPath, windowsCommands } from '../cli/install.ts'
import { findLegacyStorages } from '../migrate/index.ts'
import { eventHub } from './events.ts'
import { createExportServices } from './export.ts'
import { installMenu } from './menu.ts'
import { createPreferenceServices } from './preferences.ts'
import { handleBoostProtocol, registerBoostScheme } from './protocol.ts'
import { SettingsStore } from './settings.ts'
import { checkForUpdate, createUpdater } from './updates.ts'
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
const preferences = createPreferenceServices(toggleMainWindow)
// `BOOSTNOTE_UPDATE_URL` (development and tests only) points the checker at another server and
// turns on the automatic checks, which otherwise run only in the packaged app.
const updateUrl = app.isPackaged ? undefined : process.env.BOOSTNOTE_UPDATE_URL
const updater = createUpdater({
  check: () => checkForUpdate({ currentVersion: app.getVersion(), ...(updateUrl ? { url: updateUrl } : {}) }),
  automatic: app.isPackaged || updateUrl !== undefined,
  onUpdate: (update) => eventHub.broadcast({ type: 'update', ...update }),
})

/** Existing `.md` files on a command line (Windows/Linux file associations, `electron . note.md`). */
function markdownFilesIn(argv: string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && /\.md$/i.test(arg))
    .map((arg) => path.resolve(cwd, arg))
    .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)
}

// A `.md` file opened from the OS: its folder becomes the vault and the note opens in a tab (the
// workspace takes the request). macOS delivers files (Finder, `open -a`, dock drops) through
// `open-file`, possibly before `ready`.
app.on('open-file', (event, file) => {
  event.preventDefault()
  vaults.requestOpen(file)
  if (app.isReady()) showMainWindow()
})
for (const file of markdownFilesIn(process.argv, process.cwd())) vaults.requestOpen(file)

let mainWindow: BrowserWindow | undefined
/** Set once unsaved work has been dealt with; from then on quitting/closing proceeds. */
let leaving = false

function liveWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
}

const drops = new DropGrants()
// The preload sends the paths of really dropped files; only the app window's own page may do so.
ipcMain.handle('drop:grant', (event, paths: unknown) => {
  const window = liveWindow()
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Drops are only accepted from the app window')
  }
  if (!event.senderFrame.url.startsWith('boost://app/')) throw new Error('Drops are only accepted from app pages')
  if (!Array.isArray(paths) || !paths.every((item) => typeof item === 'string')) throw new Error('Invalid drop')
  return { ticket: drops.grant(paths), count: paths.length }
})

const router = createAppRouter({
  events: eventHub,
  vaults,
  settings,
  preferences,
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
  drops,
  exports: createExportServices(liveWindow),
  updates: updater,
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

/** The global hotkey: hides the app when it is in front, otherwise brings it (back) to the front. */
function toggleMainWindow(): void {
  const window = liveWindow()
  if (window?.isVisible() && window.isFocused()) {
    if (process.platform === 'darwin') app.hide()
    else window.hide()
    return
  }
  showMainWindow()
  if (process.platform === 'darwin') app.focus({ steal: true })
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
  app.on('second-instance', (_event, argv, workingDirectory) => {
    for (const file of markdownFilesIn(argv, workingDirectory)) vaults.requestOpen(file)
    showMainWindow()
  })
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
  app.on('will-quit', () => globalShortcut.unregisterAll())

  // No top-level `await` here: Electron emits `ready` only after the ESM entry graph has evaluated.
  void app.whenReady().then(async () => {
    handleBoostProtocol(router)
    installMenu(
      (command, index) => eventHub.broadcast({ type: 'menu', command, ...(index === undefined ? {} : { index }) }),
      () => void checkForUpdatesNow(),
      () => void installCommandLineTool(),
    )
    // Theme before the window exists (its background colour follows it).
    const ui = settings.ui
    preferences.apply(ui)
    if (!preferences.setHotkey(ui.globalHotkey)) console.warn(`Could not register the hotkey ${ui.globalHotkey}`)
    updater.setAutomatic(ui.checkUpdates)
    // Reopen the last vault first, so the first page already shows it.
    await vaults.restore().catch((error: unknown) => console.error('Could not reopen the last vault', error))
    showMainWindow()
  })
}

function showMessage(options: MessageBoxOptions) {
  const window = liveWindow()
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

/** Help › Check for Updates…: checks now and reports the result in a message box. */
async function checkForUpdatesNow(): Promise<void> {
  const result = await updater.checkNow()
  if (result.status === 'update') {
    const { response } = await showMessage({
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Boostnote ${result.version} is available.`,
      detail: `You have ${app.getVersion()}. Download opens the release page in your browser.`,
    })
    if (response === 0) await shell.openExternal(result.url)
  } else if (result.status === 'current') {
    await showMessage({ type: 'info', message: 'Boostnote is up to date.', detail: `Version ${app.getVersion()}` })
  } else {
    await showMessage({ type: 'warning', message: 'Could not check for updates.', detail: result.message })
  }
}

/**
 * Install Command Line Tool…: writes the `boostnote` shim (macOS/Linux) running src/cli on this app's
 * binary, and says where it went and whether that folder is on PATH. Windows gets the command to use.
 */
async function installCommandLineTool(): Promise<void> {
  const target: CliTarget = {
    executable: process.execPath,
    entry: path.join(app.getAppPath(), 'src', 'cli', 'index.js'),
  }
  if (process.platform === 'win32') {
    await showMessage({
      type: 'info',
      message: 'Run the Boostnote command line with the app’s own runtime:',
      detail: windowsCommands(target),
    })
    return
  }
  try {
    const pathEnv = await loginShellPath(process.env.SHELL, process.env.PATH ?? '')
    const result = await installShim(target, defaultShimDirs(), pathEnv)
    const dir = path.dirname(result.file)
    await showMessage({
      type: 'info',
      message: `Installed the boostnote command at ${result.file}.`,
      detail: result.onPath
        ? 'Open a new terminal and try: boostnote search <words>\nRun it again here if you move the app.'
        : `${dir} is not on your PATH. Add it (for example, export PATH="${dir}:$PATH" in your shell profile) or run ${result.file} directly.`,
    })
  } catch (error) {
    await showMessage({
      type: 'warning',
      message: 'Could not install the command line tool.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
