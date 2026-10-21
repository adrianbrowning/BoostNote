import { routes } from '../../../routes.ts'
import type {
  ImportCandidate,
  ImportSummary,
  JsonValue,
  NoteDocument,
  PreferencesState,
  SaveConflictBody,
  UiPatch,
  WorkspaceData,
} from './types.ts'

/** A non-2xx `/api` response (`ApiErrorBody`; on a save conflict also the note now on disk). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** `SaveConflictBody.note` of a `409 CONFLICT` from `POST /api/notes/save`. */
  readonly conflict: NoteDocument | undefined

  constructor(status: number, body: unknown) {
    const fields = typeof body === 'object' && body !== null ? body : {}
    super('message' in fields && typeof fields.message === 'string' ? fields.message : `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = 'error' in fields && typeof fields.error === 'string' ? fields.error : 'HTTP_ERROR'
    // The router is in-process and typed (`SaveConflictBody`); only the discriminant needs checking.
    const conflict: SaveConflictBody | undefined =
      this.code === 'CONFLICT' && 'note' in fields ? (fields as SaveConflictBody) : undefined
    this.conflict = conflict?.note
  }
}

export interface VaultOpenResult {
  cancelled: boolean
  workspace?: WorkspaceData
}

/** Fetches a route of this app's own (in-process, typed) router; non-2xx responses throw `ApiError`. */
async function request<T>(href: string, init?: RequestInit): Promise<T> {
  const response = await fetch(href, init)
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data)
  const typed = data as T
  return typed
}

function post<T>(href: string, body: unknown = {}): Promise<T> {
  return request<T>(href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function withQuery(href: string, params: Record<string, string>): string {
  return `${href}?${new URLSearchParams(params)}`
}

/** URL of a file a note links to (`./todo.assets/x.png`), served by `GET /vault-assets/*`. */
export function vaultAssetUrl(noteId: string, src: string): string {
  return withQuery(routes.vaultAssets.href({ path: noteId }), { src })
}

const api = routes.api

/** Typed client of the `/api` routes; failures throw `ApiError`. */
export const client = {
  workspace: () => request<WorkspaceData>(api.workspace.href()),
  search: (q: string, signal?: AbortSignal) =>
    request<{ ids: string[] }>(withQuery(api.search.href(), { q }), signal ? { signal } : {}),

  pickVault: () => post<VaultOpenResult>(api.vaultPick.href()),
  openVault: (path: string) => post<VaultOpenResult>(api.vaultOpen.href(), { path }),
  closeVault: () => post<WorkspaceData>(api.vaultClose.href()),
  forgetVault: (path: string) => post<WorkspaceData>(api.vaultForget.href(), { path }),

  readNote: (id: string) => request<NoteDocument>(withQuery(api.noteRead.href(), { id })),
  createNote: (folder: string) => post<NoteDocument>(api.noteCreate.href(), { folder }),
  saveNote: (input: { id: string; body: string; baseHash: string | null; frontmatter?: Record<string, JsonValue> }) =>
    post<NoteDocument>(api.noteSave.href(), input),
  renameNote: (id: string, name: string) => post<NoteDocument>(api.noteRename.href(), { id, name }),
  moveNote: (id: string, folder: string) => post<NoteDocument>(api.noteMove.href(), { id, folder }),
  deleteNote: (id: string) => post<unknown>(api.noteDelete.href(), { id }),
  revealNote: (id: string) => post<unknown>(api.noteReveal.href(), { id }),

  createFolder: (parent: string, name: string) => post<{ id: string }>(api.folderCreate.href(), { parent, name }),
  renameFolder: (id: string, name: string) => post<{ id: string }>(api.folderRename.href(), { id, name }),
  moveFolder: (id: string, parent: string) => post<{ id: string }>(api.folderMove.href(), { id, parent }),
  deleteFolder: (id: string) => post<unknown>(api.folderDelete.href(), { id }),
  setFolderColor: (id: string, color: string | null) => post<unknown>(api.folderColor.href(), { id, color }),

  restore: (id: string) => post<{ id: string }>(api.trashRestore.href(), { id }),
  emptyTrash: () => post<unknown>(api.trashEmpty.href()),

  uploadAsset: (noteId: string, file: File) => {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? file.type.split('/')[1]?.replace(/\+.*$/, '') ?? 'bin'
    return request<{ href: string }>(withQuery(api.assetUpload.href(), { note: noteId, ext }), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  },

  importCandidates: () => request<ImportCandidate[]>(api.importCandidates.href()),
  pickImportFolder: (purpose: 'source' | 'target') => post<{ path: string | null }>(api.importPick.href(), { purpose }),
  runImport: (input: { source: string; target: string; dryRun: boolean; force: boolean }) =>
    post<ImportSummary>(api.importRun.href(), input),

  openExternal: (url: string) => post<unknown>(api.openExternal.href(), { url }),

  savePreferences: (patch: UiPatch) => post<PreferencesState>(api.preferencesSave.href(), patch),
}
