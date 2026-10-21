import type { EventHub } from '../main/events.ts'
import type { VaultSession } from '../main/vault-session.ts'
import type { LegacyStorageLocation } from '../migrate/index.ts'

export interface FolderPickerOptions {
  title: string
  buttonLabel: string
  /** Offer "New Folder" in the dialog (import target). */
  createDirectory?: boolean
  defaultPath?: string
}

/**
 * Everything the router needs from the main process. `src/main` passes Electron-backed
 * implementations (`dialog`, `shell`); tests pass fakes. Controllers never import Electron.
 */
export interface AppServices {
  events: EventHub
  vaults: VaultSession
  /** Native folder picker; `undefined` when cancelled. */
  pickFolder(options: FolderPickerOptions): Promise<string | undefined>
  /** Opens an http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>
  /** Shows a file in Finder / Explorer / the file manager. */
  showItemInFolder(fullPath: string): void
  /** Legacy Boostnote storages on this machine (prefills the importer). */
  findLegacyStorages(): Promise<LegacyStorageLocation[]>
}
