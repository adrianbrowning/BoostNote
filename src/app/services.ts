import type { EventHub } from '../main/events.ts'
import type { SettingsStore, UiPreferences } from '../main/settings.ts'
import type { UpdateInfo } from '../main/updates.ts'
import type { VaultSession } from '../main/vault-session.ts'
import type { LegacyStorageLocation } from '../migrate/index.ts'
import type { DropGrants } from './drop-grants.ts'

export interface FolderPickerOptions {
  title: string
  buttonLabel: string
  /** Offer "New Folder" in the dialog (import target). */
  createDirectory?: boolean
  defaultPath?: string
}

/** The preferences the main process applies (Electron `nativeTheme`, spellchecker, `globalShortcut`). */
export interface PreferenceServices {
  /** Applies the theme (`nativeTheme.themeSource`) and the spellchecker setting. */
  apply(ui: UiPreferences): void
  /**
   * Makes `accelerator` the global show/hide hotkey (`''` removes it). `false` when the OS refused
   * it (taken by another app, or not a valid accelerator); the previous hotkey then stays active.
   */
  setHotkey(accelerator: string): boolean
  /** The accelerator currently registered, if any. */
  readonly registeredHotkey: string | undefined
}

export interface SaveFileOptions {
  title: string
  /** Suggested file name (or full path). */
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

/** What export needs from Electron: a save dialog and Chromium (mermaid layout, PDF, printing). */
export interface ExportServices {
  /** Native save dialog; `undefined` when cancelled. */
  saveFile(options: SaveFileOptions): Promise<string | undefined>
  /** SVG of a mermaid diagram, laid out by a hidden window; rejects with mermaid's error. */
  renderMermaid(source: string): Promise<string>
  /** PDF of a standalone HTML document (`htmlDocument`). */
  printToPdf(html: string): Promise<Uint8Array>
  /** Opens the system print dialog for a standalone HTML document; resolves when it is done or cancelled. */
  print(html: string): Promise<void>
}

/**
 * Everything the router needs from the main process. `src/main` passes Electron-backed
 * implementations (`dialog`, `shell`); tests pass fakes. Controllers never import Electron.
 */
export interface AppServices {
  events: EventHub
  vaults: VaultSession
  /** `userData/settings.json`; the router owns its `ui` section. */
  settings: SettingsStore
  preferences: PreferenceServices
  /** Native folder picker; `undefined` when cancelled. */
  pickFolder(options: FolderPickerOptions): Promise<string | undefined>
  /** Opens an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>
  /** Shows a file in Finder / Explorer / the file manager. */
  showItemInFolder(fullPath: string): void
  /** Legacy Boostnote storages on this machine (prefills the importer). */
  findLegacyStorages(): Promise<LegacyStorageLocation[]>
  /** Tickets for dragged-in files, granted by main from the preload's IPC (see `DropGrants`). */
  drops: Pick<DropGrants, 'take'>
  exports: ExportServices
  updates: UpdateServices
}

/** The update notice: the newest release found, and the automatic checks. */
export interface UpdateServices {
  /** Newest release newer than the running app found so far (dismissed or not). */
  readonly available: UpdateInfo | undefined
  /** Starts or stops the automatic daily checks (`ui.checkUpdates`). */
  setAutomatic(enabled: boolean): void
}
