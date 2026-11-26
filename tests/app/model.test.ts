import { readdir, readFile, realpath, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import type { TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { exists, folderWith, type HeldClient, heldClient, noTabStore, TestApp } from './helpers.ts'

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
  loadScratch: () => null,
  saveScratch: () => {},
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
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
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
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: noTabStore },
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
    // The first move's lists are read at once (before the second move) and return late.
    net.hold(onPath('/api/workspace'), { answered: true, once: true })
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
    net.hold(onPath('/api/workspace'), { answered: true, once: true })
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

  it('refuses an image pasted into a scratch note with the images-need-a-vault-note notice, sending no upload', async () => {
    await workspace.newScratchNote()
    expect(workspace.session.scratch).not.toBeNull()
    const vaultFiles = (await readdir(path.join(app.dir, 'vault'), { recursive: true })).sort()
    const scratchFiles = (await readdir(app.scratchDir)).sort()
    net.hold((url) => (url.pathname === '/api/assets' ? 'upload' : undefined))
    const image = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' })
    const text = 'Images need a vault note: save this scratch note to the vault to add images.'
    await expect(workspace.saveAsset(image)).rejects.toThrow(text)
    expect(workspace.notice).toEqual({ kind: 'error', text })
    expect(net.held).toEqual([])
    expect((await readdir(path.join(app.dir, 'vault'), { recursive: true })).sort()).toEqual(vaultFiles)
    expect((await readdir(app.scratchDir)).sort()).toEqual(scratchFiles)
  })
})

describe('WorkspaceModel Save to vault of a scratch note', () => {
  let workspace: WorkspaceModel

  beforeEach(async () => {
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: noTabStore },
    )
  })

  afterEach(() => {
    workspace.session.close()
  })

  /** The strip: note tabs by path, other tabs by kind. */
  const strip = () => workspace.tabs.tabs.map((tab) => (tab.kind === 'note' ? tab.path : tab.kind))

  /** Opens meeting.md, then a scratch note after it and f/n.md after that; the scratch tab is active with `text` typed. */
  async function scratchBetweenNotes(text: string): Promise<{ id: string; key: number }> {
    await workspace.openNote('meeting.md')
    await workspace.newScratchNote()
    const key = workspace.tabs.activeKey
    const id = workspace.session.scratch?.id
    if (key === null || id === undefined) throw new Error('No scratch tab')
    await workspace.openNote('f/n.md', { newTab: true })
    await workspace.activateTab(key)
    workspace.session.edit(text)
    return { id, key }
  }

  /** Answers the open choose dialog with `folder`, once it shows; it offers `value` (the drop folder) first. */
  async function chooseFolder(folder: string, value = ''): Promise<void> {
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    expect(dialog).toMatchObject({
      title: 'Save to vault',
      label: 'Folder',
      options: workspace.folderOptions,
      value,
      confirm: 'Save',
    })
    dialog.resolve(folder)
  }

  it('offers the selected folder first in the folder dialog', async () => {
    const { id } = await scratchBetweenNotes('# Into f\n')
    workspace.select({ kind: 'folder', id: 'f' })
    const saving = workspace.saveScratchToVault(id)
    await chooseFolder('f', 'f')
    await saving
    expect(strip()).toEqual(['meeting.md', 'f/Into f.md', 'f/n.md'])
  })

  it('saves once when Save to vault is asked twice before the dialog is answered', async () => {
    const { id } = await scratchBetweenNotes('# Once\n')
    const first = workspace.saveScratchToVault(id)
    const second = workspace.saveScratchToVault(id)
    await chooseFolder('')
    await Promise.all([first, second])
    expect(workspace.dialog).toBeNull()
    expect((await readdir(path.join(app.dir, 'vault'))).filter((name) => name.startsWith('Once'))).toEqual(['Once.md'])
    expect(workspace.notice).toBeNull()
  })

  it('says why nothing was saved when the vault closed while the save waited for another one’s folder dialog', async () => {
    const { id } = await scratchBetweenNotes('# First\n')
    await workspace.newScratchNote()
    const other = workspace.session.scratch?.id ?? ''
    workspace.session.edit('# Second\n')
    const first = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const second = workspace.saveScratchToVault(other)
    await workspace.closeVault()
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('')
    await Promise.all([first, second])
    expect(workspace.data.vault).toBeNull()
    expect(workspace.dialog).toBeNull()
    expect(workspace.notice).toEqual({ kind: 'error', text: 'Open a vault first, then save the scratch note to it.' })
    expect((await readdir(app.scratchDir)).sort()).toEqual(
      [`${id}.json`, `${id}.md`, `${other}.json`, `${other}.md`].sort(),
    )
  })

  it('saves the typed text into the chosen folder; the scratch tab becomes the note’s active tab at its place', async () => {
    const { id } = await scratchBetweenNotes('# Groceries\n\nMilk\n')

    const saving = workspace.saveScratchToVault(id)
    await chooseFolder('f')
    await saving

    expect(strip()).toEqual(['meeting.md', 'f/Groceries.md', 'f/n.md'])
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'f/Groceries.md' })
    expect(workspace.session.scratch).toBeNull()
    expect(workspace.session.note?.id).toBe('f/Groceries.md')
    expect(workspace.session.body).toBe('# Groceries\n\nMilk\n')
    expect(workspace.data.notes.map((note) => note.id)).toContain('f/Groceries.md')
    expect(await readFile(path.join(app.dir, 'vault', 'f', 'Groceries.md'), 'utf8')).toMatch(
      /^---\ncreated: .+\nupdated: .+\n---\n# Groceries\n\nMilk\n$/,
    )
    expect(await readdir(app.scratchDir)).toEqual([])
    expect(workspace.notice).toBeNull()
  })

  it('turns the scratch tab into the note’s tab in the background when another tab was activated while it saved', async () => {
    const { id } = await scratchBetweenNotes('# Later\n')
    const meeting = workspace.tabs.tabs[0]?.key
    if (meeting === undefined) throw new Error('No meeting.md tab')
    net.hold(onPath('/api/scratch/save'))

    const saving = workspace.saveScratchToVault(id)
    await chooseFolder('')
    await expect.poll(() => net.held.length).toBe(1)
    await workspace.activateTab(meeting)
    net.held[0]?.release()
    await saving

    expect(strip()).toEqual(['meeting.md', 'Later.md', 'f/n.md'])
    expect(workspace.tabs.activeKey).toBe(meeting)
    expect(workspace.session.note?.id).toBe('meeting.md')
    expect(await readdir(app.scratchDir)).toEqual([])
  })

  it('keeps the scratch tab and its text, with the error notice, when the folder went away after it was chosen', async () => {
    const { id, key } = await scratchBetweenNotes('Keep me')

    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    await rm(path.join(app.dir, 'vault', 'g'), { recursive: true })
    await chooseFolder('g')
    await saving

    expect(strip()).toEqual(['meeting.md', 'scratch', 'f/n.md'])
    expect(workspace.tabs.active).toEqual({ key, kind: 'scratch', id })
    expect(workspace.session.scratch?.id).toBe(id)
    expect(workspace.session.body).toBe('Keep me')
    expect(workspace.notice).toEqual({ kind: 'error', text: 'Folder not found: g' })
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('Keep me')
  })

  it('saves the text typed while the folder dialog was open', async () => {
    const { id } = await scratchBetweenNotes('# Draft\n')
    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    // Confirmed right after typing, before the autosave runs: only the gate saves this text.
    workspace.session.edit('# Draft\n\nTyped while choosing.\n')
    dialog.resolve('')
    await saving

    expect(await readFile(path.join(app.dir, 'vault', 'Draft.md'), 'utf8')).toMatch(
      /\n---\n# Draft\n\nTyped while choosing\.\n$/,
    )
    expect(await readdir(app.scratchDir)).toEqual([])
  })

  it('sends no save and keeps the scratch tab when the text typed while the dialog was open cannot be saved', async () => {
    const { id, key } = await scratchBetweenNotes('# Draft\n')
    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    net.fail = (url) => url.pathname === '/api/scratch/write'
    net.hold(onPath('/api/scratch/save'))
    workspace.session.edit('# Draft\n\nNot saved.\n')
    await chooseFolder('')
    await saving

    expect(net.held).toEqual([])
    expect(workspace.tabs.active).toEqual({ key, kind: 'scratch', id })
    expect(workspace.session.body).toBe('# Draft\n\nNot saved.\n')
    expect(workspace.notice).toEqual({
      kind: 'error',
      text: 'This note has unsaved changes that could not be saved. Resolve them first.',
    })
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('# Draft\n')
    expect((await readdir(path.join(app.dir, 'vault'))).filter((name) => name.startsWith('Draft'))).toEqual([])
  })

  it('saves nothing, keeping the scratch tab, when the vault switched while the folder dialog was open', async () => {
    const second = await realpath(await folderWith(app, 'second', { 'in second.md': '# In second\n' }))
    await workspace.newScratchNote()
    const key = workspace.tabs.activeKey
    const id = workspace.session.scratch?.id
    if (key === null || id === undefined) throw new Error('No scratch tab')
    workspace.session.edit('# Chosen in first\n')
    net.hold(onPath('/api/scratch/save'))

    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    await workspace.openVault(second)
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    // The first vault's folder, from the options the dialog was opened with.
    expect(dialog.options.map((option) => option.value)).toContain('f')
    dialog.resolve('f')
    await saving

    expect(net.held).toEqual([])
    expect(workspace.tabs.active).toEqual({ key, kind: 'scratch', id })
    expect(workspace.session.body).toBe('# Chosen in first\n')
    expect(workspace.notice).toEqual({
      kind: 'error',
      text: 'The vault changed while the folder was chosen; nothing was saved.',
    })
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('# Chosen in first\n')
    expect((await readdir(second, { recursive: true })).filter((file) => file.endsWith('.md'))).toEqual([
      'in second.md',
    ])
  })

  it.each([
    { what: 'held before main saw it', answered: false },
    { what: 'answered and held on its way back', answered: true },
  ])(
    'a save $what across a vault switch goes into the vault it was asked in and leaves the new vault’s lists and tabs alone',
    async ({ answered }) => {
      const second = await realpath(await folderWith(app, 'second', { 'in second.md': '# In second\n' }))
      await workspace.newScratchNote()
      const id = workspace.session.scratch?.id
      if (id === undefined) throw new Error('No scratch note')
      workspace.session.edit('# Held\n')
      net.hold(onPath('/api/scratch/save'), { answered })

      const saving = workspace.saveScratchToVault(id)
      await chooseFolder('')
      await expect.poll(() => net.held.length).toBe(1)
      await workspace.openVault(second)
      expect(workspace.data.vault?.root).toBe(second)
      net.held[0]?.release()
      await saving

      expect(await readFile(path.join(app.dir, 'vault', 'Held.md'), 'utf8')).toMatch(/\n---\n# Held\n$/)
      expect(await exists(second, 'Held.md')).toBe(false)
      expect(workspace.data.vault?.root).toBe(second)
      expect(workspace.data.notes.map((note) => note.id)).toEqual(['in second.md'])
      expect(strip()).toEqual([])
      expect(workspace.session.scratch).toBeNull()
      expect(workspace.notice).toEqual({ kind: 'info', text: 'Saved as Held.md in vault' })
      expect(await readdir(app.scratchDir)).toEqual([])
    },
  )
})

describe('WorkspaceModel scratch list', () => {
  let workspace: WorkspaceModel

  const start = async (confirmDelete: boolean) => {
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: { ...DEFAULT_UI, confirmDelete }, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: noTabStore },
    )
  }

  afterEach(() => {
    workspace.session.close()
  })

  /** The scratch list as rows: id and title. */
  const rows = () => workspace.scratchNotes.map(({ id, title }) => ({ id, title }))
  /** The strip: note tabs by path, scratch tabs by id, reader tabs by kind. */
  const strip = () =>
    workspace.tabs.tabs.map((tab) => (tab.kind === 'note' ? tab.path : tab.kind === 'scratch' ? tab.id : tab.kind))

  /** A scratch note with `text` typed, its tab closed after meeting.md is opened; meeting.md's tab stays active. */
  async function keptScratch(text: string): Promise<string> {
    await workspace.openNote('meeting.md')
    await workspace.newScratchNote()
    const id = workspace.session.scratch?.id
    if (id === undefined) throw new Error('No scratch note')
    workspace.session.edit(text)
    await workspace.closeTab()
    return id
  }

  /** Answers the open confirm dialog with `ok`, once it shows. */
  async function answerConfirm(ok: boolean): Promise<void> {
    await expect.poll(() => workspace.dialog?.kind).toBe('confirm')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'confirm') throw new Error('No confirm dialog')
    expect(dialog).toMatchObject({
      title: 'Discard scratch note',
      message: 'Discard “Groceries”? Its text is deleted for good.',
      confirm: 'Discard',
      danger: true,
    })
    dialog.resolve(ok)
  }

  it('lists a new scratch note, follows its title as typed, and keeps it listed once its tab closed with text', async () => {
    await start(true)
    await workspace.newScratchNote()
    const id = workspace.session.scratch?.id ?? ''
    expect(workspace.scratchNotes.map((note) => note.id)).toEqual([id])
    workspace.session.edit('# Groceries\n\nMilk\n')
    expect(rows()).toEqual([{ id, title: 'Groceries' }])

    await workspace.closeTab()

    expect(strip()).toEqual([])
    expect(rows()).toEqual([{ id, title: 'Groceries' }])
  })

  it('drops a scratch note from the list when its tab closes blank', async () => {
    await start(true)
    await workspace.newScratchNote()
    expect(workspace.scratchNotes).toHaveLength(1)
    await workspace.closeTab()
    expect(workspace.scratchNotes).toEqual([])
  })

  it('lists the kept scratch notes once the tabs are restored', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n')
    const later = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: noTabStore },
    )
    expect(later.scratchNotes).toEqual([])
    await later.restoreTabs()
    expect(later.scratchNotes.map(({ id, title }) => ({ id, title }))).toEqual([{ id, title: 'Groceries' }])
  })

  it('reopens a kept scratch note in a new tab with its text, and activates its tab when it is open', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n\nMilk\n')

    await workspace.openScratch(id)
    expect(strip()).toEqual(['meeting.md', id])
    expect(workspace.tabs.active).toMatchObject({ kind: 'scratch', id })
    expect(workspace.session.body).toBe('# Groceries\n\nMilk\n')

    await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1)
    expect(workspace.session.note?.id).toBe('meeting.md')
    await workspace.openScratch(id)
    expect(strip()).toEqual(['meeting.md', id])
    expect(workspace.tabs.active).toMatchObject({ kind: 'scratch', id })
    expect(workspace.session.scratch?.id).toBe(id)
  })

  it('asks before discarding with confirmDelete on: cancelled, the scratch note and its tab stay', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)

    const discarding = workspace.discardScratch(id)
    await answerConfirm(false)
    await discarding

    expect(strip()).toEqual(['meeting.md', id])
    expect(workspace.session.scratch?.id).toBe(id)
    expect(rows()).toEqual([{ id, title: 'Groceries' }])
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('# Groceries\n')
  })

  it('discards once confirmed: the file goes, its open tab closes and the next tab loads, and the row goes', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)

    const discarding = workspace.discardScratch(id)
    await answerConfirm(true)
    await discarding

    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.session.scratch).toBeNull()
    expect(workspace.session.note?.id).toBe('meeting.md')
    expect(workspace.scratchNotes).toEqual([])
    expect(await readdir(app.scratchDir)).toEqual([])
    expect(workspace.notice).toBeNull()
  })

  it('discards without asking with confirmDelete off, its tab not open', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')

    await workspace.discardScratch(id)

    expect(workspace.dialog).toBeNull()
    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.session.note?.id).toBe('meeting.md')
    expect(workspace.scratchNotes).toEqual([])
    expect(await readdir(app.scratchDir)).toEqual([])
  })

  it('saves a listed scratch note with no tab to the vault: it leaves the list and the new note opens', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n\nMilk\n')

    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('f')
    await saving

    expect(workspace.scratchNotes).toEqual([])
    expect(strip()).toEqual(['meeting.md', 'f/Groceries.md'])
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'f/Groceries.md' })
    expect(workspace.session.note?.id).toBe('f/Groceries.md')
    expect(workspace.session.body).toBe('# Groceries\n\nMilk\n')
    expect(await readdir(app.scratchDir)).toEqual([])
    expect(workspace.notice).toBeNull()
  })

  it('saves a listed scratch note whose tab is in the background: its tab becomes the new note’s, active', async () => {
    await start(true)
    const id = await keptScratch('# Groceries\n\nMilk\n')
    await workspace.openScratch(id)
    const key = workspace.tabs.activeKey
    await workspace.openNote('f/n.md', { newTab: true })
    await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1)
    expect(strip()).toEqual(['meeting.md', id, 'f/n.md'])
    expect(workspace.session.note?.id).toBe('meeting.md')

    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('f')
    await saving

    expect(strip()).toEqual(['meeting.md', 'f/Groceries.md', 'f/n.md'])
    expect(workspace.tabs.activeKey).toBe(key)
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'f/Groceries.md' })
    expect(workspace.session.note?.id).toBe('f/Groceries.md')
    expect(workspace.scratchNotes).toEqual([])
  })

  it('sends the discard only once the scratch note’s save in flight is done, so the save cannot bring it back', async () => {
    await start(false)
    await workspace.newScratchNote()
    const id = workspace.session.scratch?.id ?? ''
    net.hold((url) =>
      url.pathname === '/api/scratch/write' || url.pathname === '/api/scratch/discard' ? url.pathname : undefined,
    )
    workspace.session.edit('# Groceries\n')
    await expect.poll(() => net.held.map((request) => request.id)).toEqual(['/api/scratch/write'])

    const discarding = workspace.discardScratch(id)
    // The discard's hold has started (it locks the session); the discard request waits for the save.
    await expect.poll(() => workspace.session.locked).toBe(true)
    expect(net.held.map((request) => request.id)).toEqual(['/api/scratch/write'])
    net.hold(null)
    net.held[0]?.release()
    await discarding

    expect(strip()).toEqual([])
    expect(workspace.session.scratch).toBeNull()
    expect(await readdir(app.scratchDir)).toEqual([])
  })

  it('titles a restored scratch tab that never opened in this page from its text', async () => {
    await start(false)
    const first = await keptScratch('# Groceries\n')
    await workspace.newScratchNote()
    const second = workspace.session.scratch?.id ?? ''
    workspace.session.edit('# Second\n')
    await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1)
    const later = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: { ...noTabStore, loadScratch: () => ({ ids: [first, second], active: 1 }) } },
    )
    await later.restoreTabs()
    expect(later.session.scratch?.id).toBe(second)
    expect(later.scratchTabTitle(first)).toBe('Groceries')
    expect(later.scratchTabTitle(second)).toBe('Second')
    later.session.edit('# Retitled\n')
    expect(later.scratchTabTitle(second)).toBe('Retitled')
    later.session.close()
  })

  it('drops a scratch note’s row once its tab, activated, finds its file gone', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)
    await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1)
    await rm(path.join(app.scratchDir, `${id}.md`))
    await rm(path.join(app.scratchDir, `${id}.json`))

    await workspace.activateTab(workspace.tabs.tabs[1]?.key ?? -1)
    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.scratchNotes).toEqual([])
  })

  it('keeps the row, the tab and the file, with the error notice, when the discard fails', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)
    net.fail = (url) => url.pathname === '/api/scratch/discard'
    await workspace.discardScratch(id)
    net.fail = null
    expect(strip()).toEqual(['meeting.md', id])
    expect(rows()).toEqual([{ id, title: 'Groceries' }])
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('# Groceries\n')
    expect(workspace.notice).toEqual({ kind: 'error', text: 'Disk full' })
  })

  it('closes the tab and drops the row, with no notice, when the scratch note was already removed on disk', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)
    await rm(path.join(app.scratchDir, `${id}.md`))
    await rm(path.join(app.scratchDir, `${id}.json`))
    await workspace.discardScratch(id)
    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.scratchNotes).toEqual([])
    expect(workspace.notice).toBeNull()
  })

  it('discards a listed scratch note whose tab is in the background, leaving the active note loaded', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await workspace.openScratch(id)
    await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1)
    await workspace.discardScratch(id)
    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'meeting.md' })
    expect(workspace.session.note?.id).toBe('meeting.md')
    expect(workspace.scratchNotes).toEqual([])
    expect(await readdir(app.scratchDir)).toEqual([])
  })

  it('keeps the open note editable while a discard of a scratch note with no tab is out', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    net.hold(onPath('/api/scratch/discard'), { once: true })
    const discarding = workspace.discardScratch(id)
    await expect.poll(() => net.held.length).toBe(1)
    expect(workspace.session.locked).toBe(false)
    net.held[0]?.release()
    await discarding
    expect(workspace.scratchNotes).toEqual([])
  })

  it('says a scratch note is gone, and drops its row, when its row reopens it after its file was removed', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await rm(path.join(app.scratchDir, `${id}.md`))
    await rm(path.join(app.scratchDir, `${id}.json`))
    await workspace.openScratch(id)
    expect(strip()).toEqual(['meeting.md'])
    expect(workspace.notice).toEqual({ kind: 'error', text: 'This scratch note no longer exists' })
    expect(workspace.scratchNotes).toEqual([])
  })

  it('reads an active scratch tab again when its row is clicked after its read failed', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    net.fail = (url) => url.pathname === '/api/scratch/read'
    await workspace.openScratch(id)
    net.fail = null
    expect(workspace.tabs.active).toMatchObject({ kind: 'scratch', id })
    expect(workspace.session.scratch).toBeNull()
    await workspace.openScratch(id)
    expect(workspace.session.scratch?.id).toBe(id)
    expect(workspace.session.body).toBe('# Groceries\n')
  })

  it('drops a listing that returns after a later one, and shows a failed listing as the error notice', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    net.hold(onPath('/api/scratch'), { once: true })
    const stale = workspace.refreshScratch()
    await expect.poll(() => net.held.length).toBe(1)
    await workspace.discardScratch(id)
    expect(workspace.scratchNotes).toEqual([])
    net.held[0]?.release()
    await stale
    expect(workspace.scratchNotes).toEqual([])

    net.fail = (url) => url.pathname === '/api/scratch'
    await workspace.refreshScratch()
    net.fail = null
    expect(workspace.notice).toEqual({ kind: 'error', text: 'Disk full' })
  })

  it('opens the saved note’s tab in the background when another tab was activated while a row with no tab saved', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    await workspace.openNote('f/n.md', { newTab: true })
    const meeting = workspace.tabs.tabs[0]?.key ?? -1
    net.hold(onPath('/api/scratch/save'), { once: true })
    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('')
    await expect.poll(() => net.held.length).toBe(1)
    await workspace.activateTab(meeting)
    net.held[0]?.release()
    await saving
    expect(strip()).toEqual(['meeting.md', 'Groceries.md', 'f/n.md'])
    expect(workspace.tabs.activeKey).toBe(meeting)
    expect(workspace.session.note?.id).toBe('meeting.md')
  })

  it('opens no tab for a row with no tab saved across a vault switch, and says where the note went', async () => {
    await start(false)
    const second = await realpath(await folderWith(app, 'second', { 'in second.md': '# In second\n' }))
    const id = await keptScratch('# Groceries\n')
    net.hold(onPath('/api/scratch/save'), { once: true })
    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('')
    await expect.poll(() => net.held.length).toBe(1)
    await workspace.openVault(second)
    net.held[0]?.release()
    await saving
    expect(strip()).toEqual([])
    expect(workspace.notice).toEqual({ kind: 'info', text: 'Saved as Groceries.md in vault' })
    expect(workspace.scratchNotes).toEqual([])
  })

  it('refuses a row’s Discard while its Save to vault is out, so the save is shown as it happened', async () => {
    await start(false)
    const id = await keptScratch('# Groceries\n')
    net.hold(onPath('/api/scratch/save'), { once: true })
    const saving = workspace.saveScratchToVault(id)
    await expect.poll(() => workspace.dialog?.kind).toBe('choose')
    const dialog = workspace.dialog
    if (dialog?.kind !== 'choose') throw new Error('No choose dialog')
    dialog.resolve('')
    await expect.poll(() => net.held.length).toBe(1)
    expect(workspace.savingScratch(id)).toBe(true)
    await workspace.discardScratch(id)
    net.held[0]?.release()
    await saving
    expect(workspace.savingScratch(id)).toBe(false)
    expect(workspace.notice).toBeNull()
    expect(workspace.tabs.active).toMatchObject({ kind: 'note', path: 'Groceries.md' })
    expect(workspace.scratchNotes).toEqual([])
  })

  it('closes Preferences, Import, Title renames and an open prompt before a new scratch note takes the focus', async () => {
    await start(false)
    await workspace.openNote('meeting.md')
    workspace.setPreferencesOpen(true)
    workspace.setImportOpen(true)
    workspace.setTitleRenamesOpen(true)
    const prompt = workspace.prompt({ title: 'Rename note', label: 'File name', value: 'x', confirm: 'Rename' })
    await workspace.newScratchNote()
    expect(await prompt).toBeNull()
    expect(workspace.dialog).toBeNull()
    expect(workspace.preferencesOpen).toBe(false)
    expect(workspace.importOpen).toBe(false)
    expect(workspace.titleRenamesOpen).toBe(false)
    expect(workspace.tabs.active?.kind).toBe('scratch')
    expect(workspace.takeEditorFocus()).not.toBeNull()
  })
})

describe('WorkspaceModel relocations that return after a vault switch', () => {
  let workspace: WorkspaceModel
  let saved: Map<string, TabsSnapshot>

  beforeEach(async () => {
    saved = new Map()
    workspace = new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      {
        api,
        store: {
          load: (root) => saved.get(root) ?? null,
          save: (root, snapshot) => {
            saved.set(root, structuredClone(snapshot))
          },
          loadScratch: () => null,
          saveScratch: () => {},
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
      { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
      { api, store: noTabStore },
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

  it.each([
    { what: 'showing', parked: false },
    { what: 'parked under a prompt the new scratch note cancels', parked: true },
  ])(
    'leaves the editor focus alone when a new scratch note opens with an Update links? question $what',
    async ({ parked }) => {
      const naming = parked ? folderPrompt() : undefined
      const moving = workspace.moveNote('a.md', 'g')
      if (parked) await expect.poll(() => workspace.dialog?.kind).toBe('prompt')
      else await expect.poll(() => workspace.dialog?.kind).toBe('links')

      await workspace.newScratchNote()
      if (naming) expect(await naming).toBeNull()
      expect(workspace.tabs.active?.kind).toBe('scratch')
      expect(workspace.dialog?.kind).toBe('links')
      expect(workspace.takeEditorFocus()).toBeNull()

      answer(null, true)
      await moving
      expect(workspace.dialog).toBeNull()
    },
  )
})
