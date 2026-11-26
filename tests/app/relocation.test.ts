import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../../src/app/actions/public/workspace/api.ts'
import { Navigation, type TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import { type DocEvent, NoteSession } from '../../src/app/actions/public/workspace/note-session.ts'
import { type LinksQuestion, Relocation } from '../../src/app/actions/public/workspace/relocation.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import type { WorkspaceData } from '../../src/app/actions/public/workspace/types.ts'
import { exists, folderWith, type HeldClient, heldClient, TestApp } from './helpers.ts'

/**
 * `Relocation` over the in-process router (`createClient` over `TestApp.fetch`, requests held by `heldClient`), a
 * real `NoteSession` and `Navigation`, and a host that records notices and link questions.
 */

const UNSAVED = 'This note has unsaved changes that could not be saved. Resolve them first.'

let app: TestApp
let net: HeldClient
let api: Client
let vault: string
let data: WorkspaceData
let snapshots: Map<string, TabsSnapshot>
let notices: Array<{ kind: 'error' | 'info'; text: string }>
/** The link questions asked, oldest first, each with its answer. */
let questions: Array<{ question: LinksQuestion; answer(ok: boolean): void }>
/** While set, the host's list refresh fails with this message. */
let refreshFails: string | undefined
let docs: DocEvent[]
let session: NoteSession
let navigation: Navigation
let relocation: Relocation

/** Holds the requests to API path `pathname` (by that path). */
const onPath = (pathname: string) => (url: URL) => (url.pathname === pathname ? pathname : undefined)

/** While set, saving tabs to the store throws with this message (`localStorage` over its quota). */
let storeFails: string | undefined
const store: TabStore = {
  load: (root) => snapshots.get(root) ?? null,
  save: (root, snapshot) => {
    if (storeFails !== undefined) throw new DOMException(storeFails, 'QuotaExceededError')
    snapshots.set(root, structuredClone(snapshot))
  },
  loadScratch: () => null,
  saveScratch: () => {},
}

beforeEach(async () => {
  app = await TestApp.create()
  net = heldClient(app)
  api = net.client
  vault = await folderWith(app, 'vault', {
    'a.md': '# A\n\n[b](./b.md)\n',
    'b.md': '# B\n',
    'c.md': '# C\n',
    'linker.md': '# Linker\n\n[a](./a.md) [c](./c.md) [m](./meeting.md)\n',
    'meeting.md': '# Meeting notes\n',
    'g/x.md': '# X\n\n[b](../b.md)\n',
    'h/y.md': '# Y\n',
  })
  await app.openVault('vault')
  data = await api.workspace()
  snapshots = new Map()
  notices = []
  questions = []
  refreshFails = undefined
  storeFails = undefined
  docs = []
  session = new NoteSession(api)
  session.addEventListener('doc', (event) => docs.push(event))
  navigation = new Navigation({
    session,
    api,
    store,
    host: {
      root: () => data.vault?.root,
      hasNote: (id) => data.notes.some((note) => note.id === id),
      showVault: (next) => {
        data = next
      },
      notify: (kind, text) => notices.push({ kind, text }),
      fail: (error) => notices.push({ kind: 'error', text: error instanceof Error ? error.message : String(error) }),
      changed: () => {},
      scratchChanged: async () => {},
    },
  })
  relocation = new Relocation({
    session,
    navigation,
    api,
    host: {
      folderName: (id) => id.split('/').at(-1) ?? id,
      folderMoved: () => {},
      refresh: async () => {
        if (refreshFails !== undefined) throw new Error(refreshFails)
        data = await api.workspace()
      },
      notify: (kind, text) => notices.push({ kind, text }),
      askLinks: (question) => {
        const { promise, resolve } = Promise.withResolvers<boolean>()
        questions.push({ question, answer: resolve })
        return promise
      },
    },
  })
})

afterEach(async () => {
  session.close()
  await app.close()
})

describe('Relocation: the open note after it moved', () => {
  it('takes the links the vault rebased, keeping the selection, and saves them with the next edit', async () => {
    await navigation.open('a.md')
    docs.length = 0
    const moving = relocation.moveNote('a.md', 'g')
    // linker.md links to a.md: the move asks about it.
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await moving
    expect(session.note?.id).toBe('g/a.md')
    expect(session.body).toBe('# A\n\n[b](../b.md)\n')
    expect(docs.map((event) => [event.body, event.preserveSelection])).toEqual([['# A\n\n[b](../b.md)\n', true]])
    session.edit('# A\n\n[b](../b.md)\n\nMore.\n')
    expect(await session.flush()).toBe(true)
    expect((await api.readNote('g/a.md')).body).toBe('# A\n\n[b](../b.md)\n\nMore.\n')
  })

  it('follows a note of the moved folder that was opened while the move was out', async () => {
    await navigation.open('a.md')
    net.hold(onPath('/api/folders/move'))
    const moving = relocation.moveFolder('g', 'h')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.open('g/x.md')
    docs.length = 0
    net.held[0]?.release()
    await moving
    // Followed in the move (retarget, read again, relocated: the editor keeps its selection), not reloaded after it.
    expect(docs.map((event) => [event.body, event.preserveSelection])).toEqual([['# X\n\n[b](../../b.md)\n', true]])
    expect(session.note).toMatchObject({ id: 'h/g/x.md', body: '# X\n\n[b](../../b.md)\n' })
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'h/g/x.md' })
  })

  it('loads the renamed note into the active tab when its read was out as the rename landed', async () => {
    await navigation.open('a.md')
    net.hold((url) =>
      url.pathname === '/api/notes/rename' || url.searchParams.get('id') === 'h/y.md' ? url.pathname : undefined,
    )
    const renaming = relocation.renameNote('h/y.md', 'renamed')
    await expect.poll(() => net.held.length).toBe(1)
    const opening = navigation.open('h/y.md')
    await expect.poll(() => net.held.length).toBe(2)
    net.held[0]?.release()
    await renaming
    net.held[1]?.release()
    await opening
    expect(session.note).toMatchObject({ id: 'h/renamed.md', body: '# Y\n' })
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'h/renamed.md' })
  })

  it('follows the open note through a second folder move that lands while the first one reads it again', async () => {
    await api.createFolder('', 'k')
    await navigation.open('g/x.md')
    net.hold((url) =>
      url.pathname === '/api/notes/read' && url.searchParams.get('id') === 'h/g/x.md' ? 'read' : undefined,
    )
    const first = relocation.moveFolder('g', 'h')
    await expect.poll(() => net.held.length).toBe(1)
    const second = relocation.moveFolder('h', 'k')
    // The second move landed (its list refresh shows the note's last place) while the first one's read is out.
    await expect.poll(() => data.notes.some((note) => note.id === 'k/h/g/x.md')).toBe(true)
    net.held[0]?.release()
    await Promise.all([first, second])
    expect(session.note).toMatchObject({ id: 'k/h/g/x.md', body: '# X\n\n[b](../../../b.md)\n' })
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'k/h/g/x.md' })
    expect(notices).toEqual([])
  })

  it('keeps the open note at its new place when a live reload’s read of its old place returns 404 after the folder moved', async () => {
    await writeFile(path.join(vault, 'g/z.md'), '# Z\n')
    data = await api.workspace()
    await navigation.open('g/x.md')
    net.fail = (url) => url.searchParams.get('id') === 'g/z.md'
    await navigation.open('g/z.md', { newTab: true })
    net.fail = null
    // An outside edit: the live reload's read of g/x.md (held[0]) is out when g moves; the move's load of the active
    // tab at h/g/z.md (held[1]) is out after the open note followed to h/g/x.md.
    await writeFile(path.join(vault, 'g/x.md'), '# X, edited\n\n[b](../b.md)\n')
    net.hold((url) => {
      const id = url.searchParams.get('id')
      return url.pathname === '/api/notes/read' && (id === 'g/x.md' || id === 'h/g/z.md') ? id : undefined
    })
    const reloading = session.externalChange()
    await expect.poll(() => net.held.length).toBe(1)
    const moving = relocation.moveFolder('g', 'h')
    await expect.poll(() => net.held.length).toBe(2)
    expect(session.note?.id).toBe('h/g/x.md')
    net.held[0]?.release()
    await reloading
    net.held[1]?.release('Disk full')
    await moving
    expect(session.state).not.toBe('removed')
    expect(session.note).toMatchObject({ id: 'h/g/x.md', body: '# X, edited\n\n[b](../../b.md)\n' })
  })
})

describe('Relocation: link questions', () => {
  it('asks the questions of two renames in a row in order, and applies both answers', async () => {
    await navigation.open('b.md')
    net.hold(onPath('/api/links/plan'))
    const first = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => net.held.length).toBe(1)
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    const second = relocation.renameNote('c.md', 'c2')
    await expect.poll(() => data.notes.some((note) => note.id === 'c2.md')).toBe(true)
    // The second question waits for the first answer: its links are not even planned yet.
    expect(net.held).toHaveLength(1)
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(2)
    net.held[1]?.release()
    await expect.poll(() => questions.length).toBe(2)
    questions[1]?.answer(true)
    await Promise.all([first, second])
    expect(questions.map(({ question }) => question.message)).toEqual([
      '1 link in 1 note points to “a”.',
      '1 link in 1 note points to “c”.',
    ])
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c2.md) [m](./meeting.md)\n',
    )
  })

  it('asks in the order the renames landed, even when the first one’s refresh is slower', async () => {
    await navigation.open('b.md')
    net.hold(onPath('/api/workspace'), { once: true })
    const one = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => net.held.length).toBe(1)
    const two = relocation.renameNote('c.md', 'c2')
    await expect.poll(() => data.notes.some((note) => note.id === 'c2.md')).toBe(true)
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    expect(questions[0]?.question.message).toBe('1 link in 1 note points to “a”.')
    questions[0]?.answer(true)
    await expect.poll(() => questions.length).toBe(2)
    expect(questions[1]?.question.message).toBe('1 link in 1 note points to “c”.')
    questions[1]?.answer(true)
    await Promise.all([one, two])
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c2.md) [m](./meeting.md)\n',
    )
  })

  it('does not update the links when the open note cannot be saved first: the leave-note notice shows', async () => {
    await navigation.open('b.md')
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.fail = (url) => url.pathname === '/api/notes/save'
    session.edit('# B\n\nTyped while asked.\n')
    questions[0]?.answer(true)
    await renaming
    expect(notices).toContainEqual({ kind: 'error', text: UNSAVED })
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a.md) [c](./c.md) [m](./meeting.md)\n',
    )
  })
})

describe('Relocation: two reads of the open note at once', () => {
  it('keeps the newer read when an older one, of a link update, returns after it', async () => {
    await navigation.open('linker.md')
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    // The update's read of the open note is answered at once and returns late.
    net.hold(
      (url) => (url.pathname === '/api/notes/read' && url.searchParams.get('id') === 'linker.md' ? 'read' : undefined),
      {
        answered: true,
        once: true,
      },
    )
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(1)
    // A title rename rewrites the open note's links again, and reads it again, while that read is out.
    await relocation.applyTitleRenames([{ from: 'meeting.md', to: 'Meeting notes.md', title: 'Meeting notes' }])
    net.held[0]?.release()
    await renaming
    const disk = await api.readNote('linker.md')
    expect(disk.body).toBe('# Linker\n\n[a](./a2.md) [c](./c.md) [m](./Meeting%20notes.md)\n')
    expect(session.body).toBe(disk.body)
    expect(session.note?.hash).toBe(disk.hash)
  })

  it('keeps an outside edit read after a link update’s read of the open note that returns after it', async () => {
    await navigation.open('linker.md')
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.hold(
      (url) => (url.pathname === '/api/notes/read' && url.searchParams.get('id') === 'linker.md' ? 'read' : undefined),
      {
        answered: true,
        once: true,
      },
    )
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(1)
    // An agent edits the note while the update's read is out: the live reload reads it again and returns first.
    await writeFile(path.join(vault, 'linker.md'), '# Linker, edited\n\n[a](./a2.md)\n')
    await session.externalChange()
    net.held[0]?.release()
    await renaming
    const disk = await api.readNote('linker.md')
    expect(disk.body).toBe('# Linker, edited\n\n[a](./a2.md)\n')
    expect(session.body).toBe(disk.body)
    expect(session.note?.hash).toBe(disk.hash)
  })

  it('keeps a link update’s read of the open note when an outside edit’s older read returns after it', async () => {
    await navigation.open('linker.md')
    await writeFile(path.join(vault, 'linker.md'), '# Linker, edited\n\n[a](./a.md)\n')
    net.hold(
      (url) => (url.pathname === '/api/notes/read' && url.searchParams.get('id') === 'linker.md' ? 'read' : undefined),
      { answered: true },
    )
    // The live reload's read of the outside edit is out while a rename's link update rewrites the note again.
    const reloading = session.externalChange()
    await expect.poll(() => net.held.length).toBe(1)
    const reload = net.held[0]
    net.hold(null)
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(true)
    await renaming
    reload?.release()
    await reloading
    const disk = await api.readNote('linker.md')
    expect(disk.body).toBe('# Linker, edited\n\n[a](./a2.md)\n')
    expect(session.body).toBe(disk.body)
    expect(session.note?.hash).toBe(disk.hash)
  })
})

describe('Relocation: an image saved while the open note moves', () => {
  it('links the image into the new place when the vault refused it after the rename ran but before the app took its answer', async () => {
    await navigation.open('a.md')
    const statuses: number[] = []
    const fetch = app.fetch
    vi.spyOn(app, 'fetch').mockImplementation(async (href, init) => {
      const response = await fetch(href, init)
      if (href.startsWith('/api/assets')) statuses.push(response.status)
      return response
    })
    net.hold(onPath('/api/assets'))
    const saving = session.saveAsset(new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' }))
    await expect.poll(() => net.held.length).toBe(1)
    const upload = net.held[0]
    // The vault runs the rename at once; its answer waits.
    net.hold(onPath('/api/notes/rename'), { answered: true })
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => net.held.length).toBe(1)
    const rename = net.held[0]
    net.hold(null)
    upload?.release()
    // The upload for a.md is refused (a.md is gone) before the app takes the rename's answer.
    await expect.poll(() => statuses).toEqual([404])
    rename?.release()
    const href = await saving
    expect(href).toMatch(/^\.\/a2\.assets\/[0-9a-f]+\.png$/)
    expect(await readFile(path.join(vault, href))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readdir(vault)).not.toContain('a.assets')
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await renaming
  })
})

describe('Relocation after a vault switch', () => {
  it('skips the refresh and the link question of a rename that returns once another vault shows', async () => {
    const other = await realpath(
      await folderWith(app, 'other', { 'a.md': '# Other A\n', 'linker.md': '# L\n\n[a](./a.md)\n' }),
    )
    snapshots.set(other, { tabs: ['a.md'], active: 0, closed: [] })
    await navigation.open('a.md')
    const paths: string[] = []
    net.hold((url) => {
      paths.push(url.pathname)
      return url.pathname === '/api/notes/rename' ? url.pathname : undefined
    })
    const renaming = relocation.renameNote('a.md', 'renamed')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    paths.length = 0
    net.held[0]?.release()
    await renaming
    // No list refresh, no link plan: they would read the vault on screen, which is not the one renamed in.
    expect(paths).toEqual([])
    expect(questions).toEqual([])
    expect(notices).toEqual([])
    expect(session.note).toMatchObject({ id: 'a.md', body: '# Other A\n' })
    expect(navigation.tabs.tabs.map((tab) => tab.kind === 'note' && tab.path)).toEqual(['a.md'])
    expect(snapshots.get(other)?.tabs).toEqual(['a.md'])
  })

  it('shows no assets-left-behind warning of a rename that returns once another vault shows', async (ctx) => {
    // a.MD beside a.md keeps the shared a.assets: renaming a.md leaves it behind, which the rename's notice says.
    // Skipped where the file system folds a.MD into a.md (`pnpm test:case-sensitive` runs it on macOS).
    await writeFile(path.join(vault, 'a.MD'), '# Upper A\n')
    if (!(await readdir(vault)).includes('a.MD')) ctx.skip()
    await mkdir(path.join(vault, 'a.assets'))
    await writeFile(path.join(vault, 'a.assets', 'x.png'), 'X')
    const other = await realpath(await folderWith(app, 'other', { 'o.md': '# O\n' }))
    snapshots.set(other, { tabs: ['o.md'], active: 0, closed: [] })
    await navigation.open('b.md')
    net.hold(onPath('/api/notes/rename'))
    const renaming = relocation.renameNote('a.md', 'renamed')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    net.held[0]?.release()
    await renaming
    expect(await readdir(vault)).toContain('a.assets')
    expect(notices).toEqual([])
  })

  it('still asks the next vault’s link questions after a rename whose refresh returned once that vault showed', async () => {
    const other = await realpath(await folderWith(app, 'other', { 'x.md': '# X\n', 'l.md': '# L\n\n[x](./x.md)\n' }))
    snapshots.set(other, { tabs: ['l.md'], active: 0, closed: [] })
    await navigation.open('b.md')
    net.hold(onPath('/api/workspace'), { once: true })
    // The rename landed in this vault (its link question has its place in the order); its refresh is out.
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    net.held[0]?.release()
    await renaming
    expect(questions).toEqual([])
    const next = relocation.renameNote('x.md', 'x2')
    await expect.poll(() => questions.length).toBe(1)
    expect(questions[0]?.question.message).toBe('1 link in 1 note points to “x”.')
    questions[0]?.answer(true)
    await next
    expect(await readFile(path.join(other, 'l.md'), 'utf8')).toBe('# L\n\n[x](./x2.md)\n')
  })

  it('leaves the other vault’s tabs alone when it is switched to while a folder move reads the open note again', async () => {
    const first = data.vault?.root ?? ''
    const other = await realpath(await folderWith(app, 'other', { 'g/x.md': '# Other X\n' }))
    snapshots.set(other, { tabs: ['g/x.md'], active: 0, closed: [] })
    await navigation.open('g/x.md')
    // Only the first vault's reads wait: the read of the moved open note.
    net.hold((url) =>
      url.pathname === '/api/notes/read' && url.searchParams.get('vault') === first ? url.pathname : undefined,
    )
    const moving = relocation.moveFolder('g', 'h')
    await expect.poll(() => net.held.length).toBe(1)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    net.held[0]?.release()
    await moving
    expect(session.note).toMatchObject({ id: 'g/x.md', body: '# Other X\n' })
    expect(navigation.tabs.tabs.map((tab) => tab.kind === 'note' && tab.path)).toEqual(['g/x.md'])
    expect(snapshots.get(other)?.tabs).toEqual(['g/x.md'])
  })

  /** Opens b.md in this vault, and gives another vault with a tab of its own. */
  async function otherVault(): Promise<string> {
    const other = await realpath(await folderWith(app, 'other', { 'o.md': '# O\n' }))
    snapshots.set(other, { tabs: ['o.md'], active: 0, closed: [] })
    await navigation.open('b.md')
    return other
  }

  it('shows no link-update result once another vault shows while the refresh after the update is out', async () => {
    const other = await otherVault()
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.hold(onPath('/api/workspace'))
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(1)
    net.hold(null)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    net.held[0]?.release()
    await renaming
    expect(notices).toEqual([])
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c.md) [m](./meeting.md)\n',
    )
  })

  it('shows no link-update failure once another vault shows while the update is out', async () => {
    const other = await otherVault()
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.hold(onPath('/api/links/apply'))
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(1)
    net.hold(null)
    await navigation.switchVault(async () => (await api.openVault(other)).workspace)
    net.held[0]?.release('Disk full')
    await renaming
    expect(notices).toEqual([])
  })
})

describe('Relocation: title renames', () => {
  const renames = [{ from: 'meeting.md', to: 'Meeting notes.md', title: 'Meeting notes' }]

  it('keep the renamed open note in the editor as it is (no reload that resets its cursor and undo)', async () => {
    await navigation.open('meeting.md')
    docs.length = 0
    expect(await relocation.applyTitleRenames(renames)).toMatchObject({ renamed: renames })
    expect(session.note?.id).toBe('Meeting notes.md')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'Meeting notes.md' })
    expect(docs).toEqual([])
  })

  it('give the open note the links they rewrote, keeping its cursor and undo', async () => {
    await navigation.open('linker.md')
    docs.length = 0
    await relocation.applyTitleRenames(renames)
    const rewritten = '# Linker\n\n[a](./a.md) [c](./c.md) [m](./Meeting%20notes.md)\n'
    expect(session.body).toBe(rewritten)
    expect(docs.map((event) => [event.body, event.preserveSelection])).toEqual([[rewritten, true]])
  })

  it('report what they did when the refresh after them fails, with a could-not-refresh notice', async () => {
    await navigation.open('meeting.md')
    refreshFails = 'Disk full'
    expect(await relocation.applyTitleRenames(renames)).toMatchObject({ renamed: renames })
    expect(session.note?.id).toBe('Meeting notes.md')
    expect(notices).toEqual([{ kind: 'error', text: 'Could not refresh: Disk full' }])
  })
})

/**
 * The active tab's read failed (not a `404`): the session still shows `a.md`, which the user edits; then `c.md`,
 * the active tab's note, is renamed, so the tab's note loads at its new place over `a.md`.
 */
async function editWhileActiveTabFailed(): Promise<void> {
  await navigation.open('a.md')
  net.fail = (url) => url.searchParams.get('id') === 'c.md'
  await navigation.open('c.md', { newTab: true })
  net.fail = null
  notices.length = 0
  expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'c.md' })
  expect(session.note?.id).toBe('a.md')
  session.edit('# A\n\nMine.\n')
}

describe('Relocation: the leave-note gate when the move loads the active tab over the open note', () => {
  it('saves the open note before the renamed active tab loads over it', async () => {
    await editWhileActiveTabFailed()
    const renaming = relocation.renameNote('c.md', 'c2')
    // linker.md links to c.md: the rename asks about it.
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await renaming
    expect((await api.readNote('a.md')).body).toBe('# A\n\nMine.\n')
    expect(session.note).toMatchObject({ id: 'c2.md', body: '# C\n' })
    expect(notices).toEqual([])
  })

  it('renames nothing, with the leave-note notice, when the open note cannot be saved first: it keeps its edits', async () => {
    await editWhileActiveTabFailed()
    net.fail = (url) => url.pathname === '/api/notes/save'
    await relocation.renameNote('c.md', 'c2')
    net.fail = null
    expect(notices).toEqual([{ kind: 'error', text: UNSAVED }])
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'c.md' })
    expect(await readFile(path.join(vault, 'c.md'), 'utf8')).toBe('# C\n')
  })

  it('moves no folder, with the leave-note notice, when it holds the active tab and the open note cannot be saved', async () => {
    await navigation.open('a.md')
    net.fail = (url) => url.searchParams.get('id') === 'g/x.md'
    await navigation.open('g/x.md', { newTab: true })
    session.edit('# A\n\nMine.\n')
    notices.length = 0
    net.fail = (url) => url.pathname === '/api/notes/save'
    await relocation.moveFolder('g', 'h')
    net.fail = null
    expect(notices).toEqual([{ kind: 'error', text: UNSAVED }])
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
    expect(await readFile(path.join(vault, 'g/x.md'), 'utf8')).toBe('# X\n\n[b](../b.md)\n')
  })

  it('saves the open note before the moved active tab loads over it', async () => {
    await editWhileActiveTabFailed()
    const moving = relocation.moveNote('c.md', 'h')
    // linker.md links to c.md: the move asks about it.
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await moving
    expect((await api.readNote('a.md')).body).toBe('# A\n\nMine.\n')
    expect(session.note).toMatchObject({ id: 'h/c.md', body: '# C\n' })
  })

  it('moves nothing, with the leave-note notice, when the open note cannot be saved first: it keeps its edits', async () => {
    await editWhileActiveTabFailed()
    net.fail = (url) => url.pathname === '/api/notes/save'
    await relocation.moveNote('c.md', 'h')
    net.fail = null
    expect(notices).toEqual([{ kind: 'error', text: UNSAVED }])
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'c.md' })
    expect(await readFile(path.join(vault, 'c.md'), 'utf8')).toBe('# C\n')
  })

  it('renames a note that neither the open note nor the active tab shows, though the open note cannot be saved', async () => {
    await editWhileActiveTabFailed()
    net.fail = (url) => url.pathname === '/api/notes/save'
    const renaming = relocation.renameNote('meeting.md', 'meeting2')
    // linker.md links to meeting.md: the rename asks about it.
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await renaming
    net.fail = null
    expect(notices).toEqual([])
    expect(session.note?.id).toBe('a.md')
    expect(session.body).toBe('# A\n\nMine.\n')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'c.md' })
    expect(await readFile(path.join(vault, 'meeting2.md'), 'utf8')).toBe('# Meeting notes\n')
  })
})

describe('Relocation: the gate before the vault operation', () => {
  it('saves the open note’s edit before moving it: the moved note has the edit and the rebased link', async () => {
    await navigation.open('a.md')
    session.edit('# A\n\n[b](./b.md)\n\nTyped.\n')
    const moving = relocation.moveNote('a.md', 'g')
    // linker.md links to a.md: the move asks about it.
    await expect.poll(() => questions.length).toBe(1)
    questions[0]?.answer(false)
    await moving
    expect((await api.readNote('g/a.md')).body).toBe('# A\n\n[b](../b.md)\n\nTyped.\n')
    expect(session.body).toBe('# A\n\n[b](../b.md)\n\nTyped.\n')
  })

  it.each([
    { what: 'renames the open note', open: 'a.md', run: () => relocation.renameNote('a.md', 'a2'), to: 'a2.md' },
    { what: 'moves the open note', open: 'a.md', run: () => relocation.moveNote('a.md', 'g'), to: 'g/a.md' },
    {
      what: 'moves the folder of the open note',
      open: 'g/x.md',
      run: () => relocation.moveFolder('g', 'h'),
      to: 'h/g/x.md',
    },
  ])(
    'refuses when it $what and the open note cannot be saved first: the leave-note notice, nothing relocated',
    async ({ open, run, to }) => {
      await navigation.open(open)
      net.fail = (url) => url.pathname === '/api/notes/save'
      session.edit(`${session.body}\nTyped.\n`)
      await run()
      net.fail = null
      expect(notices).toContainEqual({ kind: 'error', text: UNSAVED })
      expect(await exists(vault, open)).toBe(true)
      expect(await exists(vault, to)).toBe(false)
      expect(questions).toEqual([])
    },
  )
})

describe('Relocation when the vault succeeded but the app could not catch up', () => {
  it('still asks about the links of a rename whose tabs cannot be saved afterwards, with a notice', async () => {
    await navigation.open('b.md')
    storeFails = 'The quota has been exceeded.'
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    expect(notices).toEqual([{ kind: 'error', text: 'Could not refresh: The quota has been exceeded.' }])
    storeFails = undefined
    questions[0]?.answer(true)
    await renaming
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c.md) [m](./meeting.md)\n',
    )
  })

  it('reports title renames whose tabs cannot be saved afterwards, with a notice', async () => {
    await navigation.open('meeting.md')
    storeFails = 'The quota has been exceeded.'
    const renames = [{ from: 'meeting.md', to: 'Meeting notes.md', title: 'Meeting notes' }]
    expect(await relocation.applyTitleRenames(renames)).toMatchObject({ renamed: renames })
    expect(notices).toEqual([{ kind: 'error', text: 'Could not refresh: The quota has been exceeded.' }])
  })

  it('shows the links as updated when the tabs changed during the update cannot be saved, with a notice', async () => {
    await navigation.open('b.md')
    await navigation.open('c.md', { newTab: true })
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.hold(onPath('/api/links/apply'))
    questions[0]?.answer(true)
    await expect.poll(() => net.held.length).toBe(1)
    // A background tab closes while the update is out; the tab store is full by the time it is done.
    await navigation.close(navigation.tabs.tabs[0]?.key)
    storeFails = 'The quota has been exceeded.'
    net.held[0]?.release()
    await renaming
    expect(notices.at(-1)).toEqual({
      kind: 'error',
      text: 'Updated 1 link. Could not refresh: The quota has been exceeded.',
    })
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c.md) [m](./meeting.md)\n',
    )
  })

  it('shows the move with a could-not-refresh notice when the refresh fails, and still asks about the links', async () => {
    refreshFails = 'Disk full'
    const moving = relocation.moveNote('a.md', 'g')
    await expect.poll(() => questions.length).toBe(1)
    expect(notices).toEqual([{ kind: 'error', text: 'Moved to g. Could not refresh: Disk full' }])
    questions[0]?.answer(false)
    await moving
  })

  it('shows the move with a could-not-refresh notice when the note opened while it was out cannot be read at its new place', async () => {
    await navigation.open('a.md')
    net.hold((url) =>
      url.pathname === '/api/notes/move' || url.searchParams.get('id') === 'c.md' ? url.pathname : undefined,
    )
    const moving = relocation.moveNote('c.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    const opening = navigation.open('c.md')
    await expect.poll(() => net.held.length).toBe(2)
    net.fail = (url) => url.searchParams.get('id') === 'g/c.md'
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'g/c.md' })
    expect(notices).toEqual([{ kind: 'error', text: 'Moved to g. Could not refresh: Disk full' }])
    questions[0]?.answer(false)
    await moving
    net.held[1]?.release()
    await opening
  })

  it('shows the move with a could-not-refresh notice when the note opened while it was out is gone at its new place', async () => {
    await navigation.open('a.md')
    net.hold((url) =>
      url.pathname === '/api/notes/move' || url.searchParams.get('id') === 'c.md' ? url.pathname : undefined,
    )
    const moving = relocation.moveNote('c.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    const opening = navigation.open('c.md', { newTab: true })
    await expect.poll(() => net.held.length).toBe(2)
    net.gone.add('g/c.md')
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'a.md' })
    expect(session.note?.id).toBe('a.md')
    expect(notices).toEqual([{ kind: 'error', text: 'Moved to g. Could not refresh: Note not found: g/c.md' }])
    questions[0]?.answer(false)
    await moving
    net.held[1]?.release()
    await opening
  })

  it('shows only the move with the first could-not-refresh notice when the tab loaded next is gone too', async () => {
    await navigation.open('a.md')
    await navigation.open('b.md', { newTab: true })
    await navigation.select(0)
    net.hold((url) =>
      url.pathname === '/api/notes/move' || url.searchParams.get('id') === 'c.md' ? url.pathname : undefined,
    )
    const moving = relocation.moveNote('c.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    const opening = navigation.open('c.md', { newTab: true })
    await expect.poll(() => net.held.length).toBe(2)
    net.gone.add('g/c.md')
    net.gone.add('b.md')
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'a.md' })
    expect(session.note?.id).toBe('a.md')
    expect(notices).toEqual([{ kind: 'error', text: 'Moved to g. Could not refresh: Note not found: g/c.md' }])
    questions[0]?.answer(false)
    await moving
    net.held[1]?.release()
    await opening
  })

  it('shows a could-not-refresh notice when the open note cannot be read again after its folder moved, and its next save cannot overwrite the moved note', async () => {
    await navigation.open('g/x.md')
    net.fail = (url) => url.pathname === '/api/notes/read'
    await relocation.moveFolder('g', 'h')
    expect(navigation.tabs.active).toMatchObject({ kind: 'note', path: 'h/g/x.md' })
    expect(notices).toContainEqual({ kind: 'error', text: 'Could not refresh: Disk full' })
    net.fail = null
    // The editor still has the text from before the move; the vault rebased the note's link meanwhile.
    expect(session.note?.id).toBe('h/g/x.md')
    session.edit('# X\n\n[b](../b.md)\n\nMine.\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('conflict')
    expect(session.theirs?.body).toBe('# X\n\n[b](../../b.md)\n')
    expect(await readFile(path.join(vault, 'h/g/x.md'), 'utf8')).toBe('# X\n\n[b](../../b.md)\n')
  })

  it('shows only the move with the first could-not-refresh notice when the reader tab loaded next cannot be read', async () => {
    const outside = path.join(await folderWith(app, 'outside', { 'outside.md': '# Outside\n' }), 'outside.md')
    const ticket = await app.vaults.readers.grant(await realpath(outside))
    if (ticket === undefined) throw new Error('No reader ticket for outside.md')
    await navigation.open('a.md')
    await navigation.openReader(ticket, 'outside.md')
    await navigation.select(0)
    net.hold((url) =>
      url.pathname === '/api/notes/move' || url.searchParams.get('id') === 'c.md' ? url.pathname : undefined,
    )
    const moving = relocation.moveNote('c.md', 'g')
    await expect.poll(() => net.held.length).toBe(1)
    const opening = navigation.open('c.md', { newTab: true })
    await expect.poll(() => net.held.length).toBe(2)
    net.gone.add('g/c.md')
    // The reader tab becomes active once g/c.md's tab closes; its read fails.
    net.fail = (url) => url.pathname.startsWith('/api/reader/')
    net.held[0]?.release()
    await expect.poll(() => questions.length).toBe(1)
    net.fail = null
    expect(navigation.tabs.active).toMatchObject({ kind: 'reader', ticket })
    expect(notices).toEqual([{ kind: 'error', text: 'Moved to g. Could not refresh: Note not found: g/c.md' }])
    questions[0]?.answer(false)
    await moving
    net.held[1]?.release()
    await opening
  })

  it('shows the links as updated, with a could-not-refresh notice, when the refresh after the update fails', async () => {
    await navigation.open('b.md')
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    refreshFails = 'Disk full'
    questions[0]?.answer(true)
    await renaming
    expect(notices.at(-1)).toEqual({ kind: 'error', text: 'Updated 1 link. Could not refresh: Disk full' })
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c.md) [m](./meeting.md)\n',
    )
    // The next relocation's question is still asked.
    refreshFails = undefined
    const next = relocation.renameNote('c.md', 'c2')
    await expect.poll(() => questions.length).toBe(2)
    questions[1]?.answer(false)
    await next
  })

  it('shows the links as updated, with a could-not-refresh notice, when the rewritten open note cannot be read', async () => {
    await navigation.open('linker.md')
    const renaming = relocation.renameNote('a.md', 'a2')
    await expect.poll(() => questions.length).toBe(1)
    net.fail = (url) => url.pathname === '/api/notes/read'
    questions[0]?.answer(true)
    await renaming
    net.fail = null
    expect(notices.at(-1)).toEqual({ kind: 'error', text: 'Updated 1 link. Could not refresh: Disk full' })
    expect(await readFile(path.join(vault, 'linker.md'), 'utf8')).toBe(
      '# Linker\n\n[a](./a2.md) [c](./c.md) [m](./meeting.md)\n',
    )
  })
})
