import { describe, expect, it } from 'vitest'

import { resolveNoteLink } from '../../src/app/actions/public/workspace/paths.ts'

describe('resolveNoteLink', () => {
  it('resolves relative note links, with or without a slash before the fragment', () => {
    expect(resolveNoteLink('Guides/ch4.md', 'ch3.md/#user-content-curry')).toBe('Guides/ch3.md')
    expect(resolveNoteLink('Guides/ch4.md', 'ch3.md#curry')).toBe('Guides/ch3.md')
    expect(resolveNoteLink('Guides/ch4.md', '../Default/Git%20cheat%20sheet.md/?x=1')).toBe(
      'Default/Git cheat sheet.md',
    )
  })

  it('ignores folders, other files, absolute and external links, and links leaving the vault', () => {
    expect(resolveNoteLink('Guides/ch4.md', 'notes/')).toBeUndefined()
    expect(resolveNoteLink('Guides/ch4.md', 'ch3.assets/a.png')).toBeUndefined()
    expect(resolveNoteLink('Guides/ch4.md', 'https://example.com/a.md')).toBeUndefined()
    expect(resolveNoteLink('Guides/ch4.md', '#top')).toBeUndefined()
    expect(resolveNoteLink('Guides/ch4.md', '../../out.md')).toBeUndefined()
  })
})
