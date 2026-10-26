import { describe, expect, it } from 'vitest'

import { DropGrants } from '../../src/app/drop-grants.ts'

describe('DropGrants', () => {
  it('redeems a ticket once, and not after it expires', () => {
    let now = 1_000
    const drops = new DropGrants(() => now)
    const first = drops.grant(['/a.md'])
    const second = drops.grant(['/b.md'])
    expect(first).not.toBe(second)
    expect(drops.take(first)).toEqual(['/a.md'])
    expect(drops.take(first)).toBeUndefined()
    now += 60_000
    expect(drops.take(second)).toBeUndefined()
    expect(drops.take('made-up')).toBeUndefined()
  })
})
