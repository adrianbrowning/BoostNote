import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test as base, type ElectronApplication, _electron as electron, type Page } from '@playwright/test'

const projectRoot = path.resolve(import.meta.dirname, '../..')

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
 * Launches the app from source on a temp profile (`--user-data-dir`) whose settings reopen a temp
 * vault, with the global hotkey off so tests never fight a running Boostnote for it. `openFiles` are
 * written outside the vault (under `<dir>/loose/`) and passed on the command line, like a file
 * association does on Windows/Linux.
 */
export async function launchApp(files: VaultFiles, openFiles: VaultFiles = {}): Promise<AppHandle> {
  const root = await mkdtemp(path.join(tmpdir(), 'boostnote-e2e-'))
  const vault = path.join(root, 'vault')
  const userDataDir = path.join(root, 'profile')
  await writeFiles(vault, files)
  await writeFiles(path.join(root, 'loose'), openFiles)
  await mkdir(userDataDir, { recursive: true })
  // A temp home, so legacy-storage detection never finds the developer's real ~/Boostnote.
  await mkdir(path.join(root, 'home'), { recursive: true })
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ vaults: [vault], lastVault: vault, ui: { globalHotkey: '' } }),
  )
  const electronApp = await electron.launch({
    args: [
      projectRoot,
      `--user-data-dir=${userDataDir}`,
      ...Object.keys(openFiles).map((rel) => path.join(root, 'loose', ...rel.split('/'))),
    ],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'development', HOME: path.join(root, 'home') },
  })
  const page = await electronApp.firstWindow()
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

/** `app`: a launched app per test, closed and its temp folder removed afterwards. */
export const test = base.extend<{ files: VaultFiles; app: AppHandle }>({
  files: [{}, { option: true }],
  app: async ({ files }, use) => {
    const handle = await launchApp(files)
    await use(handle)
    await handle.electronApp.close()
    await rm(handle.dir, { recursive: true, force: true })
  },
})

export { expect } from '@playwright/test'
