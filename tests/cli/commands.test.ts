import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { restoreFromTrash } from '../../src/cli/commands.ts'
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
