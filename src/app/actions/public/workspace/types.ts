/**
 * JSON shapes exchanged between the workspace client entry and the `/api` routes. Types only, so
 * both the browser modules and the main-process controllers import them.
 */

import type { VaultChangeEvent } from '../../../../main/events.ts'
import type {
  OutsideFilePreference,
  PaneLayout,
  ThemePreference,
  UiPatch,
  UiPreferences,
} from '../../../../main/settings.ts'
import type { UpdateInfo } from '../../../../main/updates.ts'
import type { OpenRequest } from '../../../../main/vault-session.ts'
import type { MenuCommand, MenuEvent } from '../../../../shared/commands.ts'
import type { NoteMeta } from '../../../../shared/vault-ids.ts'
import type {
  AssetsLeftBehind,
  FolderRelocation,
  ImportFilesReport,
  LinkMove,
  LinkUpdate,
  LinkUpdateReport,
  TitleRename,
  TitleRenamePlan,
  TitleRenameReport,
} from '../../../../vault/index.ts'

export type {
  AssetsLeftBehind,
  FolderRelocation,
  ImportFilesReport,
  LinkMove,
  LinkUpdate,
  LinkUpdateReport,
  MenuCommand,
  MenuEvent,
  OpenRequest,
  OutsideFilePreference,
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

/** What lists show about a note: the vault index's `NoteMeta`. */
export type NoteSummary = NoteMeta

/** A note as the editor needs it: frontmatter and body kept apart, `hash` for optimistic concurrency. */
export interface NoteDocument extends NoteSummary {
  frontmatter: { [key: string]: JsonValue }
  body: string
  /** sha256 of the whole file as last read or written. */
  hash: string
}

/**
 * `POST /api/notes/rename` and `/move`: the note at its new place, the moves to offer to
 * `/api/links/*` (empty when it stayed), and `assetsLeftBehind` when a stem twin (`a.MD` or `a.mdx`) kept the
 * shared assets folder.
 */
export interface NoteRelocationResult extends AssetsLeftBehind {
  note: NoteDocument
  moves: LinkMove[]
}

/**
 * `GET /api/reader/:ticket`: an outside `.md`/`.mdx` shown read-only in a reader tab; `name` is its base
 * name, never a path. `html` is the body rendered and sanitised by `src/markdown/render.ts` in main.
 */
export interface ReaderDocument {
  name: string
  frontmatter: { [key: string]: JsonValue }
  body: string
  html: string
}

/** `POST /api/reader/:ticket/open-folder`: the file's folder is the vault now; `id` is the file's note there. */
export interface ReaderFolderResult {
  id: string
  workspace: WorkspaceData
}

/**
 * `POST /api/reader/:ticket/import` (`{ folder }`): the reader's file was imported into `folder` of
 * the open vault and its ticket ended. The report's `source` paths are base names; `workspace` is
 * the vault it was imported into, read right after the import.
 */
export interface ReaderImportResult {
  report: ImportFilesReport
  workspace: WorkspaceData
}

/**
 * `POST /api/scratch/save` (`{ id, folder }`): the scratch note became note `id` in `folder` of the open vault, and
 * the scratch note is gone; `workspace` is that vault's lists with the note in them.
 */
export interface ScratchSaveResult {
  id: string
  workspace: WorkspaceData
}

/** A scratch note in the scratch list (`GET /api/scratch`): no text, never a path. */
export interface ScratchSummary {
  /** 32 lowercase hex characters. */
  id: string
  /** `scratchTitle` of its text and `created` (`src/shared/scratch.ts`). */
  title: string
  /** ISO-8601. */
  created: string
  /** ISO-8601; the file's last write. */
  updated: string
}

/** `POST /api/scratch/create`, `GET /api/scratch/read?id=`, `POST /api/scratch/write`: a scratch note and its text as typed. */
export interface ScratchNote extends ScratchSummary {
  text: string
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
  /** Every open vault (`vault` is one of them), in the order they were opened. */
  open: VaultSummary[]
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
