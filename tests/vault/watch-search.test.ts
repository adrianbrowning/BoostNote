import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openVault, type Vault, type VaultEvent } from '../../src/vault/index.ts'

let root: string
let vault: Vault

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-watch-'))
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

/**
 * Records events; `until` resolves as soon as the recorded events satisfy `predicate`. These tests
 * drive the real `fs.watch`, so they wait for the vault's own events rather than for a duration.
 */
function collect(target: Vault) {
  const events: VaultEvent[] = []
  let waiter: { predicate: (events: VaultEvent[]) => boolean; resolve: () => void } | undefined
  target.subscribe((event) => {
    events.push(event)
    if (waiter?.predicate(events)) waiter.resolve()
  })
  return {
    events,
    until(predicate: (events: VaultEvent[]) => boolean): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>()
      if (predicate(events)) resolve()
      else waiter = { predicate, resolve }
      return promise
    },
  }
}

const hasEvent = (type: VaultEvent['type'], id: string) => (list: VaultEvent[]) =>
  list.some((event) => event.type === type && event.id === id)
describe('vault index', () => {
  it('indexes tags, starred notes and ranks search results', async () => {
    await writeFile(
      path.join(root, 'alpha.md'),
      '---\ntags: [rust, lang]\nstarred: true\n---\n# Rust ownership\n\nBorrowing rules.\n',
    )
    await writeFile(path.join(root, 'beta.md'), '# Cooking\n\nRust on cast iron pans; rust removal, rust again.\n')
    await writeFile(path.join(root, 'gamma.md'), '---\ntags: [lang]\n---\n# Go notes\n\nGoroutines.\n')
    vault = await openVault(root)

    expect([...vault.index.tags()]).toEqual([
      ['lang', ['alpha.md', 'gamma.md']],
      ['rust', ['alpha.md']],
    ])
    expect(vault.index.starred().map((note) => note.id)).toEqual(['alpha.md'])
    expect(vault.index.search('rust').map((hit) => hit.id)).toEqual(['alpha.md', 'beta.md'])
    expect(vault.index.search('rust pans').map((hit) => hit.id)).toEqual(['beta.md'])
    expect(
      vault.index
        .search('#lang')
        .map((hit) => hit.id)
        .sort(),
    ).toEqual(['alpha.md', 'gamma.md'])
    expect(vault.index.search('#rust cooking')).toEqual([])
    expect(vault.index.search('GOROUTINES')[0]).toMatchObject({ id: 'gamma.md', title: 'Go notes' })
    expect(vault.index.search('   ')).toEqual([])
    expect(vault.index.get('beta.md')?.excerpt).toBe('Rust on cast iron pans; rust removal, rust again.')
  })

  it('updates the index on writes, renames and deletes', async () => {
    vault = await openVault(root)
    const note = await vault.createNote('', 'Plan', { body: '# Plan\n\nzebra\n' })
    expect(vault.index.search('zebra').map((hit) => hit.id)).toEqual([note.id])
    await vault.writeNote(note.id, { body: '# Plan\n\nlion\n' })
    expect(vault.index.search('zebra')).toEqual([])
    const renamed = await vault.renameNote(note.id, 'renamed')
    expect(vault.index.search('lion').map((hit) => hit.id)).toEqual([renamed.id])
    await vault.deleteNote(renamed.id)
    expect(vault.index.search('lion')).toEqual([])
  })
})

describe('vault watcher', () => {
  it('reports external adds, changes, removals and folder changes', async () => {
    await writeFile(path.join(root, 'a.md'), '# A\n')
    vault = await openVault(root, { watch: true, debounceMs: 30 })
    const { events, until } = collect(vault)

    await writeFile(path.join(root, 'b.md'), '# B\n')
    await until(hasEvent('note-added', 'b.md'))
    expect(vault.index.get('b.md')?.title).toBe('B')

    await writeFile(path.join(root, 'a.md'), '# A changed\n')
    await until(hasEvent('note-changed', 'a.md'))
    expect(vault.index.get('a.md')?.title).toBe('A changed')

    await mkdir(path.join(root, 'dir'))
    await rename(path.join(root, 'b.md'), path.join(root, 'dir', 'b.md'))
    await until(
      (list) =>
        hasEvent('tree-changed', 'dir')(list) &&
        hasEvent('note-removed', 'b.md')(list) &&
        hasEvent('note-added', 'dir/b.md')(list),
    )

    await unlink(path.join(root, 'a.md'))
    await until(hasEvent('note-removed', 'a.md'))
    expect(vault.index.has('a.md')).toBe(false)
    expect(events.filter((event) => event.type === 'note-changed' && event.id === 'a.md')).toHaveLength(1)
  })

  it('does not report the vault’s own writes', async () => {
    await writeFile(path.join(root, 'a.md'), '# A\n')
    await mkdir(path.join(root, 'dest'))
    vault = await openVault(root, { watch: true, debounceMs: 30 })
    const { events, until } = collect(vault)

    const created = await vault.createNote('', 'Mine')
    await vault.writeNote(created.id, { body: '# Mine\n\nedited\n' })
    await vault.writeNote('a.md', { body: '# A again\n' })
    const moved = await vault.moveNote('a.md', 'dest')
    await vault.saveAsset(moved.id, new Uint8Array([1, 2, 3]), 'bin')
    await vault.renameNote(created.id, 'Mine renamed')
    await vault.createFolder('', 'New folder')
    await vault.setFolderColor('dest', '#123456')
    await vault.deleteNote(moved.id)
    await vault.restore(moved.id)

    // A later external write is still seen. Every rescan reconciles the whole folder, so had any of
    // the writes above looked external they would be reported no later than this sentinel.
    await writeFile(path.join(root, 'external.md'), '# External\n')
    await until(hasEvent('note-added', 'external.md'))
    expect(events).toEqual([{ type: 'note-added', id: 'external.md' }])
  })

  it('ignores a rewrite that leaves the content unchanged', async () => {
    await writeFile(path.join(root, 'a.md'), '# A\n')
    vault = await openVault(root, { watch: true, debounceMs: 30 })
    const { events, until } = collect(vault)
    await writeFile(path.join(root, 'a.md'), '# A\n')
    await writeFile(path.join(root, 'sentinel.md'), '# S\n')
    await until(hasEvent('note-added', 'sentinel.md'))
    expect(events).toEqual([{ type: 'note-added', id: 'sentinel.md' }])
  })
})
