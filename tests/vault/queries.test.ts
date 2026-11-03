import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-queries-'))
  // Written out of id order; ids chosen so localeCompare (apple, Beta) differs from code points (Beta, apple).
  await writeFile(
    path.join(root, 'Beta.md'),
    '---\ntags: [lang, zed]\nupdated: 2026-01-03T00:00:00.000Z\n---\nrust once\n',
  )
  await mkdir(path.join(root, 'work'))
  await writeFile(
    path.join(root, 'work', 'alpha.md'),
    '---\ntags: [rust, Lang]\nupdated: 2026-01-02T00:00:00.000Z\n---\n# Alpha\n\nrust rust\n',
  )
  await writeFile(path.join(root, 'apple.md'), '---\ntags: [apple]\nupdated: 2026-01-01T00:00:00.000Z\n---\nrust\n')
  vault = await openVault(root)
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

describe('vault queries', () => {
  it('finds notes by id and tells whether they exist', async () => {
    expect(await vault.findNote('work/alpha.md')).toMatchObject({ id: 'work/alpha.md', folder: 'work', title: 'alpha' })
    expect(await vault.findNote('missing.md')).toBeUndefined()
    expect(await vault.hasNote('Beta.md')).toBe(true)
    expect(await vault.hasNote('work/beta.md')).toBe(false)
  })

  it('lists notes sorted by id', async () => {
    expect((await vault.notes()).map((note) => note.id)).toEqual(['apple.md', 'Beta.md', 'work/alpha.md'])
  })

  it('counts tags, sorted case-insensitively', async () => {
    expect(await vault.tags()).toEqual([
      { tag: 'apple', count: 1 },
      { tag: 'lang', count: 1 },
      { tag: 'Lang', count: 1 },
      { tag: 'rust', count: 1 },
      { tag: 'zed', count: 1 },
    ])
  })

  it('ranks search hits and honours the limit', async () => {
    // alpha: tag 8 + body 2; Beta and apple: body 1 each, newer first.
    expect((await vault.search('rust')).map((hit) => [hit.id, hit.score])).toEqual([
      ['work/alpha.md', 10],
      ['Beta.md', 1],
      ['apple.md', 1],
    ])
    expect((await vault.search('rust', 2)).map((hit) => hit.id)).toEqual(['work/alpha.md', 'Beta.md'])
    expect(await vault.search('   ')).toEqual([])
  })

  it('builds the folder tree with its notes', async () => {
    const tree = await vault.tree()
    expect(tree.notes.map((note) => note.id)).toEqual(['apple.md', 'Beta.md'])
    expect(tree.folders.map((folder) => [folder.id, folder.notes.map((note) => note.id)])).toEqual([
      ['work', ['work/alpha.md']],
    ])
  })

  it('returns notes that cannot be changed', async () => {
    const note = await vault.findNote('work/alpha.md')
    if (!note) throw new Error('work/alpha.md is not indexed')
    // Casts drop the read-only types on purpose: the test proves the object is frozen at runtime.
    const writable = note as unknown as { title: string; tags: string[] }
    expect(() => {
      writable.title = 'changed'
    }).toThrow(TypeError)
    expect(() => writable.tags.push('extra')).toThrow(TypeError)
    const listed = (await vault.notes()).find((meta) => meta.id === 'work/alpha.md')
    if (!listed) throw new Error('work/alpha.md is not listed')
    const listedTags = listed.tags as string[]
    expect(() => listedTags.splice(0)).toThrow(TypeError)
    const [hit] = await vault.search('rust')
    const writableHit = hit as unknown as { score: number }
    expect(() => {
      writableHit.score = 0
    }).toThrow(TypeError)
    expect(await vault.findNote('work/alpha.md')).toMatchObject({ title: 'alpha', tags: ['rust', 'Lang'] })
  })

  it('types query results as read-only', async () => {
    const note = await vault.findNote('work/alpha.md')
    const [listed] = await vault.notes()
    const [hit] = await vault.search('rust')
    const [treeNote] = (await vault.tree()).notes
    if (!note || !listed || !hit || !treeNote) throw new Error('fixture notes missing')
    // Never called: the compiler must reject each line below.
    const typeOnly = () => {
      // @ts-expect-error fields are read-only
      note.title = 'changed'
      // @ts-expect-error tags are read-only
      note.tags.push('extra')
      // @ts-expect-error tags are read-only
      listed.tags.push('extra')
      // @ts-expect-error tags are read-only
      hit.tags.push('extra')
      // @ts-expect-error tags are read-only
      treeNote.tags.push('extra')
    }
    expect(typeOnly).toBeTypeOf('function')
  })
})
