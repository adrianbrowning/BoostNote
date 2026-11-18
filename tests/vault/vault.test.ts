import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

const read = (rel: string) => readFile(path.join(root, rel), 'utf8')

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-test-'))
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

describe('vault notes', () => {
  it('lists the tree and reads notes with metadata', async () => {
    await put('inbox.md', '# Inbox\n\nHello\n')
    await put('work/todo.md', '---\ntitle: My todo\ntags: [work, urgent]\nstarred: true\n---\nbody\n')
    await put('work/projects/x.md', 'no heading here\n')
    await put('work/todo.assets/a.png', 'png')
    await put('.hidden/secret.md', 'hidden')
    await put('notes.txt', 'not a note')
    vault = await openVault(root)

    const tree = await vault.tree()
    expect(tree.notes.map((note) => note.id)).toEqual(['inbox.md'])
    expect(tree.folders.map((folder) => folder.id)).toEqual(['work'])
    expect(tree.folders[0]?.folders.map((folder) => folder.id)).toEqual(['work/projects'])
    expect(tree.folders[0]?.notes.map((note) => note.title)).toEqual(['My todo'])

    const note = await vault.readNote('work/todo.md')
    expect(note).toMatchObject({ title: 'My todo', tags: ['work', 'urgent'], starred: true, folder: 'work' })
    expect(note.body).toBe('body\n')
    // The file name is the name: a `# H1` is just content.
    expect((await vault.readNote('inbox.md')).title).toBe('inbox')
    expect((await vault.readNote('work/projects/x.md')).title).toBe('x')
  })

  it('writes atomically, bumps updated, sets created once and keeps unknown keys', async () => {
    await put('a.md', '---\ncustom: keep me # comment\ncreated: 2020-01-01T00:00:00.000Z\n---\nold\n')
    vault = await openVault(root)
    const before = await vault.readNote('a.md')
    const written = await vault.writeNote('a.md', { body: 'new\n', frontmatter: before.frontmatter })
    if (written.status !== 'saved') throw new Error('expected saved')
    const raw = await read('a.md')
    expect(raw.startsWith('---\ncustom: keep me # comment\ncreated: 2020-01-01T00:00:00.000Z\nupdated: ')).toBe(true)
    expect(raw.endsWith('---\nnew\n')).toBe(true)
    expect(written.note.created).toBe('2020-01-01T00:00:00.000Z')
    expect(Date.parse(written.note.updated)).toBeGreaterThan(Date.now() - 10_000)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const fresh = await vault.writeNote('new/plain.md', { body: '# Plain\n' })
    if (fresh.status !== 'saved') throw new Error('expected saved')
    expect(fresh.note.frontmatter.created).toBe(fresh.note.frontmatter.updated)
    expect((await vault.findNote('new/plain.md'))?.title).toBe('plain')
    expect(vault.folders).toContain('new')
  })

  it('lists, reads and saves a note whose extension is upper or mixed case, keeping its file name', async () => {
    await put('work/Plan.MD', 'old\n')
    await put('Idea.mD', 'idea\n')
    vault = await openVault(root)
    expect((await vault.notes()).map((note) => note.id).sort()).toEqual(['Idea.mD', 'work/Plan.MD'])
    const note = await vault.readNote('work/Plan.MD')
    expect(note.title).toBe('Plan')
    const written = await vault.writeNote('work/Plan.MD', { body: 'new\n', frontmatter: note.frontmatter })
    if (written.status !== 'saved') throw new Error('expected saved')
    expect(written.note.id).toBe('work/Plan.MD')
    expect(await readdir(path.join(root, 'work'))).toEqual(['Plan.MD'])
    expect((await read('work/Plan.MD')).endsWith('new\n')).toBe(true)
    expect((await vault.createNote('work', 'Fresh')).id).toBe('work/Fresh.md')
  })

  it('trashes and restores an upper-case .MD note with its assets, and saves assets beside it', async () => {
    await put('work/Plan.MD', '![a](./Plan.assets/a.png)\n')
    await put('work/Plan.assets/a.png', 'A')
    vault = await openVault(root)
    const link = await vault.saveAsset('work/Plan.MD', new Uint8Array([1, 2]), 'png')
    expect(link).toMatch(/^\.\/Plan\.assets\/[0-9a-f]+\.png$/)
    const file = await vault.assetPath('work/Plan.MD', link)
    expect(path.dirname(file)).toBe(path.join(vault.root, 'work', 'Plan.assets'))
    expect(new Uint8Array(await readFile(file))).toEqual(new Uint8Array([1, 2]))
    expect((await readdir(path.join(root, 'work/Plan.assets'))).length).toBe(2)
    const entry = await vault.deleteNote('work/Plan.MD')
    expect(entry.id).toBe('work/Plan.MD')
    expect((await readdir(path.join(root, '.trash/work'))).sort()).toEqual(['Plan.MD', 'Plan.assets'])
    expect(await readdir(path.join(root, 'work'))).toEqual([])
    const restored = await vault.restore(entry.id)
    expect(restored).toEqual({ id: 'work/Plan.MD', kind: 'note' })
    expect(await vault.hasNote('work/Plan.MD')).toBe(true)
    expect(await read('work/Plan.MD')).toBe('![a](./Plan.assets/a.png)\n')
    expect(await read('work/Plan.assets/a.png')).toBe('A')
  })

  it('creates notes named after the title, unique ignoring case', async () => {
    vault = await openVault(root)
    const first = await vault.createNote('', 'Hello, World!')
    const second = await vault.createNote('', 'hello, world!')
    expect(first.id).toBe('Hello, World!.md')
    expect(second.id).toBe('hello, world! 2.md')
    expect(first.title).toBe('Hello, World!')
    expect((await vault.createNote('', 'a/b: c?')).id).toBe('a-b- c-.md')
    await expect(vault.createNote('missing', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('creates empty Untitled notes by default', async () => {
    vault = await openVault(root)
    const first = await vault.createNote('')
    const second = await vault.createNote('')
    expect([first.id, second.id]).toEqual(['Untitled.md', 'Untitled 2.md'])
    expect(first.title).toBe('Untitled')
    expect(first.body).toBe('')
    expect(first.raw).not.toContain('#')
  })

  it('renames and moves notes with their assets, rewriting links', async () => {
    await put(
      'work/todo.md',
      '# Todo\n\n![shot](./todo.assets/a.png)\n<img src="todo.assets/b.png">\n[sibling](other.md)\n[web](https://x.y/z.png)\n\n```\n![code](./todo.assets/a.png)\n```\n',
    )
    await put('work/todo.assets/a.png', 'A')
    await put('work/todo.assets/b.png', 'B')
    await put('work/other.md', '# Other\n')
    await mkdir(path.join(root, 'archive/2026'), { recursive: true })
    vault = await openVault(root)

    const renamed = await vault.renameNote('work/todo.md', 'Done list')
    expect(renamed.id).toBe('work/Done list.md')
    expect(await read('work/Done list.assets/a.png')).toBe('A')
    expect(renamed.body).toContain('![shot](./Done%20list.assets/a.png)')
    expect(renamed.body).toContain('<img src="./Done%20list.assets/b.png">')
    expect(renamed.body).toContain('[sibling](other.md)')
    expect(renamed.body).toContain('[web](https://x.y/z.png)')
    expect(renamed.body).toContain('```\n![code](./todo.assets/a.png)\n```')
    expect(await vault.hasNote('work/todo.md')).toBe(false)

    const moved = await vault.moveNote(renamed.id, 'archive/2026')
    expect(moved.id).toBe('archive/2026/Done list.md')
    expect(moved.body).toContain('![shot](./Done%20list.assets/a.png)')
    expect(moved.body).toContain('[sibling](../../work/other.md)')
    expect(await read('archive/2026/Done list.assets/b.png')).toBe('B')
    expect(await readdir(path.join(root, 'work'))).toEqual(['other.md'])

    await put('archive/2026/Done list 2.md', 'x')
    await expect(vault.renameNote(moved.id, 'Done list 2')).rejects.toMatchObject({ code: 'EXISTS' })
  })

  it('renames an upper-case .MD note keeping its extension, with its assets and incoming links', async () => {
    await put('work/Plan.MD', '![a](./Plan.assets/a.png)\n')
    await put('work/Plan.assets/a.png', 'A')
    await put('index.md', '[plan](work/Plan.MD)\n![a](work/Plan.assets/a.png)\n')
    vault = await openVault(root)

    const renamed = await vault.renameNote('work/Plan.MD', 'Roadmap')
    expect(renamed.id).toBe('work/Roadmap.MD')
    expect((await readdir(path.join(root, 'work'))).sort()).toEqual(['Roadmap.MD', 'Roadmap.assets'])
    expect((await vault.readNote('work/Roadmap.MD')).body).toBe('![a](./Roadmap.assets/a.png)\n')
    expect(await read('work/Roadmap.assets/a.png')).toBe('A')

    const links = await vault.applyLinkUpdates([{ from: 'work/Plan.MD', to: renamed.id, kind: 'note' }])
    expect(links.total).toBe(2)
    expect(await read('index.md')).toBe('[plan](work/Roadmap.MD)\n![a](work/Roadmap.assets/a.png)\n')
  })

  it('moves an upper-case .MD note keeping its file name, with its assets', async () => {
    await put('work/Plan.MD', '![a](./Plan.assets/a.png)\n[web](../index.md)\n')
    await put('work/Plan.assets/a.png', 'A')
    await put('index.md', '# Index\n')
    await mkdir(path.join(root, 'archive'))
    vault = await openVault(root)

    const moved = await vault.moveNote('work/Plan.MD', 'archive')
    expect(moved.id).toBe('archive/Plan.MD')
    expect((await readdir(path.join(root, 'archive'))).sort()).toEqual(['Plan.MD', 'Plan.assets'])
    expect(await readdir(path.join(root, 'work'))).toEqual([])
    expect((await vault.readNote('archive/Plan.MD')).body).toBe('![a](./Plan.assets/a.png)\n[web](../index.md)\n')
    expect(await read('archive/Plan.assets/a.png')).toBe('A')
  })

  it('treats a name whose .md or .MD variant exists as taken when renaming or moving', async () => {
    await put('work/a.md', 'a')
    await put('work/Taken.MD', 'upper')
    await put('work/Plan.MD', 'plan')
    await put('work/other.md', 'lower')
    await put('archive/a.MD', 'archived')
    vault = await openVault(root)
    await expect(vault.renameNote('work/a.md', 'Taken')).rejects.toMatchObject({ code: 'EXISTS' })
    await expect(vault.renameNote('work/Plan.MD', 'other')).rejects.toMatchObject({ code: 'EXISTS' })
    expect((await vault.moveNote('work/a.md', 'archive')).id).toBe('archive/a 2.md')
    expect((await readdir(path.join(root, 'work'))).sort()).toEqual(['Plan.MD', 'Taken.MD', 'other.md'])
    expect(await read('archive/a.MD')).toBe('archived')
  })

  it('moves to a free name when the target folder has the same file name', async () => {
    await put('a/note.md', 'one')
    await put('b/note.md', 'two')
    vault = await openVault(root)
    expect((await vault.moveNote('a/note.md', 'b')).id).toBe('b/note 2.md')
  })

  it('saves assets by content hash next to the note', async () => {
    await put('work/My Note.md', '# Note\n')
    vault = await openVault(root)
    const bytes = new TextEncoder().encode('image bytes')
    const link = await vault.saveAsset('work/My Note.md', bytes, '.PNG')
    expect(link).toMatch(/^\.\/My%20Note\.assets\/[0-9a-f]{12}\.png$/)
    expect(await vault.saveAsset('work/My Note.md', bytes, 'png')).toBe(link)
    const file = await vault.assetPath('work/My Note.md', link)
    expect(file).toBe(path.join(vault.root, 'work', 'My Note.assets', link.split('/').at(-1) ?? ''))
    expect(await readFile(file, 'utf8')).toBe('image bytes')
  })
})

describe('extension-case twins (a.md beside a.MD)', () => {
  /** Seeds `work/a.md` and `work/a.MD` sharing `work/a.assets`; false when the file system folds them into one file. */
  async function seedTwins(): Promise<boolean> {
    await put('work/a.md', 'lower ![x](./a.assets/x.png)\n')
    await put('work/a.MD', 'upper ![x](./a.assets/x.png)\n')
    await put('work/a.assets/x.png', 'X')
    return (await readdir(path.join(root, 'work'))).length === 3
  }

  it('trashes one twin and leaves the shared assets folder for the other, saying so', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    vault = await openVault(root)
    const entry = await vault.deleteNote('work/a.md')
    expect(entry).toMatchObject({ id: 'work/a.md', originalPath: 'work/a.md', assetsLeftBehind: 'work/a.assets' })
    expect(await readdir(path.join(root, '.trash/work'))).toEqual(['a.md'])
    expect(await read('work/a.assets/x.png')).toBe('X')
    expect(await vault.hasNote('work/a.MD')).toBe(true)
    expect((await vault.listTrash()).map((item) => item.assetsLeftBehind)).toEqual(['work/a.assets'])

    const last = await vault.deleteNote('work/a.MD')
    expect(last).not.toHaveProperty('assetsLeftBehind')
    expect((await readdir(path.join(root, '.trash/work'))).sort()).toEqual(['a 2.MD', 'a 2.assets', 'a.md'])
  })

  it('restores a trashed twin beside the other, its links still on the shared folder, saying it stayed', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    vault = await openVault(root)
    const entry = await vault.deleteNote('work/a.md')
    await vault.close()
    vault = await openVault(root)
    const restored = await vault.restore(entry.id)
    expect(restored).toEqual({ id: 'work/a 2.md', kind: 'note', assetsLeftBehind: 'work/a.assets' })
    expect(await read('work/a 2.md')).toBe('lower ![x](./a.assets/x.png)\n')
    expect((await readdir(path.join(root, 'work'))).sort()).toEqual(['a 2.md', 'a.MD', 'a.assets'])
    expect(await read('work/a.assets/x.png')).toBe('X')
    expect(await vault.listTrash()).toEqual([])
  })

  it('renames one twin and leaves the shared assets folder in place, its links still pointing at it', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    await put('index.md', '![x](work/a.assets/x.png)\n')
    vault = await openVault(root)
    const renamed = await vault.renameNote('work/a.md', 'b')
    expect(renamed).toMatchObject({ id: 'work/b.md', assetsLeftBehind: 'work/a.assets' })
    expect(renamed.body).toBe('lower ![x](./a.assets/x.png)\n')
    expect((await readdir(path.join(root, 'work'))).sort()).toEqual(['a.MD', 'a.assets', 'b.md'])
    expect(await read('work/a.assets/x.png')).toBe('X')
    expect(await read('work/a.MD')).toBe('upper ![x](./a.assets/x.png)\n')

    await vault.applyLinkUpdates([{ from: 'work/a.md', to: renamed.id, kind: 'note' }])
    expect(await read('work/a.MD')).toBe('upper ![x](./a.assets/x.png)\n')
    expect(await read('index.md')).toBe('![x](work/a.assets/x.png)\n')
  })

  it('moves one twin and leaves the shared assets folder in place, re-basing its links on it', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    await mkdir(path.join(root, 'archive'))
    vault = await openVault(root)
    const moved = await vault.moveNote('work/a.MD', 'archive')
    expect(moved).toMatchObject({ id: 'archive/a.MD', assetsLeftBehind: 'work/a.assets' })
    expect(moved.body).toBe('upper ![x](../work/a.assets/x.png)\n')
    expect(await readdir(path.join(root, 'archive'))).toEqual(['a.MD'])
    expect((await readdir(path.join(root, 'work'))).sort()).toEqual(['a.assets', 'a.md'])
    expect(await read('work/a.assets/x.png')).toBe('X')

    await put('index.md', '[a](work/a.MD) ![x](work/a.assets/x.png)\n')
    await vault.refresh()
    await vault.applyLinkUpdates([{ from: 'work/a.MD', to: moved.id, kind: 'note' }])
    expect(await read('index.md')).toBe('[a](archive/a.MD) ![x](work/a.assets/x.png)\n')
    expect(await read('work/a.md')).toBe('lower ![x](./a.assets/x.png)\n')
  })

  it('title-renames one twin, leaving the shared assets folder and the links into it alone', async (ctx) => {
    await put('work/meeting-notes.md', '---\ntitle: Meeting notes\n---\nbody\n')
    await put('work/meeting-notes.MD', 'twin\n')
    await put('work/meeting-notes.assets/x.png', 'X')
    if ((await readdir(path.join(root, 'work'))).length !== 3) ctx.skip()
    await put('index.md', '[m](work/meeting-notes.md)\n![x](work/meeting-notes.assets/x.png)\n')
    vault = await openVault(root)
    const report = await vault.applyTitleRenames(await vault.planTitleRenames())
    expect(report.renamed).toEqual([
      {
        from: 'work/meeting-notes.md',
        to: 'work/Meeting notes.md',
        title: 'Meeting notes',
        assetsLeftBehind: 'work/meeting-notes.assets',
      },
    ])
    expect(await read('index.md')).toBe('[m](work/Meeting%20notes.md)\n![x](work/meeting-notes.assets/x.png)\n')
    expect(await read('work/meeting-notes.assets/x.png')).toBe('X')
  })
})

describe('writeNote frontmatter', () => {
  it('keeps the YAML of values sent back unchanged after a JSON round trip and writes edited keys', async () => {
    await put(
      'y.md',
      '---\nratio: .nan\nquoted: "keep me" # note\ntitle: Old\ncreated: 2020-01-01T00:00:00.000Z\n---\nBody\n',
    )
    vault = await openVault(root)
    const before = await vault.readNote('y.md')
    const sent = JSON.parse(JSON.stringify({ ...before.frontmatter, title: 'New' })) as Record<string, unknown>
    const result = await vault.writeNote('y.md', { body: 'Body\n', baseHash: before.hash, frontmatter: sent })
    expect(result.status).toBe('saved')
    const raw = await read('y.md')
    expect(raw).toContain('ratio: .nan\n')
    expect(raw).toContain('quoted: "keep me" # note\n')
    expect(raw).toContain('title: New\n')
  })

  it('writes keys named like inherited object properties as sent', async () => {
    vault = await openVault(root)
    const result = await vault.writeNote('p.md', { body: 'Body\n', baseHash: null, frontmatter: { toString: null } })
    expect(result.status).toBe('saved')
    expect(await read('p.md')).toContain('toString: null\n')
  })
})

describe('vault trash', () => {
  it('deletes notes (with assets) to .trash and restores them', async () => {
    await put('work/todo.md', '# Todo\n![a](./todo.assets/a.png)\n')
    await put('work/todo.assets/a.png', 'A')
    vault = await openVault(root)
    const entry = await vault.deleteNote('work/todo.md')
    expect(entry).toMatchObject({ id: 'work/todo.md', kind: 'note', originalPath: 'work/todo.md' })
    expect(await read('.trash/work/todo.assets/a.png')).toBe('A')
    expect(await vault.hasNote('work/todo.md')).toBe(false)
    expect((await vault.listTrash()).map((item) => [item.id, item.title])).toEqual([['work/todo.md', 'todo']])

    // Same name deleted twice gets a distinct trash slot.
    await put('work/todo.md', '# Second\n')
    await vault.refresh()
    expect((await vault.deleteNote('work/todo.md')).id).toBe('work/todo 2.md')

    // Restore while the original name is taken: suffixed name, assets and links follow.
    await put('work/todo.md', 'occupied')
    await vault.refresh()
    const restored = await vault.restore('work/todo.md')
    expect(restored).toEqual({ id: 'work/todo 2.md', kind: 'note' })
    expect(await read('work/todo 2.assets/a.png')).toBe('A')
    expect(await read('work/todo 2.md')).toContain('![a](./todo%202.assets/a.png)')
    expect((await vault.findNote('work/todo 2.md'))?.title).toBe('todo 2')
    expect((await vault.listTrash()).map((item) => item.id)).toEqual(['work/todo 2.md'])

    await vault.emptyTrash()
    expect(await vault.listTrash()).toEqual([])
    await expect(vault.restore('work/todo 2.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('restores into a folder that no longer exists', async () => {
    await put('gone/n.md', 'x')
    vault = await openVault(root)
    await vault.deleteNote('gone/n.md')
    await rm(path.join(root, 'gone'), { recursive: true })
    expect(await vault.restore('gone/n.md')).toEqual({ id: 'gone/n.md', kind: 'note' })
    expect(vault.folders).toContain('gone')
  })
})

describe('vault folders', () => {
  it('creates, renames, moves, colours, orders, deletes and restores folders', async () => {
    await put('work/sub/n.md', '# N\n')
    vault = await openVault(root)
    expect(await vault.createFolder('', 'Ideas / Drafts')).toBe('Ideas - Drafts')
    await expect(vault.createFolder('', 'Ideas - Drafts')).rejects.toMatchObject({ code: 'EXISTS' })
    await vault.setFolderColor('work', '#ff0000')
    await vault.setFolderColor('work/sub', '#00ff00')
    await vault.setFolderOrder(['work', 'Ideas - Drafts'])
    expect((await vault.tree()).folders.map((folder) => [folder.id, folder.color])).toEqual([
      ['work', '#ff0000'],
      ['Ideas - Drafts', undefined],
    ])

    expect(await vault.renameFolder('work', 'Job')).toBe('Job')
    expect(await vault.hasNote('Job/sub/n.md')).toBe(true)
    expect(vault.config.folders).toEqual({ Job: { color: '#ff0000' }, 'Job/sub': { color: '#00ff00' } })
    expect(vault.config.folderOrder).toEqual(['Job', 'Ideas - Drafts'])
    const config = JSON.parse(await read('.boostnote/config.json'))
    expect(config.folders.Job.color).toBe('#ff0000')

    expect(await vault.moveFolder('Job/sub', 'Ideas - Drafts')).toBe('Ideas - Drafts/sub')
    await expect(vault.moveFolder('Ideas - Drafts', 'Ideas - Drafts/sub')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })

    const entry = await vault.deleteFolder('Ideas - Drafts')
    expect(entry).toMatchObject({ kind: 'folder', folders: { sub: { color: '#00ff00' } } })
    expect(await vault.notes()).toEqual([])
    expect(vault.config.folders['Ideas - Drafts/sub']).toBeUndefined()

    expect(await vault.restore(entry.id)).toEqual({ id: 'Ideas - Drafts', kind: 'folder' })
    expect(await vault.hasNote('Ideas - Drafts/sub/n.md')).toBe(true)
    expect(vault.config.folders['Ideas - Drafts/sub']).toEqual({ color: '#00ff00' })
  })
})

describe('vault path safety', () => {
  it('rejects ids that escape the vault or point at hidden data', async () => {
    vault = await openVault(root)
    for (const id of [
      '../x.md',
      '/etc/passwd.md',
      'a/../../x.md',
      '.trash/x.md',
      'a\\b.md',
      'x.assets/y.md',
      'x.txt',
    ]) {
      await expect(vault.readNote(id)).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(vault.writeNote(id, { body: 'x' })).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    await expect(vault.createFolder('..', 'x')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(vault.createFolder('', '.git')).resolves.toBe('git')
  })

  it('rejects asset links that leave the vault', async () => {
    await put('a/n.md', 'x')
    vault = await openVault(root)
    for (const href of [
      '../../etc/passwd',
      '/etc/passwd',
      'file:///etc/passwd',
      '..%2F..%2Fx',
      '../.boostnote/config.json',
      '.trash/x.png',
      '\\etc\\passwd',
      '%5Cetc%5Cpasswd',
      '%2Fetc%2Fpasswd',
      '.trash/../x.png',
      '#top',
      '?x=1',
      '',
      'a%00.png',
    ]) {
      await expect(vault.assetPath('a/n.md', href)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    expect(await vault.assetPath('a/n.md', '../b/c.png?x=1#y')).toBe(path.join(vault.root, 'b', 'c.png'))
    expect(await vault.assetPath('a/n.md', 'n.assets\\p%20q.png')).toBe(
      path.join(vault.root, 'a', 'n.assets', 'p q.png'),
    )
    expect(await vault.assetPath('a/n.md', '%23top')).toBe(path.join(vault.root, 'a', '#top'))
  })

  it('rejects paths that escape through symlinks', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'vault-outside-'))
    try {
      await writeFile(path.join(outside, 'secret.md'), 'secret')
      await symlink(outside, path.join(root, 'link'))
      vault = await openVault(root)
      expect(vault.folders).not.toContain('link')
      await expect(vault.readNote('link/secret.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(vault.writeNote('link/new.md', { body: 'x' })).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(vault.assetPath('n.md', 'link/secret.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('resolves the absolute path of an existing note, refusing escapes and missing notes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'vault-outside-'))
    try {
      await put('a/n.md', 'x')
      await writeFile(path.join(outside, 'secret.md'), 'secret')
      await symlink(outside, path.join(root, 'link'))
      vault = await openVault(root)
      expect(await vault.notePath('a/n.md')).toBe(path.join(vault.root, 'a', 'n.md'))
      await expect(vault.notePath('../x.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(vault.notePath('link/secret.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(vault.notePath('a/missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
