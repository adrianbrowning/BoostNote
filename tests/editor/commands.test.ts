import { describe, expect, it } from 'vitest'

import { indentListItem, insertLink, outdentListItem, toggleInlineMarker } from '../../src/editor/commands.ts'
import { continueMarkup } from '../../src/editor/language.ts'
import { docWithSelection, markdownState, runCommand } from './helpers.ts'

const apply = (doc: string, command: Parameters<typeof runCommand>[1]) => {
  const next = runCommand(markdownState(doc), command)
  return next ? docWithSelection(next) : undefined
}

describe('inline format toggles', () => {
  const bold = toggleInlineMarker('**')
  const italic = toggleInlineMarker('*')

  it('wraps the selection and keeps it selected', () => {
    expect(apply('a «word» b', bold)).toBe('a **«word»** b')
    expect(apply('a «word» b', toggleInlineMarker('`'))).toBe('a `«word»` b')
    expect(apply('a «word» b', toggleInlineMarker('~~'))).toBe('a ~~«word»~~ b')
  })

  it('unwraps when the markers surround or are inside the selection', () => {
    expect(apply('a **«word»** b', bold)).toBe('a «word» b')
    expect(apply('a «**word**» b', bold)).toBe('a «word» b')
    expect(apply('a *«word»* b', italic)).toBe('a «word» b')
  })

  it('does not mistake bold for italic', () => {
    expect(apply('a **«word»** b', italic)).toBe('a ***«word»*** b')
    expect(apply('a ***«word»*** b', italic)).toBe('a **«word»** b')
  })

  it('inserts an empty pair at a cursor', () => {
    expect(apply('a ‸ b', bold)).toBe('a **‸** b')
    expect(apply('a **‸** b', bold)).toBe('a ‸ b')
  })

  it('Mod-K turns the selection into a link with the URL selected', () => {
    expect(apply('see «docs»', insertLink)).toBe('see [docs](«url»)')
    expect(apply('see «https://example.com»', insertLink)).toBe('see [‸](https://example.com)')
    expect(apply('see ‸', insertLink)).toBe('see [‸](url)')
  })
})

describe('list continuation (Enter)', () => {
  it('continues bullets, numbers and tasks', () => {
    expect(apply('- one‸', continueMarkup)).toBe('- one\n- ‸')
    expect(apply('1. one‸', continueMarkup)).toBe('1. one\n2. ‸')
    expect(apply('- [x] done‸', continueMarkup)).toBe('- [x] done\n- [ ] ‸')
    expect(apply('> quote‸', continueMarkup)).toBe('> quote\n> ‸')
  })

  it('ends the list on an empty item', () => {
    expect(apply('- one\n- ‸', continueMarkup)).toBe('- one\n\n‸')
    expect(apply('- [ ] one\n- [ ] ‸', continueMarkup)).toBe('- [ ] one\n\n‸')
    expect(apply('1. one\n2. ‸', continueMarkup)).toBe('1. one\n\n‸')
  })
})

describe('list indentation (Tab / Shift-Tab)', () => {
  it('nests an item under its previous sibling by the sibling marker width', () => {
    expect(apply('- one\n- tw‸o', indentListItem)).toBe('- one\n  - tw‸o')
    expect(apply('1. one\n2. tw‸o', indentListItem)).toBe('1. one\n   2. tw‸o')
  })

  it('outdents to the parent indentation', () => {
    expect(apply('1. one\n   - tw‸o', outdentListItem)).toBe('1. one\n- tw‸o')
    expect(apply('- a\n  - b\n    - c‸', outdentListItem)).toBe('- a\n  - b\n  - c‸')
  })

  it('declines outside lists so Tab falls through', () => {
    expect(apply('plain‸', indentListItem)).toBeUndefined()
    expect(apply('- top‸', outdentListItem)).toBeUndefined()
  })
})
