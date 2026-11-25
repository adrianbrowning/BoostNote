import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appearedWhilePending } from './appeared-while-pending.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'appeared-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('appearedWhilePending', () => {
  it('resolves once the file appears while the work is still under way', async () => {
    const file = path.join(dir, 'c.md')
    const { promise: pending, resolve: finish } = Promise.withResolvers<void>()
    const waiting = appearedWhilePending(file, pending)
    let done = false
    void waiting.then(() => {
      done = true
    })
    for (let i = 0; i < 5; i++) await setImmediate()
    expect(done).toBe(false)
    await writeFile(file, 'C\n')
    await expect(waiting).resolves.toBeUndefined()
    finish()
  })

  it("rejects with the work's own error when it fails before the file appears", { timeout: 1000 }, async () => {
    await expect(appearedWhilePending(path.join(dir, 'c.md'), Promise.reject(new Error('EXISTS')))).rejects.toThrow(
      'EXISTS',
    )
  })

  it('fails when the work settled before the file was seen', { timeout: 1000 }, async () => {
    const file = path.join(dir, 'c.md')
    await writeFile(file, 'C\n')
    const done = Promise.resolve()
    await done
    await expect(appearedWhilePending(file, done)).rejects.toThrow('settled before the file was seen')
  })
})
