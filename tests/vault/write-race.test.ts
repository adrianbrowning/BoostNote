import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as files from '../../src/vault/files.ts'
import { openVault, type Vault } from '../../src/vault/index.ts'

// Lets a test run code in the window between the vault's last read and its atomic rename.
vi.mock('../../src/vault/files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof files>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const realWriteFileAtomic = (await vi.importActual<typeof files>('../../src/vault/files.ts')).writeFileAtomic

describe('writeNote baseHash', () => {
  let root: string
  let vault: Vault

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'boost-write-race-'))
    await writeFile(path.join(root, 'note.md'), '# Note\n\nOriginal.\n')
    vault = await openVault(root)
  })

  afterEach(async () => {
    vi.mocked(files.writeFileAtomic).mockImplementation(realWriteFileAtomic)
    await vault.close()
    await rm(root, { recursive: true, force: true })
  })

  it('keeps an outside write that lands after the check and before the rename', async () => {
    const { hash } = await vault.readNote('note.md')
    vi.mocked(files.writeFileAtomic).mockImplementationOnce(async (file, data, beforeReplace) => {
      await writeFile(file, '# Note\n\nWritten by an agent.\n')
      return realWriteFileAtomic(file, data, beforeReplace)
    })

    await expect(vault.writeNote('note.md', { body: '# Note\n\nMine.\n', baseHash: hash })).rejects.toMatchObject({
      code: 'CHANGED',
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# Note\n\nWritten by an agent.\n')
  })

  it('rejects a stale base hash without touching the file', async () => {
    await expect(vault.writeNote('note.md', { body: 'Mine.\n', baseHash: 'stale' })).rejects.toMatchObject({
      code: 'CHANGED',
    })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# Note\n\nOriginal.\n')
  })

  it('treats a null base hash as "must not exist"', async () => {
    await expect(vault.writeNote('note.md', { body: 'Mine.\n', baseHash: null })).rejects.toMatchObject({
      code: 'CHANGED',
    })
    await vault.writeNote('new.md', { body: 'Fresh.\n', baseHash: null })
    expect(await readFile(path.join(root, 'new.md'), 'utf8')).toContain('Fresh.')
  })

  it('writes when the base hash matches', async () => {
    const { hash } = await vault.readNote('note.md')
    const saved = await vault.writeNote('note.md', { body: '# Note\n\nMine.\n', baseHash: hash })
    expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe(saved.raw)
    expect(saved.body).toContain('Mine.')
  })
})
