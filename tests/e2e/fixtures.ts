import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test as base, type ElectronApplication, _electron as electron, type Page } from '@playwright/test'

const projectRoot = path.resolve(import.meta.dirname, '../..')
/** Main-process preload: on macOS test windows never take the OS keyboard focus (see the file). */
const backgroundWindows = path.join(import.meta.dirname, 'background-windows.cjs')
/** Main-process preload: every window records its CSP violations from the start (see the file). */
const cspViolationRecorder = path.join(import.meta.dirname, 'csp-violations.cjs')

export interface AppHandle {
  electronApp: ElectronApplication
  page: Page
  /** Temp folder holding the vault, the profile and anything a test writes. */
  dir: string
  vault: string
  userDataDir: string
  /** Clicks a native menu item by id (the item ids are the menu commands, see src/main/menu.ts). */
  clickMenu(id: string): Promise<void>
  /** Makes the next native save dialog answer `file` (Playwright cannot drive native dialogs). */
  answerSaveDialog(file: string): Promise<void>
  /** Makes the next native folder picker answer `folder`. */
  answerOpenDialog(folder: string): Promise<void>
}

/** Files of the test vault, relative to its root. */
export type VaultFiles = Record<string, string>

export async function writeFiles(root: string, files: VaultFiles): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

/**
 * Writes `body` to `rel` under `<dir>/loose/` (outside the vault) and opens it as the OS does
 * (`open-file`), so the reader shows it.
 */
export async function openLooseFile(
  { dir, electronApp }: Pick<AppHandle, 'dir' | 'electronApp'>,
  rel: string,
  body: string,
): Promise<void> {
  await writeFiles(path.join(dir, 'loose'), { [rel]: body })
  await electronApp.evaluate(
    ({ app: electronApp }, target) => {
      electronApp.emit('open-file', { preventDefault() {} }, target)
    },
    path.join(dir, 'loose', ...rel.split('/')),
  )
}

export interface LaunchOptions {
  /** Written outside the vault (under `<dir>/loose/`) and passed on the command line. */
  openFiles?: VaultFiles
  /** Copies this folder into the temp vault (before `files` are written); the folder is only read. */
  vaultCopyOf?: string
  /** Preferences merged into the profile's `settings.json` `ui` section. */
  ui?: Record<string, unknown>
}

/**
 * Launches the app from source on a temp profile (`--user-data-dir`) whose settings reopen a temp
 * vault, with the global hotkey off so tests never fight a running Boostnote for it. On macOS its
 * window opens in the background and never takes the keyboard, so keys typed into other apps
 * meanwhile cannot reach a test. `openFiles` are passed on the command line, like a file association
 * does on Windows/Linux. The temp vault is a copy (`vaultCopyOf`), so a real vault is never opened.
 */
export async function launchApp(files: VaultFiles, options: LaunchOptions = {}): Promise<AppHandle> {
  const { openFiles = {}, vaultCopyOf, ui = {} } = options
  const root = await mkdtemp(path.join(tmpdir(), 'boostnote-e2e-'))
  const vault = path.join(root, 'vault')
  const userDataDir = path.join(root, 'profile')
  if (vaultCopyOf !== undefined) await cp(await realpath(vaultCopyOf), vault, { recursive: true })
  await writeFiles(vault, files)
  await writeFiles(path.join(root, 'loose'), openFiles)
  await mkdir(userDataDir, { recursive: true })
  // A temp home, so legacy-storage detection never finds the developer's real ~/Boostnote.
  await mkdir(path.join(root, 'home'), { recursive: true })
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ vaults: [vault], lastVault: vault, ui: { globalHotkey: '', ...ui } }),
  )
  const electronApp = await electron.launch({
    args: [
      '-r',
      backgroundWindows,
      '-r',
      cspViolationRecorder,
      projectRoot,
      `--user-data-dir=${userDataDir}`,
      ...Object.keys(openFiles).map((rel) => path.join(root, 'loose', ...rel.split('/'))),
    ],
    cwd: projectRoot,
    // No asset watcher: tests never change browser sources, and its thousands of file watchers
    // made every quit take over a second (see src/app/assets.ts).
    env: { ...process.env, NODE_ENV: 'development', HOME: path.join(root, 'home'), BOOSTNOTE_ASSET_WATCH: '0' },
  })
  const page = await electronApp.firstWindow()
  // Playwright emulates focus for browser pages but not for Electron's, whose focus follows the OS
  // window; on macOS the test window never gets that (background-windows.cjs), so the page emulates it.
  const cdp = await electronApp.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.waitForLoadState('domcontentloaded')
  // Menu commands arrive over SSE: wait until the workspace is listening.
  await page.locator('[data-connection="connected"]').waitFor()
  return {
    electronApp,
    page,
    dir: root,
    vault,
    userDataDir,
    clickMenu: (id) =>
      electronApp.evaluate(({ Menu }, menuId) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(menuId)
        if (!item) throw new Error(`No menu item ${menuId}`)
        item.click()
      }, id),
    answerSaveDialog: (file) =>
      electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, file),
    answerOpenDialog: (folder) =>
      electronApp.evaluate(({ dialog }, folderPath) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folderPath],
        })) as typeof dialog.showOpenDialog
      }, folder),
  }
}

/**
 * Closes the app, answering main's unsaved-changes quit dialog with 'Quit Anyway' (index 1), so a
 * test that leaves a note unsaved never leaves a native dialog open and never hangs teardown.
 */
export async function quitWithoutDialog(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  })
  await electronApp.close()
}

/**
 * The `securitypolicyviolation` events of `page` since its load began, recorded by a session
 * preload (`csp-violations.cjs`) that every window of the app gets, the hidden export windows too.
 */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'boostCspViolations')
    if (typeof read !== 'function') throw new Error(`no CSP violation recorder in ${location.href}`)
    return (read as () => string[])()
  })
}

/** `app`: a launched app per test, closed and its temp folder removed afterwards. */
export const test = base.extend<{ files: VaultFiles; ui: Record<string, unknown>; app: AppHandle }>({
  files: [{}, { option: true }],
  ui: [{}, { option: true }],
  app: async ({ files, ui }, use) => {
    const handle = await launchApp(files, { ui })
    await use(handle)
    await quitWithoutDialog(handle.electronApp)
    await rm(handle.dir, { recursive: true, force: true })
  },
})

export { expect } from '@playwright/test'
