import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createController } from 'remix/router'

import { migrateStorage } from '../../../migrate/index.ts'
import { type Note, type Vault, VaultError } from '../../../vault/index.ts'
import { errorResponse, HttpError, json, readJsonObject, requireString } from '../../http.ts'
import { routes } from '../../routes.ts'
import type { AppServices } from '../../services.ts'
import type { SaveConflictBody } from '../public/workspace/types.ts'
import { importSummary, toJsonValue, toNoteDocument, workspaceData } from './workspace-data.ts'

/** Largest asset the editor may upload (pasted screenshots, dropped images). */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024

const FOLDER_COLOR = /^#[0-9a-f]{3,8}$/i

function requireVault(services: AppServices): Vault {
  const vault = services.vaults.current
  if (!vault) throw new HttpError(409, 'NO_VAULT', 'No vault is open')
  return vault
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
      workspace: guarded(async () => json(await workspaceData(services))),

      search: guarded(async ({ url }: { url: URL }) => {
        const vault = requireVault(services)
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

      vaultClose: guarded(async () => {
        await services.vaults.close()
        return json(await workspaceData(services))
      }),

      vaultForget: guarded(async ({ request }: { request: Request }) => {
        const body = await readJsonObject(request)
        services.vaults.forget(requireString(body.path, 'path'))
        return json(await workspaceData(services))
      }),

      noteRead: guarded(async ({ url }: { url: URL }) => {
        const vault = requireVault(services)
        return json(toNoteDocument(await vault.readNote(requireString(url.searchParams.get('id'), 'id'))))
      }),

      noteCreate: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const folder = requireString(body.folder, 'folder', { allowEmpty: true })
        const title = body.title === undefined ? 'Untitled' : requireString(body.title, 'title')
        return json(toNoteDocument(await vault.createNote(folder, title)), { status: 201 })
      }),

      noteSave: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
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
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const note = await vault.renameNote(requireString(body.id, 'id'), requireString(body.name, 'name'))
        return json(toNoteDocument(note))
      }),

      noteMove: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const folder = requireString(body.folder, 'folder', { allowEmpty: true })
        return json(toNoteDocument(await vault.moveNote(requireString(body.id, 'id'), folder)))
      }),

      noteDelete: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        return json(await vault.deleteNote(requireString(body.id, 'id')))
      }),

      noteReveal: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const id = requireString(body.id, 'id')
        // Validates the id (no traversal) and that the note exists.
        await vault.readNote(id)
        services.showItemInFolder(path.join(vault.root, ...id.split('/')))
        return json({ ok: true })
      }),

      folderCreate: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const parent = requireString(body.parent, 'parent', { allowEmpty: true })
        return json({ id: await vault.createFolder(parent, requireString(body.name, 'name')) }, { status: 201 })
      }),

      folderRename: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        return json({ id: await vault.renameFolder(requireString(body.id, 'id'), requireString(body.name, 'name')) })
      }),

      folderMove: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const parent = requireString(body.parent, 'parent', { allowEmpty: true })
        return json({ id: await vault.moveFolder(requireString(body.id, 'id'), parent) })
      }),

      folderDelete: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        return json(await vault.deleteFolder(requireString(body.id, 'id')))
      }),

      folderColor: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        const color = body.color === null ? undefined : requireString(body.color, 'color')
        if (color !== undefined && !FOLDER_COLOR.test(color)) {
          throw new HttpError(400, 'BAD_REQUEST', `Invalid colour: ${color}`)
        }
        await vault.setFolderColor(requireString(body.id, 'id'), color)
        return json({ ok: true })
      }),

      trashRestore: guarded(async ({ request }: { request: Request }) => {
        const vault = requireVault(services)
        const body = await readJsonObject(request)
        return json({ id: await vault.restore(requireString(body.id, 'id')) })
      }),

      trashEmpty: guarded(async () => {
        await requireVault(services).emptyTrash()
        return json({ ok: true })
      }),

      assetUpload: guarded(async ({ request, url }: { request: Request; url: URL }) => {
        const vault = requireVault(services)
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
    },
  })
}
