import { access, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, setPageVault } from '../../src/app/actions/public/workspace/api.ts'
import { Navigation, type NavigationHost, type TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import { NoteSession } from '../../src/app/actions/public/workspace/note-session.ts'
import type { ScratchTabsSnapshot, TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import type { WorkspaceData } from '../../src/app/actions/public/workspace/types.ts'
import { folderWith, type HeldClient, heldClient, TestApp } from './helpers.ts'

/** Tab snapshots by vault root, and the scratch tabs' entry, as the app keeps them in `localStorage`. */
class MemoryTabStore implements TabStore {
  readonly saved = new Map<string, unknown>()
  scratch: unknown = null

  load(root: string): unknown {
    return this.saved.get(root) ?? null
  }

  save(root: string, snapshot: TabsSnapshot): void {
    this.saved.set(root, structuredClone(snapshot))
  }

  loadScratch(): unknown {
    return this.scratch
  }

  saveScratch(snapshot: ScratchTabsSnapshot): void {
    this.scratch = structuredClone(snapshot)
  }
}

const UNSAVED = 'This note has unsaved changes that could not be saved. Resolve them first.'

let app: TestApp
/** Holds and fails the requests of `api` (`heldClient`). */
let net: HeldClient
/** The API client the page would use, built over the current test's router (`TestApp.fetch`), with requests held and failed by `net`. */
let api: Client

/** Note saves fail as if the disk were full while `net.fail` is this. */
const saves = (url: URL) => url.pathname === '/api/notes/save'

/**
 * What `net.hold(heldIds)` holds: note and reader reads (by note id or ticket), note creates (`'create'`), note
 * deletes (`'delete'`) and folder deletes (`'delete folder'`).
 */
function heldIds(url: URL): string | undefined {
  if (url.pathname === '/api/notes/read') return url.searchParams.get('id') ?? ''
  if (url.pathname === '/api/notes/create') return 'create'
  if (url.pathname === '/api/notes/delete') return 'delete'
  if (url.pathname === '/api/folders/delete') return 'delete folder'
  return /^\/api\/reader\/([^/]+)$/.exec(url.pathname)?.[1]
}
let folder: string
let data: WorkspaceData
let store: MemoryTabStore
let notices: string[]
let session: NoteSession
let navigation: Navigation

/** Navigation over `api`, the session and `tabStore`, in a workspace that shows `data`. */
function createNavigation(tabStore: TabStore): Navigation {
  const host: NavigationHost = {
    root: () => data.vault?.root,
    hasNote: (id) => data.notes.some((note) => note.id === id),
    showVault: (next) => {
      data = next
    },
    notify: (_kind, text) => notices.push(text),
    fail: (error) => notices.push(error instanceof Error ? error.message : String(error)),
    changed: () => {},
  }
  return new Navigation({ session, api, store: tabStore, host })
}

beforeEach(async () => {
  app = await TestApp.create()
  net = heldClient(app)
  api = net.client
  folder = await folderWith(app, 'vault', { 'a.md': '# A\n', 'b.md': '# B\n', 'c.md': '# C\n', 'f/n.md': '# N\n' })
  await app.openVault('vault')
  data = await api.workspace()
  store = new MemoryTabStore()
  notices = []
  session = new NoteSession(api)
  navigation = createNavigation(store)
})

afterEach(async () => {
  session.close()
  await app.close()
})

/** The tabs saved for the vault on screen. */
const saved = () => store.saved.get(data.vault?.root ?? '')
const onDisk = (id: string) => readFile(path.join(folder, id), 'utf8')

describe('Navigation', () => {
  it('opens notes in the active tab and in new tabs, saving the tabs under the vault root', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md')
    await navigation.open('c.md', { newTab: true })
    expect(session.note?.id).toBe('c.md')
    expect(saved()).toEqual({ tabs: ['b.md', 'c.md'], active: 1, closed: [] })
    expect(notices).toEqual([])
  })

  it('saves the open note before switching, and refuses the switch while it cannot be saved', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    await navigation.open('b.md')
    expect(await onDisk('a.md')).toMatch(/\n# A\n\nMine\.\n$/)

    session.edit('# B\n\nMine.\n')
    net.fail = saves
    await navigation.open('a.md')
    expect(session.note?.id).toBe('b.md')
    expect(session.body).toBe('# B\n\nMine.\n')
    expect(notices).toEqual([UNSAVED])
    expect(saved()).toEqual({ tabs: ['b.md'], active: 0, closed: [] })
  })

  it('selects tabs by position (-1: the last) and closes them, remembering the closed ones', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    await navigation.open('c.md', { newTab: true })
    await navigation.select(0)
    expect(session.note?.id).toBe('a.md')
    expect(saved()).toEqual({ tabs: ['a.md', 'b.md', 'c.md'], active: 0, closed: [] })
    await navigation.select(-1)
    expect(session.note?.id).toBe('c.md')
    expect(saved()).toEqual({ tabs: ['a.md', 'b.md', 'c.md'], active: 2, closed: [] })

    // The active tab hands over to its left neighbour (no right one).
    await navigation.close()
    expect(session.note?.id).toBe('b.md')
    expect(saved()).toEqual({ tabs: ['a.md', 'b.md'], active: 1, closed: [{ path: 'c.md', index: 2 }] })

    // A background tab closes without leaving the open note.
    session.edit('# B\n\nMine.\n')
    const [first] = navigation.tabs.tabs
    if (first) await navigation.close(first.key)
    expect(session.note?.id).toBe('b.md')
    expect(session.state).toBe('dirty')
    expect(saved()).toEqual({
      tabs: ['b.md'],
      active: 0,
      closed: [
        { path: 'c.md', index: 2 },
        { path: 'a.md', index: 0 },
      ],
    })

    await navigation.reopen()
    expect(session.note?.id).toBe('a.md')
    expect(await onDisk('b.md')).toMatch(/\n# B\n\nMine\.\n$/)
    expect(saved()).toEqual({ tabs: ['a.md', 'b.md'], active: 0, closed: [{ path: 'c.md', index: 2 }] })
  })

  it('refuses to select another tab while the open note cannot be saved', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    session.edit('# B\n\nMine.\n')
    net.fail = saves
    await navigation.select(0)
    expect(session.note?.id).toBe('b.md')
    expect(session.body).toBe('# B\n\nMine.\n')
    expect(notices).toEqual([UNSAVED])
    expect(saved()).toEqual({ tabs: ['a.md', 'b.md'], active: 1, closed: [] })
  })

  it('selects the tab it was asked for even when the strip changes while the gate saves', async () => {
    await navigation.open('a.md')
    for (const id of ['b.md', 'c.md', 'f/n.md']) await navigation.open(id, { newTab: true })
    await navigation.select(1)
    session.edit('# B\n\nMine.\n')
    net.hold((url) => (url.pathname === '/api/notes/save' ? 'save' : undefined))
    // Cmd+3: c.md. While B saves, a list refresh drops the tab of a.md, deleted outside the app.
    const selected = navigation.select(2)
    await expect.poll(() => net.held.length).toBe(1)
    data = { ...data, notes: data.notes.filter((note) => note.id !== 'a.md') }
    navigation.dropMissing()
    net.held[0]?.release()
    await selected
    expect(session.note?.id).toBe('c.md')
    expect(saved()).toMatchObject({ tabs: ['b.md', 'c.md', 'f/n.md'], active: 1 })
  })

  it('refuses to delete the open note while its save fails: the note stays on disk, open, with its edits', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    net.fail = saves
    expect(await navigation.deleteNote('a.md')).toBeNull()
    expect(await onDisk('a.md')).toBe('# A\n')
    expect(notices).toEqual([UNSAVED])
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
  })

  it('refuses to delete a folder holding the open note while that note is in conflict', async () => {
    await navigation.open('f/n.md')
    await writeFile(path.join(folder, 'f/n.md'), '# Theirs\n')
    session.edit('# Mine\n')
    await session.flush()
    expect(session.state).toBe('conflict')

    expect(await navigation.deleteFolder('f')).toBe(false)
    expect(await onDisk('f/n.md')).toBe('# Theirs\n')
    expect(notices).toEqual([UNSAVED])
    expect(session.note?.id).toBe('f/n.md')
    expect(session.state).toBe('conflict')
  })

  it('deletes the open note after saving its edits: its tab closes, the next tab’s note opens, the trash keeps the edits', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    session.edit('# B\n\nMine.\n')
    expect(await navigation.deleteNote('b.md')).not.toBeNull()
    await expect(access(path.join(folder, 'b.md'))).rejects.toThrow()
    expect(session.note?.id).toBe('a.md')
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
    const [trashed] = (await api.workspace()).trash
    await api.restore(trashed?.id ?? '')
    expect(await onDisk('b.md')).toMatch(/\n# B\n\nMine\.\n$/)
  })

  it('deletes a folder holding the open note after saving its edits: its tabs close', async () => {
    await navigation.open('a.md')
    await navigation.open('f/n.md', { newTab: true })
    session.edit('# N\n\nMine.\n')
    expect(await navigation.deleteFolder('f')).toBe(true)
    await expect(access(path.join(folder, 'f/n.md'))).rejects.toThrow()
    expect(session.note?.id).toBe('a.md')
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
    const [trashed] = (await api.workspace()).trash
    await api.restore(trashed?.id ?? '')
    expect(await onDisk('f/n.md')).toMatch(/\n# N\n\nMine\.\n$/)
  })

  it('deletes another note or folder while the open note cannot be saved, leaving that note as it is', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    net.fail = saves
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('error')
    expect(await navigation.deleteNote('b.md')).not.toBeNull()
    expect(await navigation.deleteFolder('f')).toBe(true)
    await expect(access(path.join(folder, 'b.md'))).rejects.toThrow()
    await expect(access(path.join(folder, 'f/n.md'))).rejects.toThrow()
    expect(notices).not.toContain(UNSAVED)
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
  })

  it('leaves the tabs and open note of the vault switched to while a delete was out', async () => {
    const other = await folderWith(app, 'other', { 'b.md': '# Other B\n' })
    await navigation.open('a.md')
    net.hold((url) => (url.pathname === '/api/notes/delete' ? 'delete' : undefined))
    const deleted = navigation.deleteNote('b.md')
    await expect.poll(() => net.held.length).toBe(1)
    const switched = navigation.switchVault(
      async () => (await api.openVault(other)).workspace,
      (tabs) => tabs.openNew('b.md'),
    )
    expect(await switched).toBe(true)
    expect(session.note?.id).toBe('b.md')
    net.held[0]?.release()
    expect(await deleted).not.toBeNull()
    expect(session.note).toMatchObject({ id: 'b.md', body: '# Other B\n' })
    expect(navigation.tabs.tabs).toMatchObject([{ kind: 'note', path: 'b.md' }])
    expect(saved()).toEqual({ tabs: ['b.md'], active: 0, closed: [] })
    await expect(access(path.join(folder, 'b.md'))).rejects.toThrow()
  })

  it('leaves the tabs and open note of the vault switched to while a folder delete was out', async () => {
    const other = await folderWith(app, 'other', { 'f/n.md': '# Other N\n' })
    await navigation.open('a.md')
    net.hold((url) => (url.pathname === '/api/folders/delete' ? 'delete folder' : undefined))
    const deleted = navigation.deleteFolder('f')
    await expect.poll(() => net.held.length).toBe(1)
    const switched = navigation.switchVault(
      async () => (await api.openVault(other)).workspace,
      (tabs) => tabs.openNew('f/n.md'),
    )
    expect(await switched).toBe(true)
    net.held[0]?.release()
    expect(await deleted).toBe(true)
    expect(session.note).toMatchObject({ id: 'f/n.md', body: '# Other N\n' })
    expect(navigation.tabs.tabs).toMatchObject([{ kind: 'note', path: 'f/n.md' }])
    expect(saved()).toEqual({ tabs: ['f/n.md'], active: 0, closed: [] })
    await expect(access(path.join(folder, 'f/n.md'))).rejects.toThrow()
  })

  it('saves a background tab closed while a held delete is out, even when that delete fails', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    await navigation.open('c.md', { newTab: true })
    net.hold((url) => (url.pathname === '/api/notes/delete' ? 'delete' : undefined))
    const deleted = navigation.deleteNote('f/n.md')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.close(navigation.tabs.tabs[0]?.key)
    net.held[0]?.release('Disk full')
    await expect(deleted).rejects.toThrow('Disk full')
    expect(saved()).toEqual({ tabs: ['b.md', 'c.md'], active: 1, closed: [{ path: 'a.md', index: 0 }] })
  })

  it('saves a background tab closed while a vault switch loads under the vault it was closed in', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    const first = data.vault?.root ?? ''
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    let loading = false
    const switched = navigation.switchVault(async () => {
      loading = true
      await held
      return (await api.openVault(other)).workspace
    })
    await expect.poll(() => loading).toBe(true)
    await navigation.close(navigation.tabs.tabs[0]?.key)
    release()
    expect(await switched).toBe(true)
    expect(store.saved.get(first)).toEqual({ tabs: ['b.md'], active: 0, closed: [{ path: 'a.md', index: 0 }] })
  })

  it('finishes a vault switch and reports, without rejecting, that the tabs changed in the vault left cannot be saved', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    const first = data.vault?.root ?? ''
    // Only the vault left is over its quota: the other vault's tabs save.
    let full = false
    navigation = createNavigation({
      load: (root) => store.load(root),
      save: (root, snapshot) => {
        if (full && root === first) throw new Error('QuotaExceededError')
        store.save(root, snapshot)
      },
      loadScratch: () => store.loadScratch(),
      saveScratch: (snapshot) => store.saveScratch(snapshot),
    })
    await navigation.restore()
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    let loading = false
    const switched = navigation.switchVault(
      async () => {
        loading = true
        await held
        return (await api.openVault(other)).workspace
      },
      (tabs) => tabs.openNew('x.md'),
    )
    await expect.poll(() => loading).toBe(true)
    full = true
    await navigation.close(navigation.tabs.tabs[0]?.key)
    release()
    // Main is on the other vault, so the switch happened: the store error is reported, and the page shows that vault, unlocked.
    expect(await switched).toBe(true)
    expect(notices).toEqual(['QuotaExceededError'])
    expect(data.vault?.root).not.toBe(first)
    expect(session.note?.id).toBe('x.md')
    expect(session.locked).toBe(false)
    expect(saved()).toEqual({ tabs: ['x.md'], active: 0, closed: [] })
  })

  it('finishes a switch or delete before saving its tabs: a store that throws leaves the new note open, unlocked', async () => {
    let full = false
    navigation = createNavigation({
      load: (root) => store.load(root),
      save: (root, snapshot) => {
        if (full) throw new Error('QuotaExceededError')
        store.save(root, snapshot)
      },
      loadScratch: () => store.loadScratch(),
      saveScratch: (snapshot) => store.saveScratch(snapshot),
    })
    await navigation.open('a.md')
    full = true
    await expect(navigation.open('b.md', { newTab: true })).rejects.toThrow('QuotaExceededError')
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'b.md' })
    expect(session.locked).toBe(false)

    await expect(navigation.deleteNote('b.md')).rejects.toThrow('QuotaExceededError')
    expect(session.note?.id).toBe('a.md')
    expect(navigation.tabs.tabs).toMatchObject([{ kind: 'note', path: 'a.md' }])
    expect(session.locked).toBe(false)
  })

  it('creates nothing when the gate refuses a new note', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    net.fail = saves
    expect(await navigation.newNote('')).toBeNull()
    expect(notices).toEqual([UNSAVED])
    expect((await readdir(folder)).filter((name) => name.endsWith('.md')).sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(session.note?.id).toBe('a.md')
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
  })

  it('shows a new note in the active tab and saves the tabs', async () => {
    await navigation.open('a.md')
    const created = await navigation.newNote('')
    expect(created?.shown).toBe(true)
    expect(session.note?.id).toBe(created?.note.id)
    expect(saved()).toEqual({ tabs: [created?.note.id], active: 0, closed: [] })
  })

  it('drops a note read that fails after a later transition: no notice, its tab stays', async () => {
    net.hold(heldIds)
    const reads = net.held
    const toA = navigation.open('a.md')
    await expect.poll(() => reads.length).toBe(1)
    // a.md is deleted outside the app while its read is out: the read answers 404.
    net.gone.add('a.md')
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.map((read) => read.id)).toEqual(['a.md', 'b.md'])
    reads[1]?.release()
    await toB
    reads[0]?.release()
    await toA
    expect(notices).toEqual([])
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabs.tabs).toMatchObject([
      { kind: 'note', path: 'a.md' },
      { kind: 'note', path: 'b.md' },
    ])
  })

  it.each([
    { what: 'note', id: 'b.md', remove: () => navigation.deleteNote('b.md'), request: 'delete' },
    { what: 'folder', id: 'f/n.md', remove: () => navigation.deleteFolder('f'), request: 'delete folder' },
  ])(
    'takes no edits to the open note while the delete of its $what is out: the trash keeps it as the gate saved it',
    async ({ id, remove, request }) => {
      await navigation.open('a.md')
      await navigation.open(id, { newTab: true })
      session.edit('# Mine\n\nSaved by the gate.\n')
      net.hold(heldIds)
      const requests = net.held
      const deleted = remove()
      await expect.poll(() => requests.map((held) => held.id)).toEqual([request])
      // The gate saved the note; until it is trashed and its tab closed, the session refuses edits (the editor is read-only).
      expect(session.locked).toBe(true)
      session.edit('# Mine\n\nSaved by the gate.\n\nTyped while it is trashed.\n')
      expect(session.body).toBe('# Mine\n\nSaved by the gate.\n')
      expect(session.state).toBe('saved')
      net.hold(null)
      requests[0]?.release()
      expect(await deleted).toBeTruthy()
      expect(session.note?.id).toBe('a.md')
      expect(session.locked).toBe(false)
      expect(notices).toEqual([])
      // Nothing was lost: back from the trash, the note reads as the gate saved it.
      const [trashed] = (await api.workspace()).trash
      await api.restore(trashed?.id ?? '')
      expect(await onDisk(id)).toMatch(/\n# Mine\n\nSaved by the gate\.\n$/)
    },
  )

  it.each([
    { what: 'note', id: 'a.md', remove: () => navigation.deleteNote('a.md'), request: 'delete' },
    { what: 'folder', id: 'f/n.md', remove: () => navigation.deleteFolder('f'), request: 'delete folder' },
  ])(
    'takes edits to the open note again when the delete of its $what fails: it stays open, on disk',
    async ({ id, remove, request }) => {
      await navigation.open(id)
      net.hold(heldIds)
      const requests = net.held
      const deleted = remove()
      await expect.poll(() => requests.map((held) => held.id)).toEqual([request])
      expect(session.locked).toBe(true)
      requests[0]?.release('Disk full')
      await expect(deleted).rejects.toThrow('Disk full')
      expect(session.note?.id).toBe(id)
      expect(session.locked).toBe(false)
      expect(saved()).toEqual({ tabs: [id], active: 0, closed: [] })
      session.edit('# Mine\n\nAfter the failed delete.\n')
      expect(await session.flush()).toBe(true)
      expect(await onDisk(id)).toMatch(/\n# Mine\n\nAfter the failed delete\.\n$/)
    },
  )

  it('saves the open note before deleting another note loads the active tab’s note in its place (its read had failed)', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const reads = net.held
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.length).toBe(1)
    reads[0]?.release('Disk full')
    await toB
    net.hold(null)
    // B's read failed: the editor keeps A (and takes edits) while B's tab is active.
    session.edit('# A\n\nTyped after B failed.\n')
    expect(await navigation.deleteNote('c.md')).not.toBeNull()
    expect(session.note?.id).toBe('b.md')
    expect(await onDisk('a.md')).toMatch(/\n# A\n\nTyped after B failed\.\n$/)
    expect(notices).toEqual(['Disk full'])
  })

  it('switches vaults, keeping each vault’s tabs under its root and counting the other vault’s tabs', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    const first = data.vault?.root ?? ''

    expect(await navigation.switchVault(async () => (await api.openVault(other)).workspace)).toBe(true)
    const second = data.vault?.root ?? ''
    expect(second).not.toBe(first)
    expect(session.note).toBeNull()
    expect(navigation.tabs.tabs).toEqual([])
    expect(navigation.tabCount(first)).toBe(2)

    await navigation.open('x.md')
    await navigation.switchVault(async () => (await api.openVault(first)).workspace)
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabCount(first)).toBe(2)
    expect(navigation.tabCount(second)).toBe(1)
  })

  it('refuses a vault switch while the open note cannot be saved, asking main nothing', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    net.fail = saves
    let asked = false
    const switched = await navigation.switchVault(async () => {
      asked = true
      return undefined
    })
    expect(switched).toBe(false)
    expect(asked).toBe(false)
    expect(notices).toEqual([UNSAVED])
    expect(session.note?.id).toBe('a.md')
  })

  it('switchVault rejects when saving the restored tabs throws (WorkspaceModel’s tests cover the callers)', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    // Like `localStorage.setItem` over its quota: saving the restored tabs after `change` throws.
    navigation = createNavigation({
      load: () => null,
      save: () => {
        throw new Error('QuotaExceededError')
      },
      loadScratch: () => null,
      saveScratch: () => {},
    })
    const switched = navigation.switchVault(
      async () => (await api.openVault(other)).workspace,
      (tabs) => tabs.openNew('x.md'),
    )
    await expect(switched).rejects.toThrow('QuotaExceededError')
  })

  it('drops a read that returns after a later transition: the session shows the active tab’s note', async () => {
    net.hold(heldIds)
    const reads = net.held
    const toA = navigation.open('a.md')
    await expect.poll(() => reads.length).toBe(1)
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.map((read) => read.id)).toEqual(['a.md', 'b.md'])

    // B's read returns first, then A's.
    reads[1]?.release()
    await toB
    // A's transition still runs: the open note takes no edits until the last transition ends.
    expect(session.locked).toBe(true)
    reads[0]?.release()
    await toA
    expect(session.locked).toBe(false)
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'b.md' })
    expect(notices).toEqual([])
  })

  it('takes no edits to the open note while the next note’s read is out, then opens that note', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const reads = net.held
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.length).toBe(1)
    // The gate saved A; the editor still shows A while B is read, but the session refuses edits (read-only).
    expect(session.locked).toBe(true)
    session.edit('# A\n\nTyped while B loads.\n')
    expect(session.body).toBe('# A\n')
    reads[0]?.release()
    await toB
    expect(session.note?.id).toBe('b.md')
    expect(session.locked).toBe(false)
    expect(await onDisk('a.md')).toBe('# A\n')
    expect(notices).toEqual([])
  })

  it('takes edits to the open note again when the next note’s read fails', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const reads = net.held
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.length).toBe(1)
    expect(session.locked).toBe(true)
    reads[0]?.release('Disk full')
    await toB
    expect(notices).toEqual(['Disk full'])
    expect(session.note?.id).toBe('a.md')
    expect(session.locked).toBe(false)
    session.edit('# A\n\nAfter the failed read.\n')
    expect(await session.flush()).toBe(true)
    expect(await onDisk('a.md')).toMatch(/\n# A\n\nAfter the failed read\.\n$/)
  })

  it('takes no edits while the read of a note that turns out gone is out; its only tab then closes', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const reads = net.held
    // In place: A's tab now shows a note that is not on disk, so the read answers 404 and that tab closes.
    const toGone = navigation.open('gone.md')
    await expect.poll(() => reads.length).toBe(1)
    expect(session.locked).toBe(true)
    session.edit('# A\n\nTyped while gone.md loads.\n')
    expect(session.body).toBe('# A\n')
    reads[0]?.release()
    await toGone
    expect(notices).toEqual(['Note not found: gone.md'])
    expect(session.note).toBeNull()
    expect(session.locked).toBe(false)
    expect(navigation.tabs.tabs).toEqual([])
    expect(await onDisk('a.md')).toBe('# A\n')
  })

  it('takes no edits while the read of a note that turns out gone is out; the reader tab beside it then shows', async () => {
    const outside = path.join(await folderWith(app, 'outside', { 'outside.md': '# Outside\n' }), 'outside.md')
    const ticket = await app.vaults.readers.grant(await realpath(outside))
    if (ticket === undefined) throw new Error('No reader ticket for outside.md')
    await navigation.openReader(ticket, 'outside.md')
    await navigation.open('a.md', { newTab: true })
    net.hold(heldIds)
    const reads = net.held
    // A's tab moves in place to a note that is not on disk: its 404 closes the tab, and the reader tab is active.
    const toGone = navigation.open('gone.md')
    await expect.poll(() => reads.map((read) => read.id)).toEqual(['gone.md'])
    expect(session.locked).toBe(true)
    session.edit('# A\n\nTyped while gone.md loads.\n')
    expect(session.body).toBe('# A\n')
    net.hold(null)
    reads[0]?.release()
    await toGone
    expect(notices).toEqual(['Note not found: gone.md'])
    expect(navigation.tabs.active).toMatchObject({ kind: 'reader', ticket })
    expect(navigation.reader?.ticket).toBe(ticket)
    expect(session.note).toBeNull()
    expect(session.locked).toBe(false)
    expect(await onDisk('a.md')).toBe('# A\n')
  })

  it('takes no edits to the open note while a new note is created, then shows the new note', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const requests = net.held
    const created = navigation.newNote('')
    await expect.poll(() => requests.map((request) => request.id)).toEqual(['create'])
    expect(session.locked).toBe(true)
    session.edit('# A\n\nTyped while the note is created.\n')
    expect(session.body).toBe('# A\n')
    requests[0]?.release()
    const result = await created
    expect(result?.shown).toBe(true)
    expect(session.note?.id).toBe(result?.note.id)
    expect(session.locked).toBe(false)
    expect(await onDisk('a.md')).toBe('# A\n')
    expect(notices).toEqual([])
  })

  it('takes edits to the open note again when creating a new note fails', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const requests = net.held
    const created = navigation.newNote('')
    await expect.poll(() => requests.map((request) => request.id)).toEqual(['create'])
    expect(session.locked).toBe(true)
    requests[0]?.release('Disk full')
    await expect(created).rejects.toThrow('Disk full')
    expect(session.note?.id).toBe('a.md')
    expect(session.locked).toBe(false)
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
    session.edit('# A\n\nAfter the failed create.\n')
    expect(await session.flush()).toBe(true)
    expect(await onDisk('a.md')).toMatch(/\n# A\n\nAfter the failed create\.\n$/)
  })

  it('does not show a new note whose create returns after the active tab moved to another note in place', async () => {
    await navigation.open('a.md')
    net.hold(heldIds)
    const requests = net.held
    const created = navigation.newNote('')
    await expect.poll(() => requests.map((request) => request.id)).toEqual(['create'])
    const toB = navigation.open('b.md')
    await expect.poll(() => requests.map((request) => request.id)).toEqual(['create', 'b.md'])
    requests[0]?.release()
    expect(await created).toMatchObject({ shown: false })
    requests[1]?.release()
    await toB
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabs.tabs).toMatchObject([{ kind: 'note', path: 'b.md' }])
  })

  it('takes no edits to the open note while a vault switch loads, so none is dropped when the switch closes it', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    await navigation.open('a.md')
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    let loading = false
    const switched = navigation.switchVault(async () => {
      loading = true
      await held
      return (await api.openVault(other)).workspace
    })
    await expect.poll(() => loading).toBe(true)
    // Main may already be switching the vault: the edit is refused (the editor is read-only meanwhile).
    session.edit('# A\n\nTyped while the vault loads.\n')
    expect(session.body).toBe('# A\n')
    expect(session.state).toBe('saved')
    // So are properties: the caller shows its "could not update" notice.
    expect(await session.setFrontmatter({ ...session.note?.frontmatter, tags: ['late'] })).toBe(false)
    expect(session.state).toBe('saved')
    release()
    expect(await switched).toBe(true)
    expect(session.note).toBeNull()
    expect(await onDisk('a.md')).toBe('# A\n')
  })

  it('takes edits again once a vault switch is cancelled or fails', async () => {
    await navigation.open('a.md')
    expect(await navigation.switchVault(async () => undefined)).toBe(true)
    session.edit('# A\n\nAfter the cancelled picker.\n')
    expect(session.state).toBe('dirty')
    await expect(
      navigation.switchVault(async () => {
        throw new Error('NOT_A_VAULT')
      }),
    ).rejects.toThrow('NOT_A_VAULT')
    session.edit('# A\n\nAfter the failed open.\n')
    expect(session.body).toBe('# A\n\nAfter the failed open.\n')
    expect(session.locked).toBe(false)
  })

  it('drops a reader read that fails after a later transition: no notice, the reader tab stays', async () => {
    net.hold(heldIds)
    const reads = net.held
    // A ticket main never granted: its read answers 404, which closes the tab while it is active.
    const toReader = navigation.openReader('made-up', 'gone.md')
    await expect.poll(() => reads.length).toBe(1)
    const toA = navigation.open('a.md', { newTab: true })
    await expect.poll(() => reads.map((read) => read.id)).toEqual(['made-up', 'a.md'])

    reads[1]?.release()
    await toA
    reads[0]?.release()
    await toReader
    expect(session.note?.id).toBe('a.md')
    expect(navigation.reader).toBeNull()
    expect(navigation.tabs.tabs.map((tab) => tab.kind)).toEqual(['reader', 'note'])
    expect(notices).toEqual([])
  })

  it('the router-backed client names the test app’s vault, whatever vault the page shows', async () => {
    setPageVault(path.join(app.dir, 'elsewhere'))
    try {
      await navigation.open('a.md')
    } finally {
      setPageVault(null)
    }
    expect(notices).toEqual([])
    expect(session.note?.id).toBe('a.md')
  })
})

describe('Navigation of scratch tabs', () => {
  /** Opens a.md, then a new scratch note in a tab after it; resolves with the scratch note's id. */
  async function scratchAfterA(): Promise<string> {
    await navigation.open('a.md')
    const created = await navigation.newScratch()
    expect(created?.shown).toBe(true)
    return created?.scratch.id ?? ''
  }

  const tab = (index: number) => navigation.tabs.tabs[index]?.key ?? -1

  it('saves the scratch tab’s text before another tab shows; the scratch read route then answers it', async () => {
    const id = await scratchAfterA()
    expect(navigation.tabs.active).toMatchObject({ kind: 'scratch', id })
    expect(session.scratch?.id).toBe(id)
    session.edit('# Idea\n\nTyped in the scratch tab.\n')

    await navigation.activate(tab(0))
    expect(session.note?.id).toBe('a.md')
    expect(session.scratch).toBeNull()
    expect((await api.readScratch(id)).text).toBe('# Idea\n\nTyped in the scratch tab.\n')

    // Shown again, it is read back with its text.
    await navigation.activate(tab(1))
    expect(session.scratch?.id).toBe(id)
    expect(session.body).toBe('# Idea\n\nTyped in the scratch tab.\n')
    expect(saved()).toEqual({ tabs: ['a.md'], active: -1, closed: [] })
    expect(notices).toEqual([])
  })

  it('keeps the scratch tab, with its text, while that text cannot be saved', async () => {
    const id = await scratchAfterA()
    session.edit('Mine.\n')
    net.fail = (url) => url.pathname === '/api/scratch/write'
    await navigation.activate(tab(0))
    expect(navigation.tabs.active).toMatchObject({ kind: 'scratch', id })
    expect(session.scratch?.id).toBe(id)
    expect(session.body).toBe('Mine.\n')
    expect(session.state).toBe('error')
    expect(notices).toEqual([UNSAVED])
  })

  it('keeps the open scratch tab and its text, without reloading it, when the vault switches and closes', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    const id = await scratchAfterA()
    const first = data.vault?.root ?? ''
    session.edit('Kept.\n')
    const docs: string[] = []
    session.addEventListener('doc', (event) => docs.push(event.body))

    expect(await navigation.switchVault(async () => (await api.openVault(other)).workspace)).toBe(true)
    const second = data.vault?.root ?? ''
    expect(navigation.tabs.tabs).toEqual([{ key: tab(0), kind: 'scratch', id }])
    expect(navigation.tabs.active?.kind).toBe('scratch')
    expect(session.scratch?.id).toBe(id)
    expect(session.body).toBe('Kept.\n')
    expect((await api.readScratch(id)).text).toBe('Kept.\n')

    session.edit('Kept.\n\nAfter the switch.\n')
    // Closing the vault on screen shows the first one again; closing that one leaves no vault.
    expect(await navigation.switchVault(() => api.closeVault(second))).toBe(true)
    expect(data.vault?.root).toBe(first)
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note', 'scratch'])
    expect(await navigation.switchVault(() => api.closeVault(first))).toBe(true)
    expect(data.vault).toBeNull()
    expect(navigation.tabs.tabs).toEqual([{ key: tab(0), kind: 'scratch', id }])
    expect(navigation.tabs.active?.kind).toBe('scratch')
    expect(session.scratch?.id).toBe(id)
    expect(session.body).toBe('Kept.\n\nAfter the switch.\n')
    expect((await api.readScratch(id)).text).toBe('Kept.\n\nAfter the switch.\n')
    expect(docs).toEqual([])
    expect(notices).toEqual([])
  })

  it('closes a scratch tab whose scratch note is gone when it is shown, with the notice', async () => {
    const id = await scratchAfterA()
    await navigation.activate(tab(0))
    await api.discardScratch(id)
    await navigation.activate(tab(1))
    expect(notices).toEqual(['This scratch note no longer exists'])
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note'])
    expect(session.note?.id).toBe('a.md')
    expect(session.locked).toBe(false)
  })

  const scratchIds = async () => (await api.listScratch()).map((item) => item.id)

  it('discards a scratch note whose text is blank when its tab closes, and keeps one with text', async () => {
    const blank = await scratchAfterA()
    session.edit('  \n')
    const kept = (await navigation.newScratch())?.scratch.id ?? ''
    expect(await scratchIds()).toEqual(expect.arrayContaining([blank, kept]))
    session.edit('Keep me.\n')

    await navigation.close()
    expect(navigation.tabs.tabs.map((item) => (item.kind === 'scratch' ? item.id : item.kind))).toEqual(['note', blank])
    expect(await scratchIds()).toEqual(expect.arrayContaining([blank, kept]))
    expect((await api.readScratch(kept)).text).toBe('Keep me.\n')

    await navigation.close()
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note'])
    expect(session.note?.id).toBe('a.md')
    expect(await scratchIds()).toEqual([kept])
    expect(navigation.tabs.closed).toEqual([])
    expect(notices).toEqual([])
  })

  it('saves text typed just before the close, so closing right after typing keeps the scratch note', async () => {
    const id = await scratchAfterA()
    session.edit('Just typed.\n')
    expect(session.state).not.toBe('saved')
    await navigation.close()
    expect(await scratchIds()).toEqual([id])
    expect((await api.readScratch(id)).text).toBe('Just typed.\n')
    expect(notices).toEqual([])
  })

  it('discards a blank scratch note when its background tab closes', async () => {
    await scratchAfterA()
    await navigation.activate(tab(0))
    await navigation.close(tab(1))
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note'])
    expect(await scratchIds()).toEqual([])
    expect(notices).toEqual([])
  })

  it('discards a blank scratch note when its active tab closes and the next tab’s read fails, leaving the editor without it', async () => {
    const id = await scratchAfterA()
    net.fail = (url) => url.pathname === '/api/notes/read'
    await navigation.close()
    net.fail = null
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note'])
    expect(session.scratch).toBeNull()
    expect(session.locked).toBe(false)
    expect(await scratchIds()).toEqual([])
    expect(notices).toEqual(['Disk full'])
    expect(id).toHaveLength(32)
  })

  it('closes the tab and keeps the scratch file, with the failure, when discarding it fails', async () => {
    const id = await scratchAfterA()
    net.fail = (url) => url.pathname === '/api/scratch/discard'
    await navigation.close()
    net.fail = null
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note'])
    expect(session.note?.id).toBe('a.md')
    expect(session.locked).toBe(false)
    expect(await scratchIds()).toEqual([id])
    expect(notices).toEqual(['Disk full'])
  })

  /** A restart of the page: a new session and navigation over the same tab store, router and vault. */
  function restart(): void {
    session.close()
    session = new NoteSession(api)
    navigation = createNavigation(store)
  }

  it('restores the last run’s scratch tabs after the vault’s note tabs, the active one with its text, dropping one whose file is gone without a notice', async () => {
    const kept = await scratchAfterA()
    session.edit('Kept text.\n')
    const gone = (await navigation.newScratch())?.scratch.id ?? ''
    await navigation.activate(tab(1))
    expect(store.scratch).toEqual({ ids: [kept, gone], active: 0 })
    await api.discardScratch(gone)

    restart()
    await navigation.restore()
    expect(navigation.tabs.tabs).toEqual([
      { key: tab(0), kind: 'note', path: 'a.md', back: [], forward: [] },
      { key: tab(1), kind: 'scratch', id: kept },
    ])
    expect(navigation.tabs.activeKey).toBe(tab(1))
    expect(session.scratch?.id).toBe(kept)
    expect(session.body).toBe('Kept text.\n')
    expect(store.scratch).toEqual({ ids: [kept], active: 0 })
    expect(saved()).toEqual({ tabs: ['a.md'], active: -1, closed: [] })
    expect(notices).toEqual([])
  })

  it('restores the last run’s scratch tabs with no vault open', async () => {
    const id = await scratchAfterA()
    session.edit('No vault.\n')
    expect(await navigation.switchVault(() => api.closeVault(data.vault?.root ?? ''))).toBe(true)
    expect(data.vault).toBeNull()

    restart()
    await navigation.restore()
    expect(navigation.tabs.tabs).toEqual([{ key: tab(0), kind: 'scratch', id }])
    expect(navigation.tabs.activeKey).toBe(tab(0))
    expect(session.scratch?.id).toBe(id)
    expect(session.body).toBe('No vault.\n')
    expect(notices).toEqual([])
  })

  /** Opens two scratch notes after a.md, with texts, then closes the vault; resolves with their ids, in order. */
  async function twoScratchNotesWithoutVault(): Promise<[string, string]> {
    const first = await scratchAfterA()
    session.edit('First.\n')
    const second = (await navigation.newScratch())?.scratch.id ?? ''
    session.edit('Second.\n')
    expect(await navigation.switchVault(() => api.closeVault(data.vault?.root ?? ''))).toBe(true)
    expect(data.vault).toBeNull()
    return [first, second]
  }

  it('activates the nearest kept scratch tab before the stored active one, with its text, when the active one’s file is gone and no note tab is restored', async () => {
    const [first, second] = await twoScratchNotesWithoutVault()
    const gone = (await navigation.newScratch())?.scratch.id ?? ''
    expect(store.scratch).toEqual({ ids: [first, second, gone], active: 2 })
    await api.discardScratch(gone)

    restart()
    await navigation.restore()
    expect(navigation.tabs.tabs).toEqual([
      { key: tab(0), kind: 'scratch', id: first },
      { key: tab(1), kind: 'scratch', id: second },
    ])
    expect(navigation.tabs.activeKey).toBe(tab(1))
    expect(session.scratch?.id).toBe(second)
    expect(session.body).toBe('Second.\n')
    expect(store.scratch).toEqual({ ids: [first, second], active: 1 })
    expect(notices).toEqual([])
  })

  it('activates the first kept scratch tab, with its text, when the stored active one is the first and its file is gone and no note tab is restored', async () => {
    const [gone, kept] = await twoScratchNotesWithoutVault()
    await api.discardScratch(gone)
    restart()
    store.scratch = { ids: [gone, kept], active: 0 }
    await navigation.restore()
    expect(navigation.tabs.tabs).toEqual([{ key: tab(0), kind: 'scratch', id: kept }])
    expect(navigation.tabs.activeKey).toBe(tab(0))
    expect(session.scratch?.id).toBe(kept)
    expect(session.body).toBe('Second.\n')
    expect(store.scratch).toEqual({ ids: [kept], active: 0 })
    expect(notices).toEqual([])
  })

  it('activates the first kept scratch tab, with its text, when none was active and no note tab is restored', async () => {
    const [first, second] = await twoScratchNotesWithoutVault()
    restart()
    store.scratch = { ids: [first, second], active: -1 }
    await navigation.restore()
    expect(navigation.tabs.tabs.map((item) => (item.kind === 'scratch' ? item.id : item.kind))).toEqual([first, second])
    expect(navigation.tabs.activeKey).toBe(tab(0))
    expect(session.scratch?.id).toBe(first)
    expect(session.body).toBe('First.\n')
    expect(notices).toEqual([])
  })

  it('keeps the restored scratch tabs once each, in their own entry, across vault switches', async () => {
    const other = await folderWith(app, 'other', { 'x.md': '# X\n' })
    const id = await scratchAfterA()
    await navigation.activate(tab(0))
    restart()
    await navigation.restore()
    expect(navigation.tabs.tabs.map((item) => item.kind)).toEqual(['note', 'scratch'])
    const first = data.vault?.root ?? ''

    expect(await navigation.switchVault(async () => (await api.openVault(other)).workspace)).toBe(true)
    const second = data.vault?.root ?? ''
    expect(navigation.tabs.tabs).toEqual([{ key: tab(0), kind: 'scratch', id }])
    expect(await navigation.switchVault(() => api.closeVault(second))).toBe(true)
    expect(data.vault?.root).toBe(first)
    expect(navigation.tabs.tabs).toEqual([
      { key: tab(0), kind: 'note', path: 'a.md', back: [], forward: [] },
      { key: tab(1), kind: 'scratch', id },
    ])
    expect(store.scratch).toEqual({ ids: [id], active: 0 })
    expect(store.saved.get(first)).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
    expect(notices).toEqual([])
  })

  it('restores every kept scratch tab, with the failure, when the scratch list cannot be read', async () => {
    const id = await scratchAfterA()
    await navigation.activate(tab(0))
    restart()
    net.fail = (url) => url.pathname === '/api/scratch'
    await navigation.restore()
    expect(navigation.tabs.tabs.map((item) => (item.kind === 'scratch' ? item.id : item.kind))).toEqual(['note', id])
    expect(session.note?.id).toBe('a.md')
    expect(notices).toEqual(['Disk full'])
  })

  it('keeps a scratch note created while the restore lists the scratch notes active, and the kept entry until the restore merged it', async () => {
    const kept = await scratchAfterA()
    restart()
    net.hold((url) => (url.pathname === '/api/scratch' ? 'list' : undefined))
    const restored = navigation.restore()
    await expect.poll(() => net.held.length).toBe(1)
    const created = await navigation.newScratch()
    expect(created?.shown).toBe(true)
    const fresh = created?.scratch.id ?? ''
    expect(store.scratch).toEqual({ ids: [kept], active: 0 })

    net.held[0]?.release()
    await restored
    net.hold(null)
    expect(navigation.tabs.tabs.map((item) => (item.kind === 'scratch' ? item.id : item.kind))).toEqual([
      'note',
      fresh,
      kept,
    ])
    expect(navigation.tabs.active).toMatchObject({ kind: 'scratch', id: fresh })
    expect(session.scratch?.id).toBe(fresh)
    expect(session.locked).toBe(false)
    expect(store.scratch).toEqual({ ids: [fresh, kept], active: 0 })
    expect(notices).toEqual([])
  })

  /**
   * Opens a scratch note after a.md, then a.md's tab, whose read fails: the editor keeps the scratch note (and takes
   * edits) while a.md's tab is active. Resolves with the scratch note's id.
   */
  async function scratchOverFailedA(): Promise<string> {
    const id = await scratchAfterA()
    net.hold(heldIds)
    const reads = net.held
    const toA = navigation.activate(tab(0))
    await expect.poll(() => reads.length).toBe(1)
    reads[0]?.release('Disk full')
    await toA
    net.hold(null)
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'a.md' })
    expect(session.scratch?.id).toBe(id)
    return id
  }

  it('saves the open scratch note before deleting another note loads the active tab’s note in its place (its read had failed)', async () => {
    const id = await scratchOverFailedA()
    session.edit('Typed after A failed.\n')
    expect(await navigation.deleteNote('c.md')).not.toBeNull()
    expect(session.note?.id).toBe('a.md')
    expect((await api.readScratch(id)).text).toBe('Typed after A failed.\n')
    expect(notices).toEqual(['Disk full'])
  })

  it('counts a move of the active tab’s note as replacing the open scratch note (its read had failed)', async () => {
    await scratchOverFailedA()
    expect(navigation.relocationReplaces((path) => path === 'a.md')).toBe(true)
    expect(navigation.relocationReplaces((path) => path === 'c.md')).toBe(false)
  })
})
