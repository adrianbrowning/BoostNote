import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_IMPORT_PATHS } from '../../src/app/actions/api/controller.ts'
import type {
  ImportFilesReport,
  ImportSummary,
  LinkUpdateReport,
  NoteDocument,
  OpenRequest,
  SaveConflictBody,
  TitleRenamePlan,
  TitleRenameReport,
  WorkspaceData,
} from '../../src/app/actions/public/workspace/types.ts'
import { errorResponse, HttpError, VAULT_ERROR_STATUS } from '../../src/app/http.ts'
import { routes } from '../../src/app/routes.ts'
import { MigrationError } from '../../src/migrate/index.ts'
import { type Vault, VaultError } from '../../src/vault/index.ts'
import { createLegacyStorage } from '../migrate/fixture.ts'
import { TestApp } from './helpers.ts'

const api = routes.api
let app: TestApp

beforeEach(async () => {
  app = await TestApp.create()
})

afterEach(async () => {
  await app.close()
})

async function readJson<T>(response: Response): Promise<T> {
  const body: T = await response.json()
  return body
}

describe('error mapping', () => {
  it('maps every VaultError code to an HTTP status', async () => {
    expect(VAULT_ERROR_STATUS).toEqual({
      INVALID_PATH: 400,
      NOT_FOUND: 404,
      EXISTS: 409,
      NOT_A_VAULT: 400,
      CHANGED: 409,
      TOO_LARGE: 413,
    })
    const response = errorResponse(new VaultError('EXISTS', 'Already exists: a.md'))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'EXISTS', message: 'Already exists: a.md' })
  })

  it('maps MigrationError and HttpError, and rethrows unexpected errors', () => {
    expect(errorResponse(new MigrationError('TARGET_NOT_EMPTY', 'not empty')).status).toBe(409)
    expect(errorResponse(new MigrationError('NOT_A_LEGACY_STORAGE', 'nope')).status).toBe(400)
    expect(errorResponse(new HttpError(413, 'TOO_LARGE', 'big')).status).toBe(413)
    expect(() => errorResponse(new Error('boom'))).toThrow('boom')
  })

  it('answers vault errors from the routes with their status and JSON body', async () => {
    await app.openVault()
    const missing = await app.get(`${api.noteRead.href()}?id=nope.md`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'NOT_FOUND' })

    const traversal = await app.get(`${api.noteRead.href()}?id=${encodeURIComponent('../outside.md')}`)
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toMatchObject({ error: 'INVALID_PATH' })

    await app.post(api.folderCreate.href(), { parent: '', name: 'Work' })
    const duplicate = await app.post(api.folderCreate.href(), { parent: '', name: 'Work' })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ error: 'EXISTS' })
  })

  it('rejects API calls without an open vault and malformed bodies', async () => {
    const noVault = await app.post(api.noteCreate.href(), { folder: '' })
    expect(noVault.status).toBe(409)
    expect(await noVault.json()).toMatchObject({ error: 'NO_VAULT' })

    await app.openVault()
    const bad = await app.router.fetch(
      new Request(new URL(api.noteCreate.href(), 'http://app'), { method: 'POST', body: 'not json' }),
    )
    expect(bad.status).toBe(400)
    expect((await app.post(api.noteRename.href(), { id: 'a.md' })).status).toBe(400)
  })
})

describe('notes', () => {
  let vault: Vault

  beforeEach(async () => {
    vault = await app.openVault()
  })

  async function createNote(folder = ''): Promise<NoteDocument> {
    const response = await app.post(api.noteCreate.href(), { folder })
    expect(response.status).toBe(201)
    return readJson<NoteDocument>(response)
  }

  it('reads a note with its body and frontmatter apart', async () => {
    await writeFile(path.join(vault.root, 'todo.md'), '---\ntags: [a]\ncustom: keep\n---\n# Todo\n\nBody\n')
    await vault.refresh()
    const note = await readJson<NoteDocument>(await app.get(`${api.noteRead.href()}?id=todo.md`))
    expect(note).toMatchObject({ id: 'todo.md', title: 'todo', tags: ['a'], body: '# Todo\n\nBody\n' })
    expect(note.frontmatter).toEqual({ tags: ['a'], custom: 'keep' })
    expect(note.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('saves the body against the base hash and returns the new hash', async () => {
    const note = await createNote()
    const response = await app.post(api.noteSave.href(), {
      id: note.id,
      body: '# Hello\n\nWorld\n',
      baseHash: note.hash,
    })
    expect(response.status).toBe(200)
    const saved = await readJson<NoteDocument>(response)
    expect(saved.hash).not.toBe(note.hash)
    // The name is the file name, whatever the first heading says.
    expect(saved.title).toBe('Untitled')
    expect(saved.id).toBe('Untitled.md')
    const raw = await readFile(path.join(vault.root, note.id), 'utf8')
    expect(raw).toMatch(/^---\ncreated: .+\nupdated: .+\n---\n# Hello\n\nWorld\n$/)
  })

  it('answers 409 with the disk version when the base hash is stale', async () => {
    const note = await createNote()
    await writeFile(path.join(vault.root, note.id), '# Changed elsewhere\n')
    const response = await app.post(api.noteSave.href(), { id: note.id, body: 'mine', baseHash: note.hash })
    expect(response.status).toBe(409)
    const conflict = await readJson<SaveConflictBody>(response)
    expect(conflict.error).toBe('CONFLICT')
    expect(conflict.note.body).toBe('# Changed elsewhere\n')
    expect(await readFile(path.join(vault.root, note.id), 'utf8')).toBe('# Changed elsewhere\n')

    // Keeping mine = saving again on top of their hash.
    const retry = await app.post(api.noteSave.href(), { id: note.id, body: 'mine\n', baseHash: conflict.note.hash })
    expect(retry.status).toBe(200)
    expect(await readFile(path.join(vault.root, note.id), 'utf8')).toMatch(/\nmine\n$/)
  })

  it('writes a removed note back only with a null base hash', async () => {
    const note = await createNote()
    await app.post(api.noteDelete.href(), { id: note.id })
    expect((await app.post(api.noteSave.href(), { id: note.id, body: 'x', baseHash: note.hash })).status).toBe(404)
    const copy = await app.post(api.noteSave.href(), { id: note.id, body: 'copy\n', baseHash: null })
    expect(copy.status).toBe(200)
    expect((await app.post(api.noteSave.href(), { id: note.id, body: 'x', baseHash: null })).status).toBe(409)
  })

  it('keeps frontmatter it sent back unchanged, byte for byte', async () => {
    await writeFile(path.join(vault.root, 'n.md'), "---\ntitle: 'Quoted'   # comment\nweird: .nan\n---\nBody\n")
    await vault.refresh()
    const note = await readJson<NoteDocument>(await app.get(`${api.noteRead.href()}?id=n.md`))
    const response = await app.post(api.noteSave.href(), {
      id: 'n.md',
      body: 'Body\n',
      baseHash: note.hash,
      frontmatter: { ...note.frontmatter, starred: true },
    })
    expect(response.status).toBe(200)
    const raw = await readFile(path.join(vault.root, 'n.md'), 'utf8')
    expect(raw).toContain("title: 'Quoted'   # comment\nweird: .nan\n")
    expect(raw).toContain('starred: true')
  })

  it('creates, renames, moves, deletes and restores notes', async () => {
    await app.post(api.folderCreate.href(), { parent: '', name: 'Work' })
    const note = await createNote()
    const renamed = await readJson<NoteDocument>(await app.post(api.noteRename.href(), { id: note.id, name: 'plan' }))
    expect(renamed.id).toBe('plan.md')
    const moved = await readJson<NoteDocument>(await app.post(api.noteMove.href(), { id: 'plan.md', folder: 'Work' }))
    expect(moved.id).toBe('Work/plan.md')

    expect((await app.post(api.noteDelete.href(), { id: 'Work/plan.md' })).status).toBe(200)
    let workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.notes).toEqual([])
    expect(workspace.trash).toMatchObject([{ kind: 'note', originalPath: 'Work/plan.md' }])

    const trashId = workspace.trash[0]?.id
    const restored = await readJson<{ id: string }>(await app.post(api.trashRestore.href(), { id: trashId }))
    expect(restored.id).toBe('Work/plan.md')
    workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.notes.map((item) => item.id)).toEqual(['Work/plan.md'])
    expect(workspace.trash).toEqual([])
  })

  it('manages folders: create, colour, rename, move, delete, empty trash', async () => {
    await app.post(api.folderCreate.href(), { parent: '', name: 'A' })
    await app.post(api.folderCreate.href(), { parent: '', name: 'B' })
    expect((await app.post(api.folderColor.href(), { id: 'A', color: '#E10051' })).status).toBe(200)
    expect((await app.post(api.folderColor.href(), { id: 'A', color: 'red;}' })).status).toBe(400)
    expect(await readJson(await app.post(api.folderRename.href(), { id: 'A', name: 'Alpha' }))).toEqual({ id: 'Alpha' })
    expect(await readJson(await app.post(api.folderMove.href(), { id: 'Alpha', parent: 'B' }))).toEqual({
      id: 'B/Alpha',
    })
    let workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.tree?.folders).toMatchObject([{ id: 'B', folders: [{ id: 'B/Alpha', color: '#E10051' }] }])

    await app.post(api.folderDelete.href(), { id: 'B' })
    workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.tree?.folders).toEqual([])
    expect(workspace.trash).toMatchObject([{ kind: 'folder', originalPath: 'B' }])
    await app.post(api.trashEmpty.href())
    workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.trash).toEqual([])
  })

  it('searches the vault index', async () => {
    await vault.createNote('', 'Mermaid diagrams', { body: '# Mermaid diagrams\n\nflowchart\n' })
    await vault.createNote('', 'Groceries', { body: '# Groceries\n\nmilk\n' })
    const { ids } = await readJson<{ ids: string[] }>(await app.get(`${api.search.href()}?q=flowchart`))
    expect(ids).toEqual(['Mermaid diagrams.md'])
  })

  it('reveals a note in the file manager, after validating its id', async () => {
    const note = await createNote()
    expect((await app.post(api.noteReveal.href(), { id: note.id })).status).toBe(200)
    expect(app.revealed).toEqual([path.join(vault.root, note.id)])
    expect((await app.post(api.noteReveal.href(), { id: '../x.md' })).status).toBe(400)
    expect(app.revealed).toHaveLength(1)
  })

  it('plans title renames on GET and applies them on POST', async () => {
    await mkdir(path.join(vault.root, 'Work'))
    await writeFile(path.join(vault.root, 'Work/meeting-notes.md'), '# Meeting notes\n')
    await writeFile(path.join(vault.root, 'Work/Craig.md'), '# 2026-09-18\n')
    await writeFile(path.join(vault.root, 'index.md'), '[m](./Work/meeting-notes.md)\n')
    await vault.refresh()

    const plan = await readJson<TitleRenamePlan>(await app.get(api.titleRenamesPlan.href()))
    expect(plan.renames).toEqual([
      { from: 'Work/meeting-notes.md', to: 'Work/Meeting notes.md', title: 'Meeting notes' },
    ])
    expect(plan.skipped.map((skip) => skip.id)).toEqual(['Work/Craig.md'])
    // The dry run wrote nothing.
    expect(await readFile(path.join(vault.root, 'Work/meeting-notes.md'), 'utf8')).toBe('# Meeting notes\n')

    const response = await app.post(api.titleRenamesApply.href(), { renames: plan.renames })
    expect(response.status).toBe(200)
    const report = await readJson<TitleRenameReport>(response)
    expect(report).toMatchObject({ renamed: plan.renames, skipped: [], linksRewritten: 1, notesUpdated: 1 })
    expect(await readFile(path.join(vault.root, 'index.md'), 'utf8')).toBe('[m](./Work/Meeting%20notes.md)\n')
    const workspace = await readJson<WorkspaceData>(await app.get(api.workspace.href()))
    expect(workspace.notes.map((note) => note.title).sort()).toEqual(['Craig', 'Meeting notes', 'index'])

    expect((await app.post(api.titleRenamesApply.href(), { renames: 'all' })).status).toBe(400)
    expect((await app.post(api.titleRenamesApply.href(), { renames: [{ from: 'x.md' }] })).status).toBe(400)
  })

  it('plans link updates after a rename without writing, and applies them on request', async () => {
    await writeFile(path.join(vault.root, 'target.md'), '# Target\n')
    await writeFile(path.join(vault.root, 'linker.md'), '[t](./target.md#x)\n')
    await vault.refresh()
    await app.post(api.noteRename.href(), { id: 'target.md', name: 'New name' })
    const moves = [{ from: 'target.md', to: 'New name.md', kind: 'note' }]

    const plan = await readJson<LinkUpdateReport>(await app.post(api.linksPlan.href(), { moves }))
    expect(plan).toEqual({ notes: [{ id: 'linker.md', title: 'linker', links: 1 }], total: 1 })
    expect(await readFile(path.join(vault.root, 'linker.md'), 'utf8')).toBe('[t](./target.md#x)\n')

    const applied = await readJson<LinkUpdateReport>(await app.post(api.linksApply.href(), { moves }))
    expect(applied).toEqual(plan)
    expect(await readFile(path.join(vault.root, 'linker.md'), 'utf8')).toBe('[t](./New%20name.md#x)\n')
  })

  it('validates link update moves', async () => {
    const invalid = [
      {},
      { moves: 'all' },
      { moves: [] },
      { moves: [{ from: 'a.md', to: 'b.md' }] },
      { moves: [{ from: 'a.md', to: 'b.md', kind: 'file' }] },
      { moves: [{ from: 'a.md', kind: 'note' }] },
      { moves: [null] },
    ]
    for (const body of invalid) {
      const response = await app.post(api.linksPlan.href(), body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'BAD_REQUEST' })
    }
    const traversal = await app.post(api.linksApply.href(), {
      moves: [{ from: '../outside.md', to: 'b.md', kind: 'note' }],
    })
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toMatchObject({ error: 'INVALID_PATH' })
    const root = await app.post(api.linksPlan.href(), { moves: [{ from: '', to: 'x', kind: 'folder' }] })
    expect(root.status).toBe(400)
  })
})

describe('assets', () => {
  let vault: Vault

  beforeEach(async () => {
    vault = await app.openVault()
    await vault.createNote('', 'note')
  })

  it('uploads an asset next to the note and serves it with its content type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const upload = await app.router.fetch(
      new Request(new URL(`${api.assetUpload.href()}?note=note.md&ext=png`, 'http://app'), {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      }),
    )
    expect(upload.status).toBe(201)
    const { href } = await readJson<{ href: string }>(upload)
    expect(href).toMatch(/^\.\/note\.assets\/[0-9a-f]{12}\.png$/)

    const response = await app.get(`${routes.vaultAssets.href({ path: 'note.md' })}?src=${encodeURIComponent(href)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
  })

  it('rejects asset paths that leave the vault', async () => {
    const outside = path.join(app.dir, 'secret.txt')
    await writeFile(outside, 'TOP-SECRET-CONTENT')
    await mkdir(path.join(vault.root, 'note.assets'), { recursive: true })
    await symlink(outside, path.join(vault.root, 'note.assets', 'link.txt'))
    await writeFile(path.join(vault.root, '.boostnote-private.txt'), 'hidden')

    for (const src of [
      '../secret.txt',
      '../../secret.txt',
      '%2e%2e/secret.txt',
      './note.assets/../../secret.txt',
      outside,
      'file:///etc/passwd',
      './note.assets/link.txt',
      './.boostnote-private.txt',
      './.boostnote/config.json',
    ]) {
      const response = await app.get(`${routes.vaultAssets.href({ path: 'note.md' })}?src=${encodeURIComponent(src)}`)
      expect(response.status, src).toBe(400)
      expect(await response.text(), src).not.toContain('TOP-SECRET-CONTENT')
    }
    // Traversal in the note id itself.
    const viaId = await app.get(`/vault-assets/..%2F..%2Fx.md?src=${encodeURIComponent('./secret.txt')}`)
    expect([400, 404]).toContain(viaId.status)
    expect((await app.get(`${routes.vaultAssets.href({ path: 'note.md' })}?src=missing.png`)).status).toBe(404)
  })
})

describe('vaults', () => {
  it('opens a folder picked in the dialog and remembers it', async () => {
    const root = path.join(app.dir, 'picked')
    await mkdir(root)
    app.picks.push(root)
    const response = await app.post(api.vaultPick.href())
    const result = await readJson<{ cancelled: boolean; workspace: WorkspaceData }>(response)
    expect(result.cancelled).toBe(false)
    expect(result.workspace.vault?.name).toBe('picked')
    expect(app.settings.read()).toMatchObject({ lastVault: app.vaults.current?.root })

    app.picks.push(undefined)
    expect(await readJson(await app.post(api.vaultPick.href()))).toEqual({ cancelled: true })

    const closed = await readJson<WorkspaceData>(await app.post(api.vaultClose.href()))
    expect(closed.vault).toBeNull()
    expect(closed.recent.map((item) => item.name)).toEqual(['picked'])
    expect((await app.post(api.vaultOpen.href(), { path: path.join(app.dir, 'missing') })).status).toBe(400)
  })

  it('opens only http(s) links externally', async () => {
    expect((await app.post(api.openExternal.href(), { url: 'https://example.com/a' })).status).toBe(200)
    expect((await app.post(api.openExternal.href(), { url: 'file:///etc/passwd' })).status).toBe(400)
    expect((await app.post(api.openExternal.href(), { url: 'javascript:alert(1)' })).status).toBe(400)
    expect(app.opened).toEqual(['https://example.com/a'])
  })
})

describe('reader', () => {
  /** Opens `<dir>/outside/<name>` from the OS and takes the request as the page does. */
  async function openOutside(name: string, text: string): Promise<{ file: string; ticket: string }> {
    const file = path.join(app.dir, 'outside', name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    app.vaults.requestOpen(file)
    const request = await readJson<OpenRequest | null>(await app.post(api.openRequest.href()))
    if (request?.kind !== 'external') throw new Error(`Expected an external request, got ${JSON.stringify(request)}`)
    expect(request.name).toBe(name)
    return { file, ticket: request.ticket }
  }

  it('reads an outside file through its ticket, fresh each time, naming only its base name', async () => {
    const { file, ticket } = await openOutside('readme.md', '---\ntags: [a]\n---\n# Readme\n\n<script>x()</script>\n')
    const first = await app.get(api.readerRead.href({ ticket }))
    expect(first.status).toBe(200)
    const text = await first.text()
    expect(JSON.parse(text)).toEqual({
      name: 'readme.md',
      body: '# Readme\n\n<script>x()</script>\n',
      frontmatter: { tags: ['a'] },
      // Rendered and sanitised like an export: the script is gone.
      html: '<h1 id="readme">Readme</h1>\n\n',
    })
    expect(text).not.toContain(app.dir)

    await writeFile(file, 'Changed\n')
    expect(await readJson(await app.get(api.readerRead.href({ ticket })))).toEqual({
      name: 'readme.md',
      body: 'Changed\n',
      frontmatter: {},
      html: '<p>Changed</p>\n',
    })
    // No vault was opened for it.
    expect(app.vaults.current).toBeUndefined()
    expect(app.settings.read()).toEqual({})
  })

  it('refuses a ticket after its reader closed, unknown tickets, and a file that is gone', async () => {
    const { ticket } = await openOutside('a.md', '# A\n')
    const gone = await openOutside('b.md', '# B\n')
    const closed = await app.post(api.readerClose.href({ ticket }))
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual({ ok: true })
    const after = await app.get(api.readerRead.href({ ticket }))
    expect(after.status).toBe(404)
    expect(await after.text()).not.toContain(app.dir)
    expect((await app.get(api.readerRead.href({ ticket: 'made-up' }))).status).toBe(404)
    expect((await app.post(api.readerClose.href({ ticket }))).status).toBe(404)
    expect((await app.post(api.readerClose.href({ ticket: 'made-up' }))).status).toBe(404)

    await rm(gone.file)
    const missing = await app.get(api.readerRead.href({ ticket: gone.ticket }))
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain(app.dir)
  })
})

describe('drop import', () => {
  it('copies dropped files into the folder and answers with the report', async () => {
    const vault = await app.openVault()
    await vault.createFolder('', 'work')
    const loose = path.join(app.dir, 'loose')
    await mkdir(loose)
    await writeFile(path.join(loose, 'pic.png'), 'PNG')
    await writeFile(path.join(loose, 'Dropped.md'), '![p](pic.png)\n')
    const ticket = app.drops.grant([path.join(loose, 'Dropped.md')])
    const response = await app.post(api.importFiles.href(), { ticket, folder: 'work' })
    expect(response.status).toBe(201)
    const report = await readJson<ImportFilesReport>(response)
    expect(report).toMatchObject({ folder: 'work', notes: [{ id: 'work/Dropped.md' }], assets: 1, links: 1 })
    expect(await readFile(path.join(vault.root, 'work', 'Dropped.md'), 'utf8')).toMatch(
      /^!\[p\]\(\.\/Dropped\.assets\//,
    )
    expect(await readFile(path.join(loose, 'Dropped.md'), 'utf8')).toBe('![p](pic.png)\n')
  })

  it('accepts only one-time tickets main granted, never paths named by the page', async () => {
    await app.openVault()
    const loose = path.join(app.dir, 'a.md')
    await writeFile(loose, '# A\n')
    const post = (body: unknown) => app.post(api.importFiles.href(), body)
    // A page that names paths itself gets nothing.
    const named = await post({ paths: [loose], folder: '' })
    expect(named.status).toBe(400)
    expect((await post({ ticket: 'made-up', folder: '' })).status).toBe(403)
    // A real ticket works once.
    const ticket = app.drops.grant([loose])
    expect((await post({ ticket, folder: '' })).status).toBe(201)
    expect((await post({ ticket, folder: '' })).status).toBe(403)
  })

  it('checks the granted paths before touching the vault', async () => {
    await app.openVault()
    const loose = path.join(app.dir, 'a.md')
    await writeFile(loose, 'a')
    const post = (paths: string[], folder: unknown = '') =>
      app.post(api.importFiles.href(), { ticket: app.drops.grant(paths), folder })
    const relative = await post(['a.md'])
    expect(relative.status).toBe(400)
    expect(await relative.json()).toMatchObject({ error: 'BAD_REQUEST' })
    expect((await post([path.join(app.dir, 'missing.md')])).status).toBe(404)
    expect((await post([])).status).toBe(400)
    expect((await post([loose], null)).status).toBe(400)
    expect((await post(Array.from({ length: MAX_IMPORT_PATHS + 1 }, () => loose))).status).toBe(413)
    expect((await post([loose], '../out')).status).toBe(400)
    expect(app.vaults.current?.index.all()).toEqual([])
  })

  it('needs an open vault', async () => {
    const response = await app.post(api.importFiles.href(), { ticket: app.drops.grant([app.dir]), folder: '' })
    expect(response.status).toBe(409)
  })
})

describe('import', () => {
  it('previews (dry run) without writing, then imports and reports', async () => {
    const source = path.join(app.dir, 'legacy')
    const target = path.join(app.dir, 'imported')
    await createLegacyStorage(source)
    app.legacyStorages.push({ path: source, name: 'My storage' })
    expect(await readJson(await app.get(api.importCandidates.href()))).toEqual([{ path: source, name: 'My storage' }])

    const preview = await readJson<ImportSummary>(
      await app.post(api.importRun.href(), { source, target, dryRun: true }),
    )
    expect(preview.dryRun).toBe(true)
    expect(preview.counts.notes).toBeGreaterThan(0)
    await expect(readFile(path.join(target, '.boostnote', 'migration-report.json'))).rejects.toThrow()

    const run = await readJson<ImportSummary>(await app.post(api.importRun.href(), { source, target }))
    expect(run.dryRun).toBe(false)
    expect(run.counts).toEqual(preview.counts)
    expect(run.reportPath).toBe(path.join(run.target, '.boostnote', 'migration-report.json'))
    expect(JSON.parse(await readFile(run.reportPath ?? '', 'utf8'))).toMatchObject({ dryRun: false })

    // The target is no longer empty.
    const again = await app.post(api.importRun.href(), { source, target })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'TARGET_NOT_EMPTY' })

    const opened = await readJson<{ workspace: WorkspaceData }>(await app.post(api.vaultOpen.href(), { path: target }))
    expect(opened.workspace.notes.length).toBe(run.counts.notes - run.counts.trashedNotes)
  })

  it('rejects a folder that is not a legacy storage', async () => {
    const response = await app.post(api.importRun.href(), {
      source: (await app.openVault('not-a-storage')).root,
      target: path.join(app.dir, 'x'),
      dryRun: true,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'NOT_A_LEGACY_STORAGE' })
  })

  it('picks the source and target folders with the native dialog', async () => {
    app.picks.push('/some/storage', undefined)
    expect(await readJson(await app.post(api.importPick.href(), { purpose: 'source' }))).toEqual({
      path: '/some/storage',
    })
    expect(await readJson(await app.post(api.importPick.href(), { purpose: 'target' }))).toEqual({ path: null })
    expect(app.pickerCalls.map((call) => call.createDirectory ?? false)).toEqual([false, true])
  })
})
