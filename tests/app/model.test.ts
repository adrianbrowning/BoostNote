import { readFile, realpath, rm } from 'node:fs/promises'
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

  it('lists no made-up note when the open note cannot be read again, nor the lists refreshed, after its folder moved', async () => {
    await workspace.openNote('f/n.md')
    const listed = workspace.data.notes.map((note) => note.id)
    net.fail = (url) => url.pathname === '/api/notes/read' || url.pathname === '/api/workspace'
    await workspace.moveFolder('f', 'g')
    net.fail = null
    expect(workspace.notice).toEqual({ kind: 'error', text: 'Could not refresh: Disk full' })
    expect(workspace.session.note?.id).toBe('g/f/n.md')
    // The lists stay as last read (the refresh failed): nothing is added for the note's new place.
    expect(workspace.data.notes.map((note) => note.id)).toEqual(listed)
  })

  it('keeps the lists and tabs of a later relocation when an earlier one’s list refresh returns after it', async () => {
    await workspace.openNote('meeting.md')
    await workspace.openNote('f/n.md', { newTab: true })
    await workspace.openNote('g/x.md', { newTab: true })
    let first = true
    // The first move's lists are read at once (before the second move) and return late.
    net.hold(
      (url) => {
        if (url.pathname !== '/api/workspace' || !first) return undefined
        first = false
        return 'refresh'
      },
      { answered: true },
    )
    const one = workspace.moveNote('meeting.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    // The second move's link question waits its turn behind the first's: its lists show before that.
    const two = workspace.moveNote('f/n.md', 'g')
    await expect.poll(() => workspace.data.notes.some((note) => note.id === 'g/n.md')).toBe(true)
    net.held[0]?.release()
    await Promise.all([one, two])
    const ids = workspace.data.notes.map((note) => note.id)
    expect(ids).toContain('g/n.md')
    expect(ids).not.toContain('f/n.md')
    expect(workspace.tabs.tabs.map((tab) => tab.kind === 'note' && tab.path)).toEqual([
      'g/meeting.md',
      'g/n.md',
      'g/x.md',
    ])
  })

  it('shows an earlier relocation’s lists when a later refresh fails before they return', async () => {
    let first = true
    net.hold(
      (url) => {
        if (url.pathname !== '/api/workspace' || !first) return undefined
        first = false
        return 'refresh'
      },
      { answered: true },
    )
    const moving = workspace.moveNote('meeting.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    net.fail = (url) => url.pathname === '/api/workspace'
    await expect(workspace.refresh()).rejects.toThrow('Disk full')
    net.fail = null
    net.held[0]?.release()
    await moving
    const ids = workspace.data.notes.map((note) => note.id)
    expect(ids).toContain('g/meeting.md')
    expect(ids).not.toContain('meeting.md')
  })

  it('keeps a reader file added to the vault, and its tab, when a refresh started before the import returns after it', async () => {
    const outside = path.join(await folderWith(app, 'outside', { 'outside.md': '# Outside\n' }), 'outside.md')
    const ticket = await app.vaults.readers.grant(await realpath(outside))
    if (ticket === undefined) throw new Error('No reader ticket for outside.md')
    await workspace.navigation.openReader(ticket, 'outside.md')
    const key = workspace.tabs.active?.key
    if (key === undefined) throw new Error('No reader tab')
    net.hold(onPath('/api/workspace'), { answered: true })
    const refreshing = workspace.refresh()
    await expect.poll(() => net.held.length).toBe(1)
    net.hold(null)
    const adding = workspace.addReaderToVault(key)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind === 'choose') dialog.resolve('')
    await adding
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'outside.md' })
    net.held[0]?.release()
    await refreshing
    expect(workspace.data.notes.map((note) => note.id)).toContain('outside.md')
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'outside.md' })
  })

  it('keeps the selected folder and the expanded folders, at their new place, when a folder moves', async () => {
    await api.createFolder('f', 's')
    await workspace.refresh()
    workspace.select({ kind: 'folder', id: 'f' })
    workspace.expanded.add('f')
    workspace.expanded.add('f/s')
    await workspace.moveFolder('f', 'g')
    expect(workspace.selection).toEqual({ kind: 'folder', id: 'g/f' })
    expect([...workspace.expanded].sort()).toEqual(['g/f', 'g/f/s'])
  })

  it('shows why an image could not be saved into the open note as an error notice, and still refuses it', async () => {
    await workspace.openNote('meeting.md')
    await rm(path.join(app.dir, 'vault', 'meeting.md'))
    workspace.session.externalRemoval()
    const image = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' })
    const text = 'Save your copy of the note first, then add the image'
    await expect(workspace.saveAsset(image)).rejects.toThrow(text)
    expect(workspace.notice).toEqual({ kind: 'error', text })
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

  it('drops a list refresh of the vault left that returns once another vault shows', async () => {
    const other = await realpath(await folderWith(app, 'other', { 'only here.md': '# Only here\n' }))
    saved.set(other, { tabs: ['only here.md'], active: 0, closed: [] })
    net.hold(onPath('/api/workspace'))
    const refreshing = workspace.refresh()
    await expect.poll(() => net.held.length).toBe(1)
    net.hold(null)
    await workspace.openVault(other)
    net.held[0]?.release()
    await refreshing
    expect(workspace.data.vault?.root).toBe(other)
    expect(workspace.data.notes.map((note) => note.id)).toEqual(['only here.md'])
    expect(workspace.tabs.tabs).toMatchObject([{ kind: 'note', path: 'only here.md' }])
  })
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

  const folderPrompt = () =>
    workspace.prompt({ title: 'New folder', label: 'Folder name', value: '', confirm: 'Create' })

  /** Answers the dialog showing: a prompt with `value`, a links question with `ok`. */
  function answer(value: string | null, ok = false): void {
    const dialog = workspace.dialog
    if (dialog?.kind === 'prompt') dialog.resolve(value)
    else if (dialog?.kind === 'links') dialog.resolve(ok)
    else throw new Error(`No prompt or question shows: ${dialog?.kind}`)
  }

  it('parks an Update links? question that comes while another dialog is open, and asks it once that one closes', async () => {
    const naming = folderPrompt()
    let named = false
    void naming.then(() => {
      named = true
    })
    // A context menu open over the prompt: a dialog that comes (the question) closes it.
    workspace.openMenu(0, 0, [])
    const moving = workspace.moveNote('a.md', 'g')
    await expect.poll(() => workspace.menu).toBeNull()
    expect(workspace.dialog?.kind).toBe('prompt')
    expect(named).toBe(false)
    answer('x')
    expect(await naming).toBe('x')
    expect(workspace.dialog).toMatchObject({ kind: 'links', message: '1 link in 1 note points to “a”.' })
    answer(null, true)
    await moving
    expect(workspace.dialog).toBeNull()
    expect(await readFile(path.join(app.dir, 'links', 'linker.md'), 'utf8')).toBe('# L\n\n[a](./g/a.md)\n')
  })

  it('asks an Update links? question again once two dialogs opened over it, one after the other, closed', async () => {
    const moving = workspace.moveNote('a.md', 'g')
    await expect.poll(() => workspace.dialog?.kind).toBe('links')
    const first = folderPrompt()
    const second = folderPrompt()
    // The second prompt cancels the first; the question stays parked under it.
    expect(await first).toBeNull()
    expect(workspace.dialog?.kind).toBe('prompt')
    answer(null)
    expect(await second).toBeNull()
    expect(workspace.dialog).toMatchObject({ kind: 'links', message: '1 link in 1 note points to “a”.' })
    answer(null, true)
    await moving
    expect(await readFile(path.join(app.dir, 'links', 'linker.md'), 'utf8')).toBe('# L\n\n[a](./g/a.md)\n')
    // The questions after it are still asked.
    const back = workspace.moveNote('g/a.md', '')
    await expect.poll(() => workspace.dialog?.kind).toBe('links')
    answer(null, false)
    await back
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

  it.each([
    { what: 'showing', over: false },
    { what: 'parked under a prompt', over: true },
  ])(
    'closes an Update links? question $what when another vault shows, and the relocation settles',
    async ({ over }) => {
      const other = await realpath(await folderWith(app, 'other', { 'b.md': '# B\n' }))
      const moving = workspace.moveNote('a.md', 'g')
      await expect.poll(() => workspace.dialog?.kind).toBe('links')
      const naming = over
        ? workspace.prompt({ title: 'New folder', label: 'Folder name', value: '', confirm: 'Create' })
        : undefined
      await workspace.openVault(other)
      expect(workspace.data.vault?.root).toBe(other)
      await moving
      // A prompt over the question stays: only the vault left's question goes.
      expect(workspace.dialog?.kind).toBe(over ? 'prompt' : undefined)
      const prompt = workspace.dialog
      if (prompt?.kind === 'prompt') prompt.resolve(null)
      if (naming) expect(await naming).toBeNull()
      expect(workspace.dialog).toBeNull()
      expect(await readFile(path.join(app.dir, 'links', 'linker.md'), 'utf8')).toBe('# L\n\n[a](./a.md)\n')
    },
  )
})
