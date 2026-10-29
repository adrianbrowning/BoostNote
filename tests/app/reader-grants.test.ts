import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ReaderGrants } from '../../src/app/reader-grants.ts'

let dir: string
let readers: ReaderGrants

beforeEach(async () => {
  // Real path: grants are made for real paths (macOS temp folders sit behind the `/var` symlink).
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'reader-grants-')))
  readers = new ReaderGrants()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(name: string, text: string): Promise<string> {
  const target = path.join(dir, name)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
  return target
}

/** A ticket for `target`, failing the test when the grant is refused. */
async function grant(target: string): Promise<string> {
  const ticket = await readers.grant(target)
  if (ticket === undefined) throw new Error(`No grant for ${target}`)
  return ticket
}

describe('ReaderGrants', () => {
  it('gives one opaque live ticket per file, read fresh any number of times until revoked', async () => {
    const a = await file('a.md', '# A\n')
    const b = await file('b.md', '# B\n')
    const first = await grant(a)
    const second = await grant(b)
    // 48 lowercase hex characters from randomBytes(24): no room to carry the path.
    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(second).toMatch(/^[0-9a-f]{48}$/)
    expect(first).not.toBe(second)
    expect(await readers.grant(a)).toBe(first)

    expect(readers.path(first)).toBe(a)
    expect(await readers.read(first)).toBe('# A\n')
    await writeFile(a, 'Changed\n')
    expect(await readers.read(first)).toBe('Changed\n')
    expect(await readers.read(second)).toBe('# B\n')

    expect(readers.revoke(first)).toBe(true)
    expect(readers.path(first)).toBeUndefined()
    expect(await readers.read(first)).toBeUndefined()
    expect(await readers.read(second)).toBe('# B\n')
    // A revoked file gets a new ticket the next time it is opened.
    const again = await grant(a)
    expect(again).not.toBe(first)
    expect(await readers.read(again)).toBe('Changed\n')

    expect(readers.path('made-up')).toBeUndefined()
    expect(await readers.read('made-up')).toBeUndefined()
    expect(readers.revoke('made-up')).toBe(false)
    expect(readers.revoke(first)).toBe(false)
  })

  it('grants only a regular file at its real path', async () => {
    const a = await file('a.md', '# A\n')
    expect(await readers.grant(path.join(dir, 'missing.md'))).toBeUndefined()
    await mkdir(path.join(dir, 'folder.md'))
    expect(await readers.grant(path.join(dir, 'folder.md'))).toBeUndefined()
    await symlink(a, path.join(dir, 'link.md'))
    expect(await readers.grant(path.join(dir, 'link.md'))).toBeUndefined()
    await symlink(dir, path.join(dir, 'linked'))
    expect(await readers.grant(path.join(dir, 'linked', 'a.md'))).toBeUndefined()
  })

  it('refuses a granted file swapped for a symlink, never reading the link target', async () => {
    await file('secret.txt', 'not for the page\n')
    const swapped = await file('swapped.md', '# Granted\n')
    const ticket = await grant(swapped)
    await rm(swapped)
    await symlink(path.join(dir, 'secret.txt'), swapped)
    expect(await readers.read(ticket)).toBeUndefined()
  })

  it('refuses a granted file whose folder was swapped for a symlink to another file of that name', async () => {
    const granted = await file('sub/note.md', '# Granted\n')
    await file('other/note.md', 'not for the page\n')
    const ticket = await grant(granted)
    await rename(path.join(dir, 'sub'), path.join(dir, 'sub-moved'))
    await symlink(path.join(dir, 'other'), path.join(dir, 'sub'))
    expect(await readers.read(ticket)).toBeUndefined()
  })

  it('refuses a granted file replaced by another one; opened again, the new file gets its own ticket', async () => {
    const replaced = await file('replaced.md', '# Old\n')
    const old = await grant(replaced)
    // An atomic save: a new file renamed over the granted one.
    await rename(await file('next.md', '# New\n'), replaced)
    expect(await readers.read(old)).toBeUndefined()

    const fresh = await grant(replaced)
    expect(fresh).not.toBe(old)
    expect(await readers.read(fresh)).toBe('# New\n')
    // The old ticket never comes to read the new file.
    expect(readers.path(old)).toBeUndefined()
    expect(await readers.read(old)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('refuses a granted file swapped for a FIFO without blocking', async () => {
    const swapped = await file('pipe.md', '# Granted\n')
    const ticket = await grant(swapped)
    await rm(swapped)
    execFileSync('mkfifo', [swapped])
    expect(await readers.read(ticket)).toBeUndefined()
    expect(await readers.grant(swapped)).toBeUndefined()
  })

  it('refuses a granted file that is gone', async () => {
    const gone = await file('gone.md', '# Gone\n')
    const ticket = await grant(gone)
    await rm(gone)
    expect(await readers.read(ticket)).toBeUndefined()
  })
})
