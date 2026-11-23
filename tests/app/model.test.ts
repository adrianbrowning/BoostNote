import { mkdir, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import type { TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { origin, TestApp } from './helpers.ts'

/**
 * `WorkspaceModel` over the in-process router (`createClient` over `TestApp.fetch`) and a memory tab store:
 * the model's own actions (vault switches, `attempt` and its error notice, operations that change the open
 * note after a request) without a page.
 */

const QUOTA = 'The quota has been exceeded.'

let app: TestApp
/** Note ids whose reads answer `404`, as if deleted on disk after the vault listed them. */
let gone: Set<string>
/** Requests to this API path wait in `held` until the test calls the stored release (`null`: none waits). */
let holdPath: string | null
let held: Array<() => void>
/** Tab snapshots by vault root; `save` throws like `localStorage.setItem` over its quota. */
let snapshots: Map<string, TabsSnapshot>
let model: WorkspaceModel

const store: TabStore = {
  load: (root) => snapshots.get(root) ?? null,
  save: () => {
    throw new DOMException(QUOTA, 'QuotaExceededError')
  },
}

const api = createClient(async (href, init) => {
  const url = new URL(href, origin)
  if (url.pathname === '/api/notes/read' && gone.has(url.searchParams.get('id') ?? '')) {
    return Response.json({ error: 'NOT_FOUND', message: 'Note not found' }, { status: 404 })
  }
  if (url.pathname === holdPath) {
    const { promise, resolve } = Promise.withResolvers<void>()
    held.push(resolve)
    await promise
  }
  return app.fetch(href, init)
})

/** Writes `files` into a new folder `name` of the test app's temp dir. */
async function folderWith(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(app.dir, name)
  for (const [id, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, id)), { recursive: true })
    await writeFile(path.join(dir, id), body)
  }
  return dir
}

beforeEach(async () => {
  app = await TestApp.create()
  gone = new Set()
  holdPath = null
  held = []
  snapshots = new Map()
  await folderWith('vault', {
    'in first.md': '# In first\n',
    'meeting.md': '# Meeting notes\n',
    'f/n.md': '# N\n',
    'g/x.md': '# X\n',
  })
  await app.openVault('vault')
  model = new WorkspaceModel(
    await api.workspace(),
    { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
    { api, store },
  )
})

afterEach(async () => {
  model.session.close()
  await app.close()
})

describe('WorkspaceModel vault switches', () => {
  /**
   * A second vault whose saved active tab names a note that reads as gone: restoring its tabs closes that
   * tab and saves the tabs, and the store's save throws.
   */
  async function secondVaultWhoseRestoreFails(): Promise<string> {
    // Vault roots are real paths (the temp dir can sit behind a symlink); the tab store is keyed by them.
    const second = await realpath(await folderWith('second', { 'in second.md': '# In second\n' }))
    snapshots.set(second, { tabs: ['in second.md'], active: 0, closed: [] })
    gone.add('in second.md')
    return second
  }

  it('openVault awaits the tab restore: its failure is the error notice once the call resolves', async () => {
    const second = await secondVaultWhoseRestoreFails()
    await model.openVault(second)
    expect(model.data.vault?.root).toBe(second)
    expect(model.notice).toEqual({ kind: 'error', text: QUOTA })
  })

  it('pickVault awaits the tab restore: its failure is the error notice once the call resolves', async () => {
    const second = await secondVaultWhoseRestoreFails()
    app.picks.push(second)
    await model.pickVault()
    expect(model.data.vault?.root).toBe(second)
    expect(model.notice).toEqual({ kind: 'error', text: QUOTA })
  })
})

describe('WorkspaceModel operations that change the open note after a request', () => {
  let workspace: WorkspaceModel

  beforeEach(async () => {
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
      { api, store: { load: () => null, save: () => {} } },
    )
  })

  afterEach(() => {
    workspace.session.close()
  })

  it.each([
    {
      what: 'title renames run (it is then read again)',
      open: 'meeting.md',
      request: '/api/notes/title-renames/apply',
      run: () => workspace.applyTitleRenames([{ from: 'meeting.md', to: 'Meeting notes.md', title: 'Meeting notes' }]),
      after: 'Meeting notes.md',
    },
    {
      what: 'it is renamed',
      open: 'in first.md',
      request: '/api/notes/rename',
      run: () => workspace.renameOpenNote('renamed'),
      after: 'renamed.md',
    },
    {
      what: 'it is moved',
      open: 'in first.md',
      request: '/api/notes/move',
      run: () => workspace.moveNote('in first.md', 'g'),
      after: 'g/in first.md',
    },
    {
      what: 'its folder is moved',
      open: 'f/n.md',
      request: '/api/folders/move',
      run: () => workspace.moveFolder('f', 'g'),
      after: 'g/f/n.md',
    },
  ])(
    'takes no edits to the open note while $what, and takes them again after',
    async ({ open, request, run, after }) => {
      await workspace.openNote(open)
      const body = workspace.session.body
      holdPath = request
      const done = run()
      await expect.poll(() => held.length).toBe(1)
      // The note is replaced or moved once the request returns: what is typed meanwhile is refused (read-only editor).
      expect(workspace.session.locked).toBe(true)
      workspace.session.edit(`${body}\nTyped meanwhile.\n`)
      expect(workspace.session.body).toBe(body)
      held[0]?.()
      await done
      expect(workspace.session.note?.id).toBe(after)
      expect(workspace.session.locked).toBe(false)
      expect(workspace.notice?.kind).not.toBe('error')
      workspace.session.edit(`${body}\nTyped after.\n`)
      expect(workspace.session.state).toBe('dirty')
    },
  )

  it.each([
    {
      what: 'title renames',
      open: 'meeting.md',
      run: () => workspace.applyTitleRenames([{ from: 'meeting.md', to: 'Meeting notes.md', title: 'Meeting notes' }]),
    },
    { what: 'a move of its folder', open: 'f/n.md', run: () => workspace.moveFolder('f', 'g') },
  ])('drops its read of the open note after $what once another note was opened meanwhile', async ({ open, run }) => {
    await workspace.openNote(open)
    // The request goes through; the read of the open note that follows it waits (held[0]).
    holdPath = '/api/notes/read'
    const done = run()
    await expect.poll(() => held.length).toBe(1)
    const toOther = workspace.openNote('in first.md')
    await expect.poll(() => held.length).toBe(2)
    held[1]?.()
    await toOther
    held[0]?.()
    await done
    expect(workspace.session.note).toMatchObject({ id: 'in first.md', body: '# In first\n' })
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'in first.md' })
    expect(workspace.session.locked).toBe(false)
  })
})
