import { describe, expect, it } from 'vitest'

import { isExtensionCaseTwin } from '../../src/vault/names.ts'

describe('isExtensionCaseTwin', () => {
  it.each([
    ['Cafe\u0301.md', 'Caf\u00e9.MD', true],
    ['a.md', 'a.MD', true],
    ['a.md', 'b.md', false],
    ['a.md', 'a.txt', false],
    ['a.md', 'A.md', false],
  ])('%s and %s → %s', (a, b, twin) => {
    expect(isExtensionCaseTwin(a, b)).toBe(twin)
  })
})
