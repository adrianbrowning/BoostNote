import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveNote, renameNote, resolveNoteId, restoreFromTrash, trashNote } from '../../src/cli/commands.ts'
import { openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cli-commands-'))
  vault = await openVault(root)
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

describe('restoreFromTrash', () => {
  it('restores a trashed folder and reports its kind', async () => {
    await vault.createFolder('', 'Ideas')
    await writeFile(path.join(root, 'Ideas', 'plan.md'), '# Plan\n')
    const trashed = await vault.deleteFolder('Ideas')
    expect(await restoreFromTrash(vault, ` ${trashed.id} `)).toEqual({ id: 'Ideas', kind: 'folder' })
    expect(vault.folders).toContain('Ideas')
  })
})

describe('resolveNoteId', () => {
  it('finds an upper-case .MD note by its path with no extension or a lowercase .md', async () => {
    await vault.createFolder('', 'ideas')
    await writeFile(path.join(root, 'ideas', 'Roadmap.MD'), '# Roadmap\n')
    await vault.refresh()
    expect(await resolveNoteId(vault, 'ideas/Roadmap')).toBe('ideas/Roadmap.MD')
    expect(await resolveNoteId(vault, 'ideas/Roadmap.md')).toBe('ideas/Roadmap.MD')
  })

  it('rejects a path with no extension that matches extension-case twins as ambiguous', async (ctx) => {
    await mkdir(path.join(root, 'twins'))
    await writeFile(path.join(root, 'twins', 'a.md'), 'lower\n')
    await writeFile(path.join(root, 'twins', 'a.MD'), 'upper\n')
    if ((await readdir(path.join(root, 'twins'))).length !== 2) ctx.skip()
    await vault.refresh()
    await expect(resolveNoteId(vault, 'twins/a')).rejects.toMatchObject({
      code: 'AMBIGUOUS',
      details: { matches: expect.arrayContaining(['twins/a.md', 'twins/a.MD']) },
    })
  })
})

describe('extension-case twins (a.md beside a.MD)', () => {
  const lowerBody = 'lower ![x](./a.assets/x.png)\n'
  const upperBody = 'upper ![x](./a.assets/x.png)\n'
  const indexBody = '![x](work/a.assets/x.png)\n'

  /** Seeds `work/a.md` and `work/a.MD` sharing `work/a.assets`; false when the file system folds them into one file. */
  async function seedTwins(): Promise<boolean> {
    await mkdir(path.join(root, 'work', 'a.assets'), { recursive: true })
    await writeFile(path.join(root, 'work', 'a.md'), lowerBody)
    await writeFile(path.join(root, 'work', 'a.MD'), upperBody)
    await writeFile(path.join(root, 'work', 'a.assets', 'x.png'), 'X')
    await writeFile(path.join(root, 'index.md'), indexBody)
    if ((await readdir(path.join(root, 'work'))).length !== 3) return false
    await vault.refresh()
    return true
  }

  const read = (id: string) => readFile(path.join(root, id), 'utf8')

  it('renames one twin, says the assets folder stayed, and leaves links into it alone', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    const result = await renameNote(vault, 'work/a.md', 'b')
    expect(result).toMatchObject({ id: 'work/b.md', previousId: 'work/a.md', assetsLeftBehind: 'work/a.assets' })
    expect(await read('work/a.MD')).toBe(upperBody)
    expect(await read('work/b.md')).toBe(lowerBody)
    expect(await read('index.md')).toBe(indexBody)
  })

  it('moves one twin, says the assets folder stayed, and leaves links into it alone', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    await mkdir(path.join(root, 'archive'))
    await vault.refresh()
    const result = await moveNote(vault, 'work/a.MD', 'archive')
    expect(result).toMatchObject({ id: 'archive/a.MD', assetsLeftBehind: 'work/a.assets' })
    expect(await read('work/a.md')).toBe(lowerBody)
    expect(await read('index.md')).toBe(indexBody)
  })

  it('trashes one twin and says the assets folder stayed', async (ctx) => {
    if (!(await seedTwins())) ctx.skip()
    const result = await trashNote(vault, 'work/a.md')
    expect(result).toMatchObject({ trashId: 'work/a.md', assetsLeftBehind: 'work/a.assets' })
    expect(await restoreFromTrash(vault, result.trashId)).toEqual({
      id: 'work/a 2.md',
      kind: 'note',
      assetsLeftBehind: 'work/a.assets',
    })
  })
})
