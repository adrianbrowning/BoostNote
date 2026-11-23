import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, setPageVault } from '../../src/app/actions/public/workspace/api.ts'
import { Navigation, type NavigationHost, type TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import { NoteSession } from '../../src/app/actions/public/workspace/note-session.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import type { WorkspaceData } from '../../src/app/actions/public/workspace/types.ts'
import { origin, TestApp } from './helpers.ts'

/** Tab snapshots by vault root, as the app keeps them in `localStorage`. */
class MemoryTabStore implements TabStore {
  readonly saved = new Map<string, unknown>()

  load(root: string): unknown {
    return this.saved.get(root) ?? null
  }

  save(root: string, snapshot: TabsSnapshot): void {
    this.saved.set(root, structuredClone(snapshot))
  }
}

const UNSAVED = 'This note has unsaved changes that could not be saved. Resolve them first.'

let app: TestApp
/** While set, note saves fail as if the disk were full. */
let failSaves = false
/** While set, note reads wait here until the test releases them (`release()` lets the fetch go on). */
let heldReads: { id: string; release: () => void }[] | null = null
/** The page's API client over the current test's router. */
const api = createClient(async (href, init) => {
  const url = new URL(href, origin)
  if (failSaves && url.pathname === '/api/notes/save') throw new Error('Disk full')
  if (heldReads && url.pathname === '/api/notes/read') {
    const { promise, resolve } = Promise.withResolvers<void>()
    heldReads.push({ id: url.searchParams.get('id') ?? '', release: resolve })
    await promise
  }
  return app.fetch(href, init)
})
let folder: string
let data: WorkspaceData
let store: MemoryTabStore
let notices: string[]
let session: NoteSession
let navigation: Navigation

/** Writes `files` into a new folder `name` of the test app's temp dir. */
async function folderWith(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(app.dir, name)
  for (const [id, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, id)), { recursive: true })
    await writeFile(path.join(dir, id), body)
  }
  return dir
}

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
  failSaves = false
  heldReads = null
  folder = await folderWith('vault', { 'a.md': '# A\n', 'b.md': '# B\n', 'c.md': '# C\n', 'f/n.md': '# N\n' })
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
    failSaves = true
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
    await navigation.select(-1)
    expect(session.note?.id).toBe('c.md')

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

  it('refuses to delete the open note while its save fails: the note stays on disk, open, with its edits', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\nMine.\n')
    failSaves = true
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

  it('deletes the open note after saving it: its tab closes and the next tab’s note opens', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    expect(await navigation.deleteNote('b.md')).not.toBeNull()
    await expect(access(path.join(folder, 'b.md'))).rejects.toThrow()
    expect(session.note?.id).toBe('a.md')
    expect(saved()).toEqual({ tabs: ['a.md'], active: 0, closed: [] })
  })

  it('switches vaults, keeping each vault’s tabs under its root and counting the other vault’s tabs', async () => {
    const other = await folderWith('other', { 'x.md': '# X\n' })
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
    failSaves = true
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

  it('rejects a vault switch whose tab restore fails, so the caller’s error handling sees it', async () => {
    const other = await folderWith('other', { 'x.md': '# X\n' })
    // Like `localStorage.setItem` over its quota: saving the restored tabs after `change` throws.
    navigation = createNavigation({
      load: () => null,
      save: () => {
        throw new Error('QuotaExceededError')
      },
    })
    const switched = navigation.switchVault(
      async () => (await api.openVault(other)).workspace,
      (tabs) => tabs.openNew('x.md'),
    )
    await expect(switched).rejects.toThrow('QuotaExceededError')
  })

  it('drops a read that returns after a later transition: the session shows the active tab’s note', async () => {
    const reads: { id: string; release: () => void }[] = []
    heldReads = reads
    const toA = navigation.open('a.md')
    await expect.poll(() => reads.length).toBe(1)
    const toB = navigation.open('b.md', { newTab: true })
    await expect.poll(() => reads.map((read) => read.id)).toEqual(['a.md', 'b.md'])

    // B's read returns first, then A's.
    reads[1]?.release()
    await toB
    reads[0]?.release()
    await toA
    expect(session.note?.id).toBe('b.md')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'b.md' })
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
