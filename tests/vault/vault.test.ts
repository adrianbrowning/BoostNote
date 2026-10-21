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

    const tree = vault.tree()
    expect(tree.notes.map((note) => note.id)).toEqual(['inbox.md'])
    expect(tree.folders.map((folder) => folder.id)).toEqual(['work'])
    expect(tree.folders[0]?.folders.map((folder) => folder.id)).toEqual(['work/projects'])
    expect(tree.folders[0]?.notes.map((note) => note.title)).toEqual(['My todo'])

    const note = await vault.readNote('work/todo.md')
    expect(note).toMatchObject({ title: 'My todo', tags: ['work', 'urgent'], starred: true, folder: 'work' })
    expect(note.body).toBe('body\n')
    expect((await vault.readNote('inbox.md')).title).toBe('Inbox')
    expect((await vault.readNote('work/projects/x.md')).title).toBe('x')
  })

  it('writes atomically, bumps updated, sets created once and keeps unknown keys', async () => {
    await put('a.md', '---\ncustom: keep me # comment\ncreated: 2020-01-01T00:00:00.000Z\n---\nold\n')
    vault = await openVault(root)
    const before = await vault.readNote('a.md')
    const written = await vault.writeNote('a.md', { body: 'new\n', frontmatter: before.frontmatter })
    const raw = await read('a.md')
    expect(raw.startsWith('---\ncustom: keep me # comment\ncreated: 2020-01-01T00:00:00.000Z\nupdated: ')).toBe(true)
    expect(raw.endsWith('---\nnew\n')).toBe(true)
    expect(written.created).toBe('2020-01-01T00:00:00.000Z')
    expect(Date.parse(written.updated)).toBeGreaterThan(Date.now() - 10_000)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const fresh = await vault.writeNote('new/plain.md', { body: '# Plain\n' })
    expect(fresh.frontmatter.created).toBe(fresh.frontmatter.updated)
    expect(vault.index.get('new/plain.md')?.title).toBe('Plain')
    expect(vault.folders).toContain('new')
  })

  it('creates notes with unique slugged names', async () => {
    vault = await openVault(root)
    const first = await vault.createNote('', 'Hello, World!')
    const second = await vault.createNote('', 'hello world')
    expect(first.id).toBe('hello-world.md')
    expect(second.id).toBe('hello-world-2.md')
    expect(first.title).toBe('Hello, World!')
    await expect(vault.createNote('missing', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
    expect(vault.index.has('work/todo.md')).toBe(false)

    const moved = await vault.moveNote(renamed.id, 'archive/2026')
    expect(moved.id).toBe('archive/2026/Done list.md')
    expect(moved.body).toContain('![shot](./Done%20list.assets/a.png)')
    expect(moved.body).toContain('[sibling](../../work/other.md)')
    expect(await read('archive/2026/Done list.assets/b.png')).toBe('B')
    expect(await readdir(path.join(root, 'work'))).toEqual(['other.md'])

    await put('archive/2026/Done list 2.md', 'x')
    await expect(vault.renameNote(moved.id, 'Done list 2')).rejects.toMatchObject({ code: 'EXISTS' })
  })

  it('moves to a free name when the target folder has the same file name', async () => {
    await put('a/note.md', 'one')
    await put('b/note.md', 'two')
    vault = await openVault(root)
    expect((await vault.moveNote('a/note.md', 'b')).id).toBe('b/note-2.md')
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

describe('vault trash', () => {
  it('deletes notes (with assets) to .trash and restores them', async () => {
    await put('work/todo.md', '# Todo\n![a](./todo.assets/a.png)\n')
    await put('work/todo.assets/a.png', 'A')
    vault = await openVault(root)
    const entry = await vault.deleteNote('work/todo.md')
    expect(entry).toMatchObject({ id: 'work/todo.md', kind: 'note', originalPath: 'work/todo.md' })
    expect(await read('.trash/work/todo.assets/a.png')).toBe('A')
    expect(vault.index.has('work/todo.md')).toBe(false)
    expect((await vault.listTrash()).map((item) => [item.id, item.title])).toEqual([['work/todo.md', 'Todo']])

    // Same name deleted twice gets a distinct trash slot.
    await put('work/todo.md', '# Second\n')
    await vault.refresh()
    expect((await vault.deleteNote('work/todo.md')).id).toBe('work/todo-2.md')

    // Restore while the original name is taken: suffixed name, assets and links follow.
    await put('work/todo.md', 'occupied')
    await vault.refresh()
    const restored = await vault.restore('work/todo.md')
    expect(restored).toBe('work/todo-2.md')
    expect(await read('work/todo-2.assets/a.png')).toBe('A')
    expect(await read('work/todo-2.md')).toContain('![a](./todo-2.assets/a.png)')
    expect(vault.index.get('work/todo-2.md')?.title).toBe('Todo')
    expect((await vault.listTrash()).map((item) => item.id)).toEqual(['work/todo-2.md'])

    await vault.emptyTrash()
    expect(await vault.listTrash()).toEqual([])
    await expect(vault.restore('work/todo-2.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('restores into a folder that no longer exists', async () => {
    await put('gone/n.md', 'x')
    vault = await openVault(root)
    await vault.deleteNote('gone/n.md')
    await rm(path.join(root, 'gone'), { recursive: true })
    expect(await vault.restore('gone/n.md')).toBe('gone/n.md')
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
    expect(vault.tree().folders.map((folder) => [folder.id, folder.color])).toEqual([
      ['work', '#ff0000'],
      ['Ideas - Drafts', undefined],
    ])

    expect(await vault.renameFolder('work', 'Job')).toBe('Job')
    expect(vault.index.has('Job/sub/n.md')).toBe(true)
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
    expect(vault.index.all()).toEqual([])
    expect(vault.config.folders['Ideas - Drafts/sub']).toBeUndefined()

    expect(await vault.restore(entry.id)).toBe('Ideas - Drafts')
    expect(vault.index.has('Ideas - Drafts/sub/n.md')).toBe(true)
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
    ]) {
      await expect(vault.assetPath('a/n.md', href)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    expect(await vault.assetPath('a/n.md', '../b/c.png?x=1#y')).toBe(path.join(vault.root, 'b', 'c.png'))
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
})
