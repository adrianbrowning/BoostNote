import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type LinkMove, openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

const read = (rel: string) => readFile(path.join(root, rel), 'utf8')

/** Every file under the vault (dot-dirs included) with its content. */
async function snapshot(dir = root, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`
    if (entry.isDirectory()) Object.assign(files, await snapshot(path.join(dir, entry.name), `${rel}/`))
    else files[rel] = await readFile(path.join(dir, entry.name), 'utf8')
  }
  return files
}

/** Plans `moves` (checking nothing is written), applies them, and checks the vault saw no outside change. */
async function planThenApply(moves: LinkMove[]) {
  const before = await snapshot()
  const plan = await vault.planLinkUpdates(moves)
  expect(await snapshot()).toEqual(before)
  const applied = await vault.applyLinkUpdates(moves)
  expect(applied).toEqual(plan)
  expect(await vault.refresh()).toEqual([])
  expect(await vault.planLinkUpdates(moves)).toEqual({ notes: [], total: 0 })
  return plan
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-links-'))
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

describe('link updates after renaming a note', () => {
  const linker = [
    '# Index',
    '[a](notes/a.md#sec) and [again](./notes/a.md?x=1)',
    '![img](notes/a.assets/p.png)',
    '<img src="./notes/a.assets/q.png">',
    '[other](notes/b.md)',
    '`[code](notes/a.md)`',
    '```',
    '[fenced](notes/a.md)',
    '```',
    '',
  ].join('\n')

  beforeEach(async () => {
    await put('index.md', `---\ntags: [x]\n---\n${linker}`)
    await put('notes/a.md', '# A\n[me](./a.md#top) ![p](./a.assets/p.png) [b](b.md)\n')
    await put('notes/a.assets/p.png', 'P')
    await put('notes/b.md', 'see [a](a.md)\n')
    await put('.trash/old.md', '[a](notes/a.md)\n')
    vault = await openVault(root)
  })

  it('plans without writing, then rewrites links in other notes only', async () => {
    const renamed = await vault.renameNote('notes/a.md', 'Alpha One')
    expect(renamed.id).toBe('notes/Alpha One.md')
    // Its own links were re-based by the rename, so it is not part of the plan.
    expect(await read('notes/Alpha One.md')).toBe(
      '# A\n[me](./Alpha%20One.md#top) ![p](./Alpha%20One.assets/p.png) [b](b.md)\n',
    )

    const plan = await planThenApply([{ from: 'notes/a.md', to: 'notes/Alpha One.md', kind: 'note' }])
    expect(plan).toEqual({
      notes: [
        { id: 'index.md', title: 'index', links: 4 },
        { id: 'notes/b.md', title: 'b', links: 1 },
      ],
      total: 5,
    })
    expect(await read('index.md')).toBe(
      [
        '---',
        'tags: [x]',
        '---',
        '# Index',
        '[a](notes/Alpha%20One.md#sec) and [again](./notes/Alpha%20One.md?x=1)',
        '![img](notes/Alpha%20One.assets/p.png)',
        '<img src="./notes/Alpha%20One.assets/q.png">',
        '[other](notes/b.md)',
        '`[code](notes/a.md)`',
        '```',
        '[fenced](notes/a.md)',
        '```',
        '',
      ].join('\n'),
    )
    expect(await read('notes/b.md')).toBe('see [a](Alpha%20One.md)\n')
    expect(await read('.trash/old.md')).toBe('[a](notes/a.md)\n')
  })

  it('follows `note.md/#anchor` links (as copied from GitHub), keeping their form; folder links stay', async () => {
    await put('book.md', '[curry](notes/a.md/#user-content-curry) [q](./notes/a.md/?x=1) [dir](notes/)\n')
    await vault.refresh()
    await vault.renameNote('notes/a.md', 'Alpha One')
    const plan = await planThenApply([{ from: 'notes/a.md', to: 'notes/Alpha One.md', kind: 'note' }])
    expect(plan.notes.find((note) => note.id === 'book.md')).toEqual({ id: 'book.md', title: 'book', links: 2 })
    expect(await read('book.md')).toBe(
      '[curry](notes/Alpha%20One.md/#user-content-curry) [q](./notes/Alpha%20One.md/?x=1) [dir](notes/)\n',
    )
  })
})

describe('link updates after moving a note to another folder', () => {
  it('re-bases links from every depth, keeping ./ where it fits', async () => {
    await put('work/todo.md', '# Todo\n![s](./todo.assets/s.png)\n')
    await put('work/todo.assets/s.png', 'S')
    await put('work/x.md', '[t](todo.md) [t2](./todo.md#h) ![s](./todo.assets/s.png)\n')
    await put('work/sub/n.md', '[t](../todo.md)\n')
    await put('r.md', '[t](./work/todo.md)\n')
    await put('archive/2026/y.md', '[t](../../work/todo.md) [t2](./../../work/todo.md)\n')
    vault = await openVault(root)

    const moved = await vault.moveNote('work/todo.md', 'archive/2026')
    expect(moved.body).toBe('# Todo\n![s](./todo.assets/s.png)\n')
    const plan = await planThenApply([{ from: 'work/todo.md', to: moved.id, kind: 'note' }])
    expect(plan.total).toBe(7)
    expect(plan.notes.map((note) => note.id)).toEqual(['archive/2026/y.md', 'r.md', 'work/sub/n.md', 'work/x.md'])
    expect(await read('work/x.md')).toBe(
      '[t](../archive/2026/todo.md) [t2](../archive/2026/todo.md#h) ![s](../archive/2026/todo.assets/s.png)\n',
    )
    expect(await read('work/sub/n.md')).toBe('[t](../../archive/2026/todo.md)\n')
    expect(await read('r.md')).toBe('[t](./archive/2026/todo.md)\n')
    expect(await read('archive/2026/y.md')).toBe('[t](todo.md) [t2](./todo.md)\n')
  })
})

describe('link updates after renaming or moving a folder', () => {
  beforeEach(async () => {
    await put(
      'home.md',
      '[p](work/projects/plan.md) ![a](./work/projects/plan.assets/a.png) [z](work/projects/deep/z.md)\n',
    )
    await put('work/w.md', '[p](projects/plan.md#goal) ![a](./projects/plan.assets/a.png)\n')
    await put(
      'work/projects/plan.md',
      '[w](../w.md) ![a](./plan.assets/a.png) [z](./deep/z.md) [self](../projects/plan.md) ![s](../../shared.assets/x.png)\n',
    )
    await put('work/projects/plan.assets/a.png', 'A')
    await put('work/projects/deep/z.md', '[p](../plan.md) [h](../../../home.md)\n')
    await put('shared.md', 'shared\n')
    await put('shared.assets/x.png', 'X')
    vault = await openVault(root)
  })

  it('renamed in place: links into it are planned and rewritten', async () => {
    expect(await vault.renameFolder('work/projects', 'Projects 2026')).toBe('work/Projects 2026')
    // Inside, only the link that went out and back in through the old name changes (to `./plan.md`).
    expect(await read('work/Projects 2026/plan.md')).toBe(
      '[w](../w.md) ![a](./plan.assets/a.png) [z](./deep/z.md) [self](./plan.md) ![s](../../shared.assets/x.png)\n',
    )
    expect(await read('work/Projects 2026/deep/z.md')).toBe('[p](../plan.md) [h](../../../home.md)\n')

    const plan = await planThenApply([{ from: 'work/projects', to: 'work/Projects 2026', kind: 'folder' }])
    expect(plan).toEqual({
      notes: [
        { id: 'home.md', title: 'home', links: 3 },
        { id: 'work/w.md', title: 'w', links: 2 },
      ],
      total: 5,
    })
    expect(await read('home.md')).toBe(
      '[p](work/Projects%202026/plan.md) ![a](./work/Projects%202026/plan.assets/a.png) [z](work/Projects%202026/deep/z.md)\n',
    )
    expect(await read('work/w.md')).toBe(
      '[p](Projects%202026/plan.md#goal) ![a](./Projects%202026/plan.assets/a.png)\n',
    )
  })

  it('moved under another parent: links out of it are re-based, links into it are planned and rewritten', async () => {
    await mkdir(path.join(root, 'archive'))
    await vault.refresh()
    expect(await vault.moveFolder('work/projects', 'archive')).toBe('archive/projects')
    expect(await read('archive/projects/plan.md')).toBe(
      '[w](../../work/w.md) ![a](./plan.assets/a.png) [z](./deep/z.md) [self](./plan.md) ![s](../../shared.assets/x.png)\n',
    )
    expect(await read('archive/projects/deep/z.md')).toBe('[p](../plan.md) [h](../../../home.md)\n')
    expect(await read('archive/projects/plan.assets/a.png')).toBe('A')

    const plan = await planThenApply([{ from: 'work/projects', to: 'archive/projects', kind: 'folder' }])
    expect(plan.total).toBe(5)
    expect(await read('home.md')).toBe(
      '[p](archive/projects/plan.md) ![a](./archive/projects/plan.assets/a.png) [z](archive/projects/deep/z.md)\n',
    )
    expect(await read('work/w.md')).toBe(
      '[p](../archive/projects/plan.md#goal) ![a](../archive/projects/plan.assets/a.png)\n',
    )
  })

  it('moved one level deeper: links out of it gain a ../', async () => {
    await mkdir(path.join(root, 'work/old'))
    await vault.refresh()
    expect(await vault.moveFolder('work/projects', 'work/old')).toBe('work/old/projects')
    expect(await read('work/old/projects/plan.md')).toBe(
      '[w](../../w.md) ![a](./plan.assets/a.png) [z](./deep/z.md) [self](./plan.md) ![s](../../../shared.assets/x.png)\n',
    )
    expect(await read('work/old/projects/deep/z.md')).toBe('[p](../plan.md) [h](../../../../home.md)\n')
    expect(await vault.refresh()).toEqual([])
  })
})

describe('link update plans', () => {
  it('finds nothing in a vault without links', async () => {
    await put('a.md', '# A\n')
    await put('b.md', 'plain text\n')
    vault = await openVault(root)
    await vault.renameNote('a.md', 'c')
    expect(await vault.planLinkUpdates([{ from: 'a.md', to: 'c.md', kind: 'note' }])).toEqual({ notes: [], total: 0 })
    expect(await vault.applyLinkUpdates([{ from: 'a.md', to: 'c.md', kind: 'note' }])).toEqual({ notes: [], total: 0 })
    expect(await read('b.md')).toBe('plain text\n')
  })

  it('rejects invalid moves', async () => {
    vault = await openVault(root)
    for (const move of [
      { from: '../a.md', to: 'b.md', kind: 'note' },
      { from: 'a.md', to: '.trash/b.md', kind: 'note' },
      { from: 'a.txt', to: 'b.md', kind: 'note' },
      { from: '', to: 'x', kind: 'folder' },
      { from: 'x', to: 'x.assets', kind: 'folder' },
    ] as const) {
      await expect(vault.planLinkUpdates([move])).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
  })
})
