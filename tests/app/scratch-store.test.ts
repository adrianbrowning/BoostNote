import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScratchStore } from '../../src/app/scratch-store.ts'

/** Renames onto a file this names fail, as a full disk would (`null`: none). */
const failing = vi.hoisted(() => ({ rename: null as ((target: string) => boolean) | null }))
/** A rename onto a file this names waits for the promise it returns (`null`: none). */
const holding = vi.hoisted(() => ({ rename: null as ((target: string) => Promise<void> | undefined) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (failing.rename?.(String(to))) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
      await holding.rename?.(String(to))
      return fs.rename(from, to)
    },
  }
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'boostnote-scratch-'))
})

afterEach(async () => {
  failing.rename = null
  holding.rename = null
  await rm(dir, { recursive: true, force: true })
})

describe('ScratchStore.create', () => {
  it('leaves no file in the scratch folder when the note’s file cannot be written', async () => {
    const store = new ScratchStore(dir)
    failing.rename = (target) => target.endsWith('.md')

    await expect(store.create()).rejects.toThrow('ENOSPC')

    expect(await readdir(dir)).toEqual([])
    failing.rename = null
    expect(await store.list()).toEqual([])
  })

  it('leaves no file in the scratch folder when the note’s sidecar cannot be written', async () => {
    const store = new ScratchStore(dir)
    failing.rename = (target) => target.endsWith('.json')

    await expect(store.create()).rejects.toThrow('ENOSPC')

    expect(await readdir(dir)).toEqual([])
    failing.rename = null
    expect(await store.list()).toEqual([])
  })
})

describe('ScratchStore with a lost sidecar', () => {
  it('still reads and lists the note, with its file’s birth time, when the sidecar cannot be written again', async () => {
    const store = new ScratchStore(dir)
    const { id } = await store.create()
    await rm(path.join(dir, `${id}.json`))
    const born = (await stat(path.join(dir, `${id}.md`))).birthtime.toISOString()
    failing.rename = (target) => target.endsWith('.json')

    expect((await store.read(id)).created).toBe(born)
    expect((await store.list()).map((note) => ({ id: note.id, created: note.created }))).toEqual([
      { id, created: born },
    ])
    failing.rename = null
    expect((await store.read(id)).created).toBe(born)
    expect(await readdir(dir)).toEqual([`${id}.json`, `${id}.md`].sort())
  })

  it('keeps the note’s original birth time when the first operation after the loss is a write', async () => {
    const store = new ScratchStore(dir)
    const { id } = await store.create()
    await rm(path.join(dir, `${id}.json`))
    const born = (await stat(path.join(dir, `${id}.md`))).birthtime.toISOString()
    // A real pause: the replacement file's birth time comes from the file system's clock.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect((await store.write(id, 'text')).created).toBe(born)
    expect((await store.read(id)).created).toBe(born)
  })
})

describe('ScratchStore.write and discard of one note', () => {
  it('keeps a discard sent while a write waits on its rename from being undone by that rename', async () => {
    const store = new ScratchStore(dir)
    const { id } = await store.create()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const atRename = new Promise<void>((resolve) => {
      reached = resolve
    })
    holding.rename = (target) => {
      if (!target.endsWith(`${id}.md`)) return undefined
      holding.rename = null
      reached()
      return held
    }

    const writing = store.write(id, 'text')
    await atRename
    const discarding = store.discard(id)
    release()
    await writing
    await discarding

    expect(await readdir(dir)).toEqual([])
    await expect(store.write(id, 'late')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await readdir(dir)).toEqual([])
  })
})
