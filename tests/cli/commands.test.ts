import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveNoteId, restoreFromTrash } from '../../src/cli/commands.ts'
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
