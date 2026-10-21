/**
 * JSON shapes exchanged between the workspace client entry and the `/api` routes. Types only, so
 * both the browser modules and the main-process controllers import them.
 */
import type { MenuCommand, MenuEvent, VaultChangeEvent } from '../../../../main/events.ts'
import type { PaneLayout, ThemePreference, UiPatch, UiPreferences } from '../../../../main/settings.ts'
import type { UpdateInfo } from '../../../../main/updates.ts'
import type { OpenRequest } from '../../../../main/vault-session.ts'
import type { TitleRename, TitleRenamePlan, TitleRenameReport } from '../../../../vault/index.ts'

export type {
  MenuCommand,
  MenuEvent,
  OpenRequest,
  PaneLayout,
  ThemePreference,
  TitleRename,
  TitleRenamePlan,
  TitleRenameReport,
  UiPatch,
  UiPreferences,
  UpdateInfo,
  VaultChangeEvent,
}

/** `GET`/`POST /api/preferences`. */
export interface PreferencesState {
  ui: UiPreferences
  /** Whether `ui.globalHotkey` is registered with the OS right now. */
  hotkeyRegistered: boolean
  /** The update notice to show, `null` when there is none (or it was dismissed). */
  update: UpdateInfo | null
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** What lists show about a note (the vault index's `NoteMeta`). */
export interface NoteSummary {
  id: string
  folder: string
  title: string
  tags: string[]
  starred: boolean
  created: string
  updated: string
  excerpt: string
}

/** A note as the editor needs it: frontmatter and body kept apart, `hash` for optimistic concurrency. */
export interface NoteDocument extends NoteSummary {
  frontmatter: { [key: string]: JsonValue }
  body: string
  /** sha256 of the whole file as last read or written. */
  hash: string
}

export interface FolderSummary {
  /** `''` for the vault root. */
  id: string
  name: string
  color?: string
  folders: FolderSummary[]
}

export interface TrashSummary {
  id: string
  kind: 'note' | 'folder'
  originalPath: string
  deletedAt: string
  title?: string
}

export interface VaultSummary {
  root: string
  name: string
}

/** Everything the sidebar and note list render. `vault` is `null` when no vault is open. */
export interface WorkspaceData {
  vault: VaultSummary | null
  recent: VaultSummary[]
  tree: FolderSummary | null
  notes: NoteSummary[]
  trash: TrashSummary[]
}

/** Error body of every non-2xx `/api` response. */
export interface ApiErrorBody {
  /** `VaultError`/`MigrationError` code, `CONFLICT`, `NO_VAULT`, `BAD_REQUEST`. */
  error: string
  message: string
}

/** `409` from `POST /api/notes/save`: the file changed since `baseHash`; `note` is what is on disk now. */
export interface SaveConflictBody extends ApiErrorBody {
  error: 'CONFLICT'
  note: NoteDocument
}

/** `POST /api/export/note` and `/api/export/folder`: where the export was written; `null` when cancelled or printed. */
export interface ExportResult {
  path: string | null
}

export interface ImportCandidate {
  path: string
  name?: string
}

/** The importer's report (`MigrationReport`), trimmed to what the dialog shows. */
export interface ImportSummary {
  source: string
  target: string
  dryRun: boolean
  counts: {
    folders: number
    notes: number
    markdownNotes: number
    snippetNotes: number
    trashedNotes: number
    attachments: number
    noteLinks: number
    skippedNotes: number
  }
  renamed: number
  unresolvedAttachments: number
  unresolvedLinks: number
  warnings: string[]
  /** Written next to the vault on a real run. */
  reportPath?: string
}
