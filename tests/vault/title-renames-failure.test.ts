import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openVault, type Vault } from '../../src/vault/index.ts'

// Lets a test make one rename fail with an I/O error part-way through a bulk rename.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const realRename = (await vi.importActual<typeof fs>('node:fs/promises')).rename

describe('applyTitleRenames after an unexpected error', () => {
  let root: string
  let vault: Vault

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'boost-rename-fail-'))
    await fs.writeFile(path.join(root, 'alpha-note.md'), '# Alpha note\n')
    await fs.writeFile(path.join(root, 'beta-note.md'), '# Beta note\n')
    await fs.writeFile(path.join(root, 'links.md'), '[a](./alpha-note.md) [b](./beta-note.md)\n')
    vault = await openVault(root)
  })

  afterEach(async () => {
    vi.mocked(fs.rename).mockImplementation(realRename)
    await vault.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('stops, keeps links to the notes already renamed correct, then rethrows', async () => {
    const plan = await vault.planTitleRenames()
    expect(plan.renames.map((rename) => rename.from)).toEqual(['alpha-note.md', 'beta-note.md'])
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith('Beta note.md')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      return realRename(from, to)
    })

    await expect(vault.applyTitleRenames(plan)).rejects.toThrow('EIO')

    const files = (await fs.readdir(root)).filter((name) => name.endsWith('.md')).sort()
    expect(files).toEqual(['Alpha note.md', 'beta-note.md', 'links.md'])
    expect(await fs.readFile(path.join(root, 'links.md'), 'utf8')).toBe('[a](./Alpha%20note.md) [b](./beta-note.md)\n')
  })
})
