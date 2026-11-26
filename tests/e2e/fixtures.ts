import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { test as base, type ElectronApplication, _electron as electron, type Page } from '@playwright/test'
import type { Menu } from 'electron'

import type { Settings, UiPatch, UiPreferences } from '../../src/main/settings.ts'

const projectRoot = path.resolve(import.meta.dirname, '../..')
/** Main-process preload: on macOS test windows never take the OS keyboard focus (see the file). */
const backgroundWindows = path.join(import.meta.dirname, 'background-windows.cjs')
/**
 * Main-process registrar (loaded with -r): adds the session preload `csp-violations-preload.cjs`,
 * which records each window's CSP violations from the start.
 */
const cspViolationRecorder = path.join(import.meta.dirname, 'csp-violations.cjs')
/** Main-process preload: `globalShortcut` registers with a fake OS instead of the real one (see the file). */
const fakeGlobalShortcuts = path.join(import.meta.dirname, 'global-shortcuts.cjs')

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

/**
 * Presses the global hotkey `accelerator` as the OS would: runs the callback the app registered for it with the
 * fake OS of `global-shortcuts.cjs`. Throws when the app has nothing registered for it.
 */
export async function pressGlobalShortcut(
  { electronApp }: Pick<AppHandle, 'electronApp'>,
  accelerator: string,
): Promise<void> {
  await electronApp.evaluate((_electron, target) => {
    const shortcuts: Map<string, () => void> = Reflect.get(globalThis, 'boostGlobalShortcuts')
    const callback = shortcuts.get(target)
    if (!callback) throw new Error(`No global shortcut ${target} is registered`)
    callback()
  }, accelerator)
}

/** Makes the fake OS of `global-shortcuts.cjs` refuse `accelerator`, as when another app holds it. */
export async function takeGlobalShortcut(
  { electronApp }: Pick<AppHandle, 'electronApp'>,
  accelerator: string,
): Promise<void> {
  await electronApp.evaluate((_electron, target) => {
    const taken: Set<string> = Reflect.get(globalThis, 'boostTakenShortcuts')
    taken.add(target)
  }, accelerator)
}

/**
 * The app's `settings.json` from its temp profile. launchApp seeds a partial `ui`, but the app
 * rewrites the file with its sanitized settings (a full, normalized `ui`) when it restores the
 * vaults at start-up, before its window opens, so by the time launchApp returns it is full.
 */
export async function readSettings({
  userDataDir,
}: Pick<AppHandle, 'userDataDir'>): Promise<Settings & { ui: UiPreferences }> {
  return JSON.parse(await readFile(path.join(userDataDir, 'settings.json'), 'utf8'))
}

export interface LaunchOptions {
  /** Written outside the vault (under `<dir>/loose/`) and passed on the command line. */
  openFiles?: VaultFiles
  /** Copies this folder into the temp vault (before `files` are written); the folder is only read. */
  vaultCopyOf?: string
  /** Preferences merged into the profile's `settings.json` `ui` section. */
  ui?: UiPatch
}

/**
 * Launches the app from source on a temp profile (`--user-data-dir`) whose settings reopen a temp
 * vault, with the global hotkey off and `globalShortcut` on a fake OS (`global-shortcuts.cjs`), so tests
 * never fight a running Boostnote or another app for a hotkey. On macOS its
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
  const started = await startApp(
    root,
    Object.keys(openFiles).map((rel) => path.join(root, 'loose', ...rel.split('/'))),
  )
  const handle: AppHandle = {
    ...started,
    dir: root,
    vault,
    userDataDir,
    // `handle.electronApp`: the app of the current run, also after `relaunchApp`.
    clickMenu: (id) =>
      handle.electronApp.evaluate(({ Menu }, menuId) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById(menuId)
        if (!item) throw new Error(`No menu item ${menuId}`)
        item.click()
      }, id),
    answerSaveDialog: (file) =>
      handle.electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      }, file),
    answerOpenDialog: (folder) =>
      handle.electronApp.evaluate(({ dialog }, folderPath) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folderPath],
        })) as typeof dialog.showOpenDialog
      }, folder),
  }
  return handle
}

/**
 * Quits the app (`quitWithoutDialog`) and launches it again on the same temp root and `--user-data-dir` profile, so
 * its settings, the page's `localStorage` and the scratch notes carry over (the loose files launchApp opened are not
 * passed again).
 * `app` then drives the new run: its `electronApp` and `page` are replaced, so read them from `app` after this.
 */
export async function relaunchApp(app: AppHandle): Promise<void> {
  await quitWithoutDialog(app.electronApp)
  Object.assign(app, await startApp(app.dir))
}

/** Starts Electron on the app with the profile of the temp root `root`, `args` after it; resolves once the workspace listens. */
async function startApp(root: string, args: string[] = []): Promise<Pick<AppHandle, 'electronApp' | 'page'>> {
  const electronApp = await electron.launch({
    args: [
      '-r',
      backgroundWindows,
      '-r',
      cspViolationRecorder,
      '-r',
      fakeGlobalShortcuts,
      projectRoot,
      `--user-data-dir=${path.join(root, 'profile')}`,
      ...args,
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
  return { electronApp, page }
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
 * The `securitypolicyviolation` events of `page` since its load began, recorded by the session
 * preload (`csp-violations-preload.cjs`) that the main-process registrar (`csp-violations.cjs`)
 * adds to every window of the app, the hidden export windows too.
 */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'boostCspViolations')
    if (typeof read !== 'function') throw new Error(`no CSP violation recorder in ${location.href}`)
    return (read as () => string[])()
  })
}

declare global {
  interface Window {
    /**
     * `failableSaves`' page-side state: while `hold` is set, note saves wait for it (`held` counts them since
     * `hold` was set); then, while `fail` is set, they answer `status` with a "Disk full" error body.
     */
    failingSaves?: { fail: boolean; status: number; hold: Promise<void> | null; held: number; release(): void }
    /** `holdRequests`' page-side state: requests to `pathname` wait for `hold` (`held` counts them). */
    heldRequests?: { pathname: string; hold: Promise<void>; held: number; release(): void }
  }
}

/** Controls of the page's note saves, from `failableSaves`. */
export interface FailableSaves {
  /** Note saves answer `status` (default 500, "Disk full") while `on`. */
  fail(on: boolean, status?: number): Promise<void>
  /** Note saves from now on wait until `release`, so a test decides when the server sees them. */
  hold(): Promise<void>
  /** How many note saves have waited since `hold`. */
  held(): Promise<number>
  /** Lets the held saves (and later ones) through. */
  release(): Promise<void>
}

/** Wraps the page's `fetch` so note saves can be failed or held (`page.route` misses `boost://`). */
export async function failableSaves(page: Page): Promise<FailableSaves> {
  await page.evaluate(() => {
    const original = window.fetch
    const state: NonNullable<Window['failingSaves']> = { fail: false, status: 500, hold: null, held: 0, release() {} }
    window.failingSaves = state
    window.fetch = async (input, init) => {
      const { pathname } = new URL(String(input), location.href)
      if (pathname === '/api/notes/save') {
        if (state.hold) {
          state.held += 1
          await state.hold
        }
        if (state.fail) {
          return new Response(JSON.stringify({ error: 'IO', message: 'Disk full' }), { status: state.status })
        }
      }
      return original(input, init)
    }
  })
  return {
    fail: (on, status = 500) =>
      page.evaluate(
        (value) => {
          if (window.failingSaves) Object.assign(window.failingSaves, value)
        },
        { fail: on, status },
      ),
    hold: () =>
      page.evaluate(() => {
        const state = window.failingSaves
        if (!state) return
        const { promise, resolve } = Promise.withResolvers<void>()
        Object.assign(state, {
          hold: promise,
          held: 0,
          release: () => {
            state.hold = null
            resolve()
          },
        })
      }),
    held: () => page.evaluate(() => window.failingSaves?.held ?? 0),
    release: () => page.evaluate(() => window.failingSaves?.release()),
  }
}

/** Controls of the requests `holdRequests` holds. */
export interface HeldRequests {
  /** How many requests have waited so far. */
  held(): Promise<number>
  /** Lets the held requests (and later ones) through. */
  release(): Promise<void>
}

/** Wraps the page's `fetch` so requests to API path `pathname` wait until `release` (`page.route` misses `boost://`). */
export async function holdRequests(page: Page, pathname: string): Promise<HeldRequests> {
  await page.evaluate((target) => {
    const original = window.fetch
    const { promise, resolve } = Promise.withResolvers<void>()
    const state: NonNullable<Window['heldRequests']> = { pathname: target, hold: promise, held: 0, release: resolve }
    window.heldRequests = state
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.href).pathname === state.pathname) {
        state.held += 1
        await state.hold
      }
      return original(input, init)
    }
  }, pathname)
  return {
    held: () => page.evaluate(() => window.heldRequests?.held ?? 0),
    release: () => page.evaluate(() => window.heldRequests?.release()),
  }
}

/** Main-process state of `captureContextMenus`: each menu `Menu.prototype.popup` was called on. */
type MenuCapture = { poppedMenus?: Menu[] }

/** Controls of the native menus `captureContextMenus` captures. */
export interface CapturedMenus {
  /** The item labels of each menu popped up since the capture began, `---` for a separator. */
  labels(): Promise<string[][]>
  /**
   * Calls the `click` handler of the item labelled `label` in the last menu popped up. Role items
   * (Cut, Copy, Paste, Select All) do nothing here: Electron runs a role only with the focused
   * window and webContents a real menu passes.
   */
  click(label: string): Promise<void>
}

/**
 * Replaces `Menu.prototype.popup` in main, so native menus (the editable-field context menu) are
 * recorded instead of shown; Playwright cannot drive a native menu.
 */
export async function captureContextMenus(electronApp: ElectronApplication): Promise<CapturedMenus> {
  await electronApp.evaluate(({ Menu }) => {
    const popped: Menu[] = []
    ;(globalThis as MenuCapture).poppedMenus = popped
    Menu.prototype.popup = function popup(this: Menu) {
      popped.push(this)
    }
  })
  return {
    labels: () =>
      electronApp.evaluate(() =>
        ((globalThis as MenuCapture).poppedMenus ?? []).map((menu) =>
          menu.items.map((item) => (item.type === 'separator' ? '---' : item.label)),
        ),
      ),
    click: (label) =>
      electronApp.evaluate((_electron, itemLabel) => {
        const item = (globalThis as MenuCapture).poppedMenus?.at(-1)?.items.find((i) => i.label === itemLabel)
        if (!item) throw new Error(`No popped-up menu item ${itemLabel}`)
        item.click()
      }, label),
  }
}

/** `app`: a launched app per test, closed and its temp folder removed afterwards. */
export const test = base.extend<{ files: VaultFiles; ui: UiPatch; app: AppHandle }>({
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
