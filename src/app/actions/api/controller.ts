import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createController } from 'remix/router'

import { migrateStorage } from '../../../migrate/index.ts'
import { type LinkMove, type Note, type TitleRename, type Vault, VaultError } from '../../../vault/index.ts'
import { errorResponse, HttpError, json, readJsonObject, requireString } from '../../http.ts'
import { routes } from '../../routes.ts'
import type { AppServices } from '../../services.ts'
import type { OpenRequest, SaveConflictBody } from '../public/workspace/types.ts'
import { exportFolder, exportNote } from './export.ts'
import { parseUiPatch, preferencesState, savePreferences } from './preferences.ts'
import { importSummary, toJsonValue, toNoteDocument, workspaceData } from './workspace-data.ts'

/** Largest asset the editor may upload (pasted screenshots, dropped images). */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024
/** Most entries one drop may carry (folders count once; their contents are capped by the vault). */
export const MAX_IMPORT_PATHS = 200

const FOLDER_COLOR = /^#[0-9a-f]{3,8}$/i

/**
 * The vault a request names with `?vault=<root>` (GET and POST alike). Several vaults can be open,
 * so every vault-scoped call says which one; a vault that is not open (closed since the page asked)
 * is a `409`, never another vault.
 */
function requireVault(services: AppServices, request: Request): Vault {
  const root = new URL(request.url).searchParams.get('vault')
  if (!root) throw new HttpError(400, 'BAD_REQUEST', 'Missing "vault"')
  const vault = services.vaults.get(root)
  if (!vault) throw new HttpError(409, 'NO_VAULT', `This vault is not open: ${root}`)
  return vault
}

/** The `moves` of a `/api/links/*` body: `[{ from, to, kind: 'note' | 'folder' }]`. */
function readMoves(body: Record<string, unknown>): LinkMove[] {
  if (!Array.isArray(body.moves) || body.moves.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'Missing or invalid "moves"')
  }
  return body.moves.map((item: unknown) => {
    const move = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    if (move.kind !== 'note' && move.kind !== 'folder')
      throw new HttpError(400, 'BAD_REQUEST', 'Missing or invalid "kind"')
    return { from: requireString(move.from, 'from'), to: requireString(move.to, 'to'), kind: move.kind }
  })
}

/**
 * The paths behind a drop ticket of `POST /api/import-files`: absolute paths of existing files or
 * folders. Main granted the ticket for paths the preload read from really dropped `File`s, so the
 * page never names a path itself; the paths are checked again here. Anything else is a `400`.
 */
async function readImportPaths(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'BAD_REQUEST', 'Missing or invalid "paths"')
  if (value.length > MAX_IMPORT_PATHS) {
    throw new HttpError(413, 'TOO_LARGE', `Too many files dropped at once (at most ${MAX_IMPORT_PATHS})`)
  }
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.includes('\0') || !path.isAbsolute(item)) {
      throw new HttpError(400, 'BAD_REQUEST', `Not an absolute path: ${JSON.stringify(item)}`)
    }
    const stats = await stat(item).catch(() => undefined)
    if (!stats) throw new HttpError(404, 'NOT_FOUND', `Not found: ${item}`)
    if (!stats.isFile() && !stats.isDirectory())
      throw new HttpError(400, 'BAD_REQUEST', `Not a file or folder: ${item}`)
    paths.push(path.normalize(item))
  }
  return paths
}

/** Runs an action and turns expected failures into JSON error responses. */
function guarded<Context>(action: (context: Context) => Promise<Response>): (context: Context) => Promise<Response> {
  return async (context) => {
    try {
      return await action(context)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

/**
 * The workspace's JSON API (`/api/*`). Mutations answer with the changed entity; the client
 * re-fetches `/api/workspace` for lists, because the vault's own writes never come back as events.
 */
export function createApiController(services: AppServices) {
  // Saves are checked against `baseHash` and written one at a time, so two saves can't interleave.
  let saveQueue: Promise<unknown> = Promise.resolve()
  const serializeSave = <T>(task: () => Promise<T>): Promise<T> => {
    const run = saveQueue.then(task, task)
    saveQueue = run.catch(() => undefined)
    return run
  }

  return createController(routes.api, {
    actions: {
      /** `?vault=<root>`: that open vault's lists; without it, the active vault's (the page's first render). */
      workspace: guarded(async ({ url }: { url: URL }) =>
        json(await workspaceData(services, url.searchParams.get('vault') ?? undefined)),
      ),

      search: guarded(async ({ request, url }: { request: Request; url: URL }) => {
        const vault = requireVault(services, request)
        const hits = vault.index.search(url.searchParams.get('q') ?? '', 500)
        return json({ ids: hits.map((hit) => hit.id) })
      }),

      vaultPick: guarded(async () => {
        const folder = await services.pickFolder({ title: 'Open Vault', buttonLabel: 'Open', createDirectory: true })
        if (folder === undefined) return json({ cancelled: true })
        await services.vaults.open(folder)
        return json({ cancelled: false, workspace: await workspaceData(services) })
      }),

      vaultOpen: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        await services.vaults.open(requireString(body.path, 'path'))
        return json({ cancelled: false, workspace: await workspaceData(services) })
      }),

      /** `{ path }`: closes that vault; the reply is the workspace of the vault that is active now. */
      vaultClose: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        await services.vaults.close(requireString(body.path, 'path'))
        return json(await workspaceData(services))
      }),

      vaultForget: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        services.vaults.forget(requireString(body.path, 'path'))
        return json(await workspaceData(services))
      }),

      noteRead: guarded(async ({ request, url }: { request: Request; url: URL }) => {
        const vault = requireVault(services, request)
        return json(toNoteDocument(await vault.readNote(requireString(url.searchParams.get('id'), 'id'))))
      }),

      noteCreate: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const folder = requireString(body.folder, 'folder', { allowEmpty: true })
        const title = body.title === undefined ? 'Untitled' : requireString(body.title, 'title')
        return json(toNoteDocument(await vault.createNote(folder, title)), { status: 201 })
      }),

      noteSave: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const id = requireString(body.id, 'id')
        const text = requireString(body.body, 'body', { allowEmpty: true })
        // `null`: the note must not exist (saving a copy of a note that was removed on disk).
        const baseHash = body.baseHash === null ? null : requireString(body.baseHash, 'baseHash')
        const frontmatter = body.frontmatter
        if (
          frontmatter !== undefined &&
          (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter))
        ) {
          throw new HttpError(400, 'BAD_REQUEST', 'Missing or invalid "frontmatter"')
        }
        const conflict = (current: Note) => {
          const conflictBody: SaveConflictBody = {
            error: 'CONFLICT',
            message: 'The note changed on disk since it was loaded',
            note: toNoteDocument(current),
          }
          return json(conflictBody, { status: 409 })
        }
        return serializeSave(async () => {
          let current: Note | undefined
          try {
            current = await vault.readNote(id)
          } catch (error) {
            if (baseHash !== null || !(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error
          }
          if (current && current.hash !== baseHash) return conflict(current)
          // Values the client got as JSON and sent back unchanged keep their original YAML value
          // (JSON can't represent everything YAML can, e.g. `.nan`), so only real edits are written.
          const previous = current?.frontmatter ?? {}
          const next =
            frontmatter === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(frontmatter).map(([key, value]) => {
                    const original = previous[key]
                    const unchanged = key in previous && isDeepStrictEqual(toJsonValue(original), value)
                    return [key, unchanged ? original : value]
                  }),
                )
          try {
            const note = await vault.writeNote(id, {
              body: text,
              baseHash,
              ...(next === undefined ? {} : { frontmatter: next }),
            })
            return json(toNoteDocument(note))
          } catch (error) {
            // Another program wrote the file while this save was in flight; theirs is on disk.
            if (error instanceof VaultError && error.code === 'CHANGED') return conflict(await vault.readNote(id))
            throw error
          }
        })
      }),

      noteRename: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const note = await vault.renameNote(requireString(body.id, 'id'), requireString(body.name, 'name'))
        return json(toNoteDocument(note))
      }),

      noteMove: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const folder = requireString(body.folder, 'folder', { allowEmpty: true })
        return json(toNoteDocument(await vault.moveNote(requireString(body.id, 'id'), folder)))
      }),

      noteDelete: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        return json(await vault.deleteNote(requireString(body.id, 'id')))
      }),

      noteReveal: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const id = requireString(body.id, 'id')
        // Validates the id (no traversal) and that the note exists.
        await vault.readNote(id)
        services.showItemInFolder(path.join(vault.root, ...id.split('/')))
        return json({ ok: true })
      }),

      titleRenamesPlan: guarded(async ({ request }: { request: Request }) =>
        json(await requireVault(services, request).planTitleRenames()),
      ),

      titleRenamesApply: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        if (!Array.isArray(body.renames)) throw new HttpError(400, 'BAD_REQUEST', 'Missing or invalid "renames"')
        const renames: TitleRename[] = body.renames.map((item: unknown) => {
          const rename = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
          return {
            from: requireString(rename.from, 'from'),
            to: requireString(rename.to, 'to'),
            title: requireString(rename.title, 'title', { allowEmpty: true }),
          }
        })
        return json(await vault.applyTitleRenames({ renames }))
      }),

      linksPlan: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        return json(await vault.planLinkUpdates(readMoves(await readJsonObject(request))))
      }),

      linksApply: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        return json(await vault.applyLinkUpdates(readMoves(await readJsonObject(request))))
      }),

      folderCreate: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const parent = requireString(body.parent, 'parent', { allowEmpty: true })
        return json({ id: await vault.createFolder(parent, requireString(body.name, 'name')) }, { status: 201 })
      }),

      folderRename: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        return json({ id: await vault.renameFolder(requireString(body.id, 'id'), requireString(body.name, 'name')) })
      }),

      folderMove: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const parent = requireString(body.parent, 'parent', { allowEmpty: true })
        return json({ id: await vault.moveFolder(requireString(body.id, 'id'), parent) })
      }),

      folderDelete: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        return json(await vault.deleteFolder(requireString(body.id, 'id')))
      }),

      folderColor: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const color = body.color === null ? undefined : requireString(body.color, 'color')
        if (color !== undefined && !FOLDER_COLOR.test(color)) {
          throw new HttpError(400, 'BAD_REQUEST', `Invalid colour: ${color}`)
        }
        await vault.setFolderColor(requireString(body.id, 'id'), color)
        return json({ ok: true })
      }),

      trashRestore: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        return json({ id: await vault.restore(requireString(body.id, 'id')) })
      }),

      trashEmpty: guarded(async ({ request }: { request: Request }) => {
        await requireVault(services, request).emptyTrash()
        return json({ ok: true })
      }),

      assetUpload: guarded(async ({ request, url }: { request: Request; url: URL }) => {
        const vault = requireVault(services, request)
        const noteId = requireString(url.searchParams.get('note'), 'note')
        const declared = Number(request.headers.get('Content-Length') ?? 0)
        if (declared > MAX_ASSET_BYTES) throw new HttpError(413, 'TOO_LARGE', 'The file is too large')
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength === 0) throw new HttpError(400, 'BAD_REQUEST', 'Empty upload')
        if (bytes.byteLength > MAX_ASSET_BYTES) throw new HttpError(413, 'TOO_LARGE', 'The file is too large')
        const href = await vault.saveAsset(noteId, bytes, url.searchParams.get('ext') ?? '')
        return json({ href }, { status: 201 })
      }),

      importCandidates: guarded(async () => json(await services.findLegacyStorages())),

      importPick: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        const purpose = body.purpose === 'target' ? 'target' : 'source'
        const folder = await services.pickFolder(
          purpose === 'source'
            ? { title: 'Choose a Boostnote storage', buttonLabel: 'Choose Storage' }
            : {
                title: 'Choose an empty folder for the new vault',
                buttonLabel: 'Choose Folder',
                createDirectory: true,
              },
        )
        return json({ path: folder ?? null })
      }),

      importFiles: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services, request)
        const body = await readJsonObject(request)
        const folder = requireString(body.folder, 'folder', { allowEmpty: true })
        const paths = services.drops.take(requireString(body.ticket, 'ticket'))
        if (paths === undefined) {
          throw new HttpError(403, 'FORBIDDEN', 'This drop has expired or was already imported; drop the files again')
        }
        return json(await vault.importFiles(await readImportPaths(paths), folder), { status: 201 })
      }),

      importRun: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        const report = await migrateStorage(
          requireString(body.source, 'source'),
          requireString(body.target, 'target'),
          {
            dryRun: body.dryRun === true,
            force: body.force === true,
          },
        )
        return json(importSummary(report))
      }),

      openExternal: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        const href = requireString(body.url, 'url')
        let url: URL
        try {
          url = new URL(href)
        } catch {
          throw new HttpError(400, 'BAD_REQUEST', `Not a URL: ${href}`)
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new HttpError(400, 'BAD_REQUEST', `Only http(s) links open externally: ${href}`)
        }
        await services.openExternal(url.href)
        return json({ ok: true })
      }),

      preferences: guarded(async () => json(preferencesState(services))),

      preferencesSave: guarded(async ({ request }: { request: Request }) =>
        json(savePreferences(services, parseUiPatch(await readJsonObject(request)))),
      ),

      exportNote: guarded(async ({ request }: { request: Request }) =>
        exportNote(services, requireVault(services, request), request),
      ),

      exportFolder: guarded(async ({ request }: { request: Request }) =>
        exportFolder(services, requireVault(services, request), request),
      ),

      openRequest: guarded(async () => {
        const pending: OpenRequest | null = (await services.vaults.takeOpenRequest()) ?? null
        return json(pending)
      }),
    },
  })
}
