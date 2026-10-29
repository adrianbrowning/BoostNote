import { describe, expect, it } from 'vitest'

import { ReaderGrants } from '../../src/app/reader-grants.ts'

describe('ReaderGrants', () => {
  it('gives one live ticket per file, read any number of times until revoked', () => {
    const readers = new ReaderGrants()
    const first = readers.grant('/outside/a.md')
    const second = readers.grant('/outside/b.md')
    expect(first).not.toBe(second)
    expect(readers.grant('/outside/a.md')).toBe(first)

    expect(readers.path(first)).toBe('/outside/a.md')
    expect(readers.path(first)).toBe('/outside/a.md')
    expect(readers.path(second)).toBe('/outside/b.md')

    expect(readers.revoke(first)).toBe(true)
    expect(readers.path(first)).toBeUndefined()
    expect(readers.path(second)).toBe('/outside/b.md')
    // A revoked file gets a new ticket the next time it is opened.
    const again = readers.grant('/outside/a.md')
    expect(again).not.toBe(first)
    expect(readers.path(again)).toBe('/outside/a.md')

    expect(readers.path('made-up')).toBeUndefined()
    expect(readers.revoke('made-up')).toBe(false)
    expect(readers.revoke(first)).toBe(false)
  })
})
