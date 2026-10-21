import type { EventHub } from '../main/events.ts'
import type { SettingsStore, UiPreferences } from '../main/settings.ts'
import type { VaultSession } from '../main/vault-session.ts'
import type { LegacyStorageLocation } from '../migrate/index.ts'

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
}
