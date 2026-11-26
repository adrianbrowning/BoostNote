import { routes } from '../../../routes.ts'
import type {
  AssetsLeftBehind,
  ExportResult,
  FolderRelocation,
  ImportCandidate,
  ImportFilesReport,
  ImportSummary,
  JsonValue,
  LinkMove,
  LinkUpdateReport,
  NoteDocument,
  NoteRelocationResult,
  OpenRequest,
  PreferencesState,
  ReaderDocument,
  ReaderFolderResult,
  ReaderImportResult,
  SaveConflictBody,
  ScratchNote,
  ScratchSaveResult,
  ScratchSummary,
  TitleRename,
  TitleRenamePlan,
  TitleRenameReport,
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

/**
 * The vault this page shows. Every request names it (`?vault=<root>`): several vaults can be open,
 * and a request that was in flight when the page switched must fail (`409 NO_VAULT` once that vault
 * is closed) rather than reach another vault. Set by `WorkspaceModel` whenever the vault changes.
 */
let pageVault: string | null = null

export function setPageVault(root: string | null): void {
  pageVault = root
}

/** `href` with `?vault=` (or `&vault=`) for the page's vault added. */
function inVault(href: string): string {
  if (pageVault === null) return href
  return `${href}${href.includes('?') ? '&' : '?'}${new URLSearchParams({ vault: pageVault })}`
}

/**
 * Sends a request to this app's own router and names the vault it is for: the page's `fetch` with the page's
 * vault added, or the router itself in tests (which adds the test app's vault).
 */
export type Transport = (href: string, init?: RequestInit) => Promise<Response>

/** A note save: the body, the hash it is based on (`null`: no note may exist there yet), and new frontmatter. */
export interface NoteSaveInput {
  id: string
  body: string
  baseHash: string | null
  frontmatter?: Record<string, JsonValue>
}

/**
 * A client's note calls (all `NoteSession` uses: reads, saves, image uploads, scratch-note saves); `createClient`
 * types its own with these.
 */
export interface NoteApi {
  readNote: (id: string) => Promise<NoteDocument>
  saveNote: (input: NoteSaveInput) => Promise<NoteDocument>
  /** Stores an image next to note `noteId`; `href` is the link to it, relative to the note. */
  uploadAsset: (noteId: string, file: File) => Promise<{ href: string }>
  /** Replaces scratch note `id`'s text (no hash: last write wins). */
  writeScratch: (id: string, text: string) => Promise<ScratchNote>
}

function withQuery(href: string, params: Record<string, string>): string {
  return `${href}?${new URLSearchParams(params)}`
}

/** URL of a file a note links to (`./todo.assets/x.png`), served by `GET /vault-assets/*`. */
export function vaultAssetUrl(noteId: string, src: string): string {
  return inVault(withQuery(routes.vaultAssets.href({ path: noteId }), { src }))
}

const api = routes.api

/** Typed client of the `/api` routes over `transport`; failures throw `ApiError`. */
export function createClient(transport: Transport) {
  /** Fetches a route of this app's own (in-process, typed) router; non-2xx responses throw `ApiError`. */
  async function request<T>(href: string, init?: RequestInit): Promise<T> {
    const response = await transport(href, init)
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

  const readNote: NoteApi['readNote'] = (id) => request(withQuery(api.noteRead.href(), { id }))
  const saveNote: NoteApi['saveNote'] = (input) => post(api.noteSave.href(), input)
  const uploadAsset: NoteApi['uploadAsset'] = (noteId, file) => {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? file.type.split('/')[1]?.replace(/\+.*$/, '') ?? 'bin'
    return request<{ href: string }>(withQuery(api.assetUpload.href(), { note: noteId, ext }), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  }
  const writeScratch: NoteApi['writeScratch'] = (id, text) => post(api.scratchWrite.href(), { id, text })

  return {
    workspace: () => request<WorkspaceData>(api.workspace.href()),
    search: (q: string, signal?: AbortSignal) =>
      request<{ ids: string[] }>(withQuery(api.search.href(), { q }), signal ? { signal } : {}),

    pickVault: () => post<VaultOpenResult>(api.vaultPick.href()),
    openVault: (path: string) => post<VaultOpenResult>(api.vaultOpen.href(), { path }),
    closeVault: (path: string) => post<WorkspaceData>(api.vaultClose.href(), { path }),
    forgetVault: (path: string) => post<WorkspaceData>(api.vaultForget.href(), { path }),

    readNote,
    createNote: (folder: string) => post<NoteDocument>(api.noteCreate.href(), { folder }),
    saveNote,
    renameNote: (id: string, name: string) => post<NoteRelocationResult>(api.noteRename.href(), { id, name }),
    moveNote: (id: string, folder: string) => post<NoteRelocationResult>(api.noteMove.href(), { id, folder }),
    deleteNote: (id: string) => post<AssetsLeftBehind>(api.noteDelete.href(), { id }),
    revealNote: (id: string) => post<unknown>(api.noteReveal.href(), { id }),
    planTitleRenames: () => request<TitleRenamePlan>(api.titleRenamesPlan.href()),
    applyTitleRenames: (renames: TitleRename[]) => post<TitleRenameReport>(api.titleRenamesApply.href(), { renames }),
    /** Links in other notes to the old place of renamed/moved notes or folders (dry run / rewrite). */
    planLinkUpdates: (moves: LinkMove[]) => post<LinkUpdateReport>(api.linksPlan.href(), { moves }),
    applyLinkUpdates: (moves: LinkMove[]) => post<LinkUpdateReport>(api.linksApply.href(), { moves }),

    createFolder: (parent: string, name: string) => post<{ id: string }>(api.folderCreate.href(), { parent, name }),
    renameFolder: (id: string, name: string) => post<FolderRelocation>(api.folderRename.href(), { id, name }),
    moveFolder: (id: string, parent: string) => post<FolderRelocation>(api.folderMove.href(), { id, parent }),
    deleteFolder: (id: string) => post<unknown>(api.folderDelete.href(), { id }),
    setFolderColor: (id: string, color: string | null) => post<unknown>(api.folderColor.href(), { id, color }),

    restore: (id: string) => post<{ id: string } & AssetsLeftBehind>(api.trashRestore.href(), { id }),
    emptyTrash: () => post<unknown>(api.trashEmpty.href()),

    uploadAsset,

    importCandidates: () => request<ImportCandidate[]>(api.importCandidates.href()),
    pickImportFolder: (purpose: 'source' | 'target') =>
      post<{ path: string | null }>(api.importPick.href(), { purpose }),
    runImport: (input: { source: string; target: string; dryRun: boolean; force: boolean }) =>
      post<ImportSummary>(api.importRun.href(), input),
    /** Copies the dropped `.md`/`.mdx` files/folders behind a preload drop ticket into `folder`. */
    importFiles: (ticket: string, folder: string) =>
      post<ImportFilesReport>(api.importFiles.href(), { ticket, folder }),

    openExternal: (url: string) => post<unknown>(api.openExternal.href(), { url }),

    savePreferences: (patch: UiPatch) => post<PreferencesState>(api.preferencesSave.href(), patch),

    exportNote: (id: string, format: 'html' | 'pdf' | 'markdown' | 'print') =>
      post<ExportResult>(api.exportNote.href(), { id, format }),
    exportFolder: (folder: string) => post<ExportResult>(api.exportFolder.href(), { folder }),
    takeOpenRequest: () => post<OpenRequest | null>(api.openRequest.href()),
    readReader: (ticket: string) => request<ReaderDocument>(api.readerRead.href({ ticket })),
    /** Revokes a reader tab's ticket (the tab closed). */
    closeReader: (ticket: string) => post<unknown>(api.readerClose.href({ ticket })),
    /** Main opens the folder of the reader tab's file as the vault and revokes the ticket. */
    openReaderFolder: (ticket: string) => post<ReaderFolderResult>(api.readerOpenFolder.href({ ticket })),
    /** Main imports the reader tab's file into `folder` of the open vault and revokes the ticket once a note came in. */
    importReader: (ticket: string, folder: string) =>
      post<ReaderImportResult>(api.readerImport.href({ ticket }), { folder }),

    /** Scratch notes (outside every vault; they work with no vault open). */
    listScratch: () => request<ScratchSummary[]>(api.scratchList.href()),
    createScratch: () => post<ScratchNote>(api.scratchCreate.href()),
    readScratch: (id: string) => request<ScratchNote>(withQuery(api.scratchRead.href(), { id })),
    writeScratch,
    discardScratch: (id: string) => post<unknown>(api.scratchDiscard.href(), { id }),
    /** Save to vault: main turns scratch note `id` into a note in `folder` of the open vault and removes it. */
    saveScratch: (id: string, folder: string) => post<ScratchSaveResult>(api.scratchSave.href(), { id, folder }),
  }
}

/** The typed client of every `/api` route (`createClient`): the page's `client`, or one over the router in tests. */
export type Client = ReturnType<typeof createClient>

/**
 * A client's calls `Navigation` uses (notes it opens, creates and deletes; reader tabs; scratch notes it creates,
 * opens and discards when their tab closes blank, and the scratch list it restores the last run's scratch tabs against).
 */
export type NavigationApi = Pick<
  Client,
  | 'readNote'
  | 'saveNote'
  | 'createNote'
  | 'deleteNote'
  | 'deleteFolder'
  | 'readReader'
  | 'closeReader'
  | 'createScratch'
  | 'readScratch'
  | 'listScratch'
  | 'discardScratch'
>

/** The page's client of the `/api` routes. */
export const client = createClient((href, init) => fetch(inVault(href), init))
