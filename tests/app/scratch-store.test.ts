import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScratchStore } from '../../src/app/scratch-store.ts'

/** Renames onto a file this names fail, as a full disk would (`null`: none). */
const failing = vi.hoisted(() => ({ rename: null as ((target: string) => boolean) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (failing.rename?.(String(to))) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
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
})
