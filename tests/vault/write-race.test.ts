import { writeFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  const read = (name: string) => readFile(path.join(root, name), 'utf8')

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

    const result = await vault.writeNote('note.md', { body: '# Note\n\nMine.\n', baseHash: hash })
    expect(await read('note.md')).toBe('# Note\n\nWritten by an agent.\n')
    expect(result.status).toBe('conflict')
    expect(result.status === 'conflict' && result.current?.raw).toBe('# Note\n\nWritten by an agent.\n')
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns a conflict with the current note for a stale base hash without touching the file', async () => {
    const result = await vault.writeNote('note.md', { body: 'Mine.\n', baseHash: 'stale' })
    expect(await read('note.md')).toBe('# Note\n\nOriginal.\n')
    expect(result).toMatchObject({ status: 'conflict', current: { id: 'note.md', raw: '# Note\n\nOriginal.\n' } })
  })

  it('treats a null base hash as "must not exist"', async () => {
    const existing = await vault.writeNote('note.md', { body: 'Mine.\n', baseHash: null })
    expect(existing).toMatchObject({ status: 'conflict', current: { raw: '# Note\n\nOriginal.\n' } })
    const created = await vault.writeNote('new.md', { body: 'Fresh.\n', baseHash: null })
    expect(created.status).toBe('saved')
    expect(await read('new.md')).toContain('Fresh.')
  })

  it('returns a conflict with no current note when a string base hash names a missing note', async () => {
    expect(await vault.writeNote('gone.md', { body: 'Mine.\n', baseHash: 'abc' })).toEqual({
      status: 'conflict',
      current: null,
    })
    await expect(read('gone.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('saves when the base hash matches', async () => {
    const { hash } = await vault.readNote('note.md')
    const result = await vault.writeNote('note.md', { body: '# Note\n\nMine.\n', baseHash: hash })
    if (result.status !== 'saved') throw new Error('expected saved')
    expect(await read('note.md')).toBe(result.note.raw)
    expect(result.note.body).toContain('Mine.')
    expect(result.note.hash).not.toBe(hash)
    expect(result.note.hash).toBe((await vault.readNote('note.md')).hash)
  })
})

describe('editNote', () => {
  let root: string
  let vault: Vault
  const original = '# Note\n\nOriginal.\n'
  const read = () => readFile(path.join(root, 'note.md'), 'utf8')
  const append = (note: { body: string }) => ({ body: `${note.body}Added.\n` })

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'boost-edit-race-'))
    await writeFile(path.join(root, 'note.md'), original)
    vault = await openVault(root)
  })

  afterEach(async () => {
    vi.mocked(files.writeFileAtomic).mockImplementation(realWriteFileAtomic)
    await vault.close()
    await rm(root, { recursive: true, force: true })
  })

  it('applies the edit to the note read when the base hash matches', async () => {
    const { hash } = await vault.readNote('note.md')
    const result = await vault.editNote('note.md', hash, (note) => ({
      body: `${note.body}Added.\n`,
      frontmatter: { ...note.frontmatter, tag: 'x' },
    }))
    if (result.status !== 'saved') throw new Error('expected saved')
    expect(result.note.body).toBe('# Note\n\nOriginal.\nAdded.\n')
    expect(result.note.frontmatter.tag).toBe('x')
    expect(await read()).toBe(result.note.raw)
  })

  it('returns a conflict for a stale base hash without running the edit or touching the file', async () => {
    const edit = vi.fn(append)
    const result = await vault.editNote('note.md', 'stale', edit)
    expect(result).toMatchObject({ status: 'conflict', current: { raw: original } })
    expect(edit).not.toHaveBeenCalled()
    expect(await read()).toBe(original)
  })

  it('returns a conflict with the newer note when the caller hash is older than the file (ABA)', async () => {
    const { hash: a } = await vault.readNote('note.md')
    await writeFile(path.join(root, 'note.md'), '# Note\n\nB.\n')
    const edit = vi.fn(append)
    const result = await vault.editNote('note.md', a, edit)
    expect(result).toMatchObject({ status: 'conflict', current: { raw: '# Note\n\nB.\n' } })
    expect(edit).not.toHaveBeenCalled()
    expect(await read()).toBe('# Note\n\nB.\n')
  })

  it('saves against the hash it read, so a write restoring an older file during the edit conflicts', async () => {
    await writeFile(path.join(root, 'note.md'), '# Note\n\nB.\n')
    const result = await vault.editNote('note.md', undefined, (note) => {
      writeFileSync(path.join(root, 'note.md'), original)
      return append(note)
    })
    expect(result).toMatchObject({ status: 'conflict', current: { raw: original } })
    expect(await read()).toBe(original)
  })

  it('keeps an outside write that lands after the check and before the rename', async () => {
    const { hash } = await vault.readNote('note.md')
    vi.mocked(files.writeFileAtomic).mockImplementationOnce(async (file, data, beforeReplace) => {
      await writeFile(file, '# Note\n\nWritten by an agent.\n')
      return realWriteFileAtomic(file, data, beforeReplace)
    })
    const result = await vault.editNote('note.md', hash, append)
    expect(result).toMatchObject({ status: 'conflict', current: { raw: '# Note\n\nWritten by an agent.\n' } })
    expect(await read()).toBe('# Note\n\nWritten by an agent.\n')
  })

  it('returns a conflict with no current note when a base hash names a missing note', async () => {
    const edit = vi.fn(append)
    expect(await vault.editNote('gone.md', 'abc', edit)).toEqual({ status: 'conflict', current: null })
    expect(edit).not.toHaveBeenCalled()
  })
})

async function tempVault(): Promise<{ root: string; vault: Vault } & AsyncDisposable> {
  const root = await mkdtemp(path.join(tmpdir(), 'boost-write-yaml-'))
  const vault = await openVault(root)
  return {
    root,
    vault,
    async [Symbol.asyncDispose]() {
      await vault.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('writeNote frontmatter', () => {
  it('keeps the YAML of values sent back unchanged after a JSON round trip and writes edited keys', async () => {
    await using temp = await tempVault()
    const { root, vault } = temp
    await writeFile(
      path.join(root, 'y.md'),
      '---\nratio: .nan\nquoted: "keep me" # note\ntitle: Old\ncreated: 2020-01-01T00:00:00.000Z\n---\nBody\n',
    )
    await vault.refresh()
    const before = await vault.readNote('y.md')
    const sent = JSON.parse(JSON.stringify({ ...before.frontmatter, title: 'New' })) as Record<string, unknown>
    const result = await vault.writeNote('y.md', { body: 'Body\n', baseHash: before.hash, frontmatter: sent })
    expect(result.status).toBe('saved')
    const raw = await readFile(path.join(root, 'y.md'), 'utf8')
    expect(raw).toContain('ratio: .nan\n')
    expect(raw).toContain('quoted: "keep me" # note\n')
    expect(raw).toContain('title: New\n')
  })

  it('writes keys named like inherited object properties as sent', async () => {
    await using temp = await tempVault()
    const { root, vault } = temp
    const result = await vault.writeNote('p.md', { body: 'Body\n', baseHash: null, frontmatter: { toString: null } })
    expect(result.status).toBe('saved')
    expect(await readFile(path.join(root, 'p.md'), 'utf8')).toContain('toString: null\n')
  })
})
