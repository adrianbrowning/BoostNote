import { readFile, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import type { TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { folderWith, type HeldClient, heldClient, TestApp } from './helpers.ts'

/**
 * `WorkspaceModel` over the in-process router (`createClient` over `TestApp.fetch`) and a memory tab store:
 * the model's own actions (vault switches, `attempt` and its error notice, operations that change the open
 * note after a request) without a page.
 */

const QUOTA = 'The quota has been exceeded.'

let app: TestApp
/** Holds the requests of `api` and answers reads of its `gone` notes with `404` (`heldClient`). */
let net: HeldClient
let api: Client
/** Tab snapshots by vault root; `save` throws like `localStorage.setItem` over its quota. */
let snapshots: Map<string, TabsSnapshot>

const store: TabStore = {
  load: (root) => snapshots.get(root) ?? null,
  save: () => {
    throw new DOMException(QUOTA, 'QuotaExceededError')
  },
}

/** Holds the requests to API path `pathname` (by that path). */
const onPath = (pathname: string) => (url: URL) => (url.pathname === pathname ? pathname : undefined)

beforeEach(async () => {
  app = await TestApp.create()
  net = heldClient(app)
  api = net.client
  snapshots = new Map()
  await folderWith(app, 'vault', {
    'in first.md': '# In first\n',
    'meeting.md': '# Meeting notes\n',
    'f/n.md': '# N\n',
    'g/x.md': '# X\n',
  })
  await app.openVault('vault')
})

afterEach(async () => {
  await app.close()
})

describe('WorkspaceModel vault switches', () => {
  let model: WorkspaceModel

  beforeEach(async () => {
    model = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
      { api, store },
    )
  })

  afterEach(() => {
    model.session.close()
  })

  /**
   * A second vault whose saved active tab names a note that reads as gone: restoring its tabs closes that
   * tab and saves the tabs, and the store's save throws.
   */
  async function secondVaultWhoseRestoreFails(): Promise<string> {
    // Vault roots are real paths (the temp dir can sit behind a symlink); the tab store is keyed by them.
    const second = await realpath(await folderWith(app, 'second', { 'in second.md': '# In second\n' }))
    snapshots.set(second, { tabs: ['in second.md'], active: 0, closed: [] })
    net.gone.add('in second.md')
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
      net.hold(onPath(request))
      const held = net.held
      const done = run()
      await expect.poll(() => held.length).toBe(1)
      // The note is replaced or moved once the request returns: what is typed meanwhile is refused (read-only editor).
      expect(workspace.session.locked).toBe(true)
      workspace.session.edit(`${body}\nTyped meanwhile.\n`)
      expect(workspace.session.body).toBe(body)
      held[0]?.release()
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
    net.hold(onPath('/api/notes/read'))
    const held = net.held
    const done = run()
    await expect.poll(() => held.length).toBe(1)
    const toOther = workspace.openNote('in first.md')
    await expect.poll(() => held.length).toBe(2)
    held[1]?.release()
    await toOther
    held[0]?.release()
    await done
    expect(workspace.session.note).toMatchObject({ id: 'in first.md', body: '# In first\n' })
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'in first.md' })
    expect(workspace.session.locked).toBe(false)
  })

  it('lists a new note that was created but not shown because another note was opened meanwhile', async () => {
    await workspace.openNote('meeting.md')
    net.hold(onPath('/api/notes/create'))
    const created = workspace.newNote('')
    await expect.poll(() => net.held.length).toBe(1)
    await workspace.openNote('in first.md')
    const before = workspace.data.notes.length
    net.held[0]?.release()
    await created
    expect(workspace.session.note?.id).toBe('in first.md')
    expect(workspace.data.notes).toHaveLength(before + 1)
  })
})

describe('WorkspaceModel relocations that return after a vault switch', () => {
  let workspace: WorkspaceModel
  let saved: Map<string, TabsSnapshot>

  beforeEach(async () => {
    saved = new Map()
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
      {
        api,
        store: {
          load: (root) => saved.get(root) ?? null,
          save: (root, snapshot) => {
            saved.set(root, structuredClone(snapshot))
          },
        },
      },
    )
  })

  afterEach(() => {
    workspace.session.close()
  })

  it.each([
    {
      what: 'rename',
      open: 'in first.md',
      request: '/api/notes/rename',
      run: () => workspace.renameOpenNote('renamed'),
    },
    {
      what: 'move',
      open: 'in first.md',
      request: '/api/notes/move',
      run: () => workspace.moveNote('in first.md', 'g'),
    },
    { what: 'folder move', open: 'f/n.md', request: '/api/folders/move', run: () => workspace.moveFolder('f', 'g') },
  ])(
    'leaves the tabs, stored tabs and open note of the vault switched to while a $what was out',
    async ({ open, request, run }) => {
      const other = await realpath(await folderWith(app, 'other', { [open]: '# Other\n' }))
      saved.set(other, { tabs: [open], active: 0, closed: [] })
      await workspace.openNote(open)
      net.hold(onPath(request))
      const done = run()
      await expect.poll(() => net.held.length).toBe(1)
      await workspace.openVault(other)
      expect(workspace.session.note?.id).toBe(open)
      net.held[0]?.release()
      await done
      expect(workspace.session.note).toMatchObject({ id: open, body: '# Other\n' })
      expect(workspace.tabs.tabs).toMatchObject([{ kind: 'note', path: open }])
      expect(saved.get(other)).toEqual({ tabs: [open], active: 0, closed: [] })
      expect(workspace.notice).toBeNull()
    },
  )
})

describe('WorkspaceModel link questions', () => {
  let workspace: WorkspaceModel

  beforeEach(async () => {
    await folderWith(app, 'links', { 'a.md': '# A\n', 'g/x.md': '# X\n', 'linker.md': '# L\n\n[a](./a.md)\n' })
    await app.openVault('links')
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
      { api, store: { load: () => null, save: () => {} } },
    )
  })

  afterEach(() => {
    workspace.session.close()
  })

  it('keeps an Update links? question that another dialog opened over, and asks it again once that one closes', async () => {
    const moving = workspace.moveNote('a.md', 'g')
    await expect.poll(() => workspace.dialog?.kind).toBe('links')
    // A menu command (File › New Folder…) opens its prompt while the question is open.
    const naming = workspace.prompt({ title: 'New folder', label: 'Folder name', value: '', confirm: 'Create' })
    const prompt = workspace.dialog
    expect(prompt?.kind).toBe('prompt')
    if (prompt?.kind === 'prompt') prompt.resolve(null)
    expect(await naming).toBeNull()
    const question = workspace.dialog
    expect(question).toMatchObject({ kind: 'links', message: '1 link in 1 note points to “a”.' })
    if (question?.kind === 'links') question.resolve(true)
    await moving
    expect(workspace.dialog).toBeNull()
    expect(await readFile(path.join(app.dir, 'links', 'linker.md'), 'utf8')).toBe('# L\n\n[a](./g/a.md)\n')
  })
})
