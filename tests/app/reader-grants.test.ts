import { execFileSync } from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReaderGrants } from '../../src/app/reader-grants.ts'

/** Runs around the next `open` of `node:fs/promises` (the filesystem boundary), so a test can race it. */
const fsHooks = vi.hoisted(() => ({
  aroundOpen: undefined as ((openNow: () => Promise<FileHandle>) => Promise<FileHandle>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const around = fsHooks.aroundOpen
      fsHooks.aroundOpen = undefined
      return around ? around(() => actual.open(...args)) : actual.open(...args)
    },
  }
})

let dir: string
let readers: ReaderGrants

beforeEach(async () => {
  // Real path: grants are made for real paths (macOS temp folders sit behind the `/var` symlink).
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'reader-grants-')))
  readers = new ReaderGrants()
})

afterEach(async () => {
  fsHooks.aroundOpen = undefined
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

  it('refuses a read opened through a parent folder swapped for a symlink and restored before the check', async () => {
    const granted = await file('sub/note.md', '# Granted\n')
    const other = await file('other/note.md', 'not for the page\n')
    const ticket = await grant(granted)
    const sub = path.join(dir, 'sub')
    const moved = path.join(dir, 'sub-moved')
    let openedOther = false
    // The folder is a symlink while the file is opened and whole again for every later check.
    fsHooks.aroundOpen = async (openNow) => {
      await rename(sub, moved)
      await symlink(path.join(dir, 'other'), sub)
      try {
        const handle = await openNow()
        openedOther = (await handle.stat()).ino === (await stat(other)).ino
        return handle
      } finally {
        await rm(sub)
        await rename(moved, sub)
      }
    }
    expect(await readers.read(ticket)).toBeUndefined()
    // The race happened: the handle was the other file, and the path was whole again afterwards.
    expect(openedOther).toBe(true)
    expect(await realpath(granted)).toBe(granted)
    // Nothing raced this read: the granted file again.
    expect(await readers.read(ticket)).toBe('# Granted\n')
  })

  it('reads, under the same ticket, another regular file renamed over the granted one', async () => {
    const replaced = await file('replaced.md', '# Old\n')
    const ticket = await grant(replaced)
    // An atomic save: a new file renamed over the granted one.
    await rename(await file('next.md', '# New\n'), replaced)
    expect(await readers.read(ticket)).toBe('# New\n')
    expect(await readers.grant(replaced)).toBe(ticket)
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

  it('imports a ticket’s file once: the ticket ends when the import resolves, a second import is refused', async () => {
    const granted = await file('once.md', '# Once\n')
    const ticket = await grant(granted)
    const seen: string[] = []
    const run = async (target: string) => {
      seen.push(target)
      return 'imported'
    }
    expect(await readers.importOnce(ticket, run)).toBe('imported')
    expect(await readers.importOnce(ticket, run)).toBeUndefined()
    expect(seen).toEqual([granted])
    expect(readers.path(ticket)).toBeUndefined()
    // The file may be opened again later: a new ticket.
    expect(await readers.grant(granted)).not.toBe(ticket)
  })

  it('refuses a second import while the first runs, and keeps the ticket when the import fails', async () => {
    const ticket = await grant(await file('fail.md', '# Fail\n'))
    const { promise: failing, reject } = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const first = readers.importOnce(ticket, () => {
      started.resolve()
      return failing
    })
    expect(await readers.importOnce(ticket, async () => 'again')).toBeUndefined()
    await started.promise
    reject(new Error('disk full'))
    await expect(first).rejects.toThrow('disk full')
    expect(await readers.read(ticket)).toBe('# Fail\n')
    expect(await readers.importOnce(ticket, async () => 'retried')).toBe('retried')
  })

  it('imports nothing for an unknown ticket or a file that is gone', async () => {
    const gone = await file('gone.md', '# Gone\n')
    const ticket = await grant(gone)
    await rm(gone)
    const run = vi.fn(async () => 'imported')
    expect(await readers.importOnce(ticket, run)).toBeUndefined()
    expect(await readers.importOnce('made-up', run)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('hands the import a read of the granted file and of files in its folder only, with their bytes and times', async () => {
    const granted = await file('doc/note.md', '# Note\n')
    const pic = await file('doc/img/pic.png', 'PNG')
    const other = await file('doc/other.md', '# Other\n')
    const secret = await file('secret.png', 'not for the page')
    const ticket = await grant(granted)
    const reads = await readers.importOnce(ticket, async (target, read) => ({
      note: await read(target, 'note'),
      pic: await read(pic, 'asset'),
      otherNote: await read(other, 'note'),
      outside: await read(secret, 'asset'),
    }))
    expect(reads?.note?.data.toString()).toBe('# Note\n')
    expect(reads?.note?.mtime).toEqual((await stat(granted)).mtime)
    expect(reads?.pic?.data.toString()).toBe('PNG')
    // Only the granted file is the note; linked files must lie in its folder.
    expect(reads?.otherNote).toBeUndefined()
    expect(reads?.outside).toBeUndefined()
  })

  it('refuses the import’s read of a file or a linked file’s parent folder swapped for a symlink after the check', async () => {
    const granted = await file('doc/swap.md', '# Granted\n')
    const secret = await file('secret.md', 'not for the page\n')
    const pic = await file('doc/pic.png', 'PNG')
    const inner = await file('doc/img/inner.png', 'PNG')
    await file('elsewhere/inner.png', 'not for the page')
    const ticket = await grant(granted)
    const result = await readers.importOnce(ticket, async (target, read) => {
      // Between `importOnce`'s own check (and the import's `realpath`) and its read of each file.
      await rm(target)
      await symlink(secret, target)
      await rm(pic)
      await symlink(secret, pic)
      await rm(path.join(dir, 'doc', 'img'), { recursive: true })
      await symlink(path.join(dir, 'elsewhere'), path.join(dir, 'doc', 'img'))
      return {
        note: await read(target, 'note'),
        pic: await read(pic, 'asset'),
        inner: await read(inner, 'asset'),
      }
    })
    expect(result).toEqual({ note: undefined, pic: undefined, inner: undefined })
  })
})
