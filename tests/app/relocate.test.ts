import { describe, expect, it } from 'vitest'

import { linkMovesAfterRelocate } from '../../src/app/actions/public/workspace/relocate.ts'

describe('linkMovesAfterRelocate', () => {
  it('a twin rename leaves the shared assets out of the link move and names the folder', () => {
    const outcome = linkMovesAfterRelocate({ from: 'a.md', result: { id: 'b.md', assetsLeftBehind: 'a.assets' } })
    expect(outcome.moves).toEqual([{ from: 'a.md', to: 'b.md', kind: 'note', assets: false }])
    expect(outcome.notice).toContain('a.assets')
  })

  it('a twin move keeps the done text and names the shared folder', () => {
    const outcome = linkMovesAfterRelocate({
      from: 'a.MD',
      result: { id: 'sub/a.MD', assetsLeftBehind: 'a.assets' },
      done: 'Moved to sub',
    })
    expect(outcome.moves).toEqual([{ from: 'a.MD', to: 'sub/a.MD', kind: 'note', assets: false }])
    expect(outcome.notice).toMatch(/^Moved to sub\. .*a\.assets/)
  })

  it('an ordinary rename moves the assets with the note and gives no notice', () => {
    const outcome = linkMovesAfterRelocate({ from: 'a.md', result: { id: 'b.md' } })
    expect(outcome.moves).toEqual([{ from: 'a.md', to: 'b.md', kind: 'note' }])
    expect(outcome.notice).toBeUndefined()
  })

  it('an ordinary move gives only the done text', () => {
    const outcome = linkMovesAfterRelocate({ from: 'a.md', result: { id: 'sub/a.md' }, done: 'Moved to sub' })
    expect(outcome.moves).toEqual([{ from: 'a.md', to: 'sub/a.md', kind: 'note' }])
    expect(outcome.notice).toBe('Moved to sub')
  })

  it('a twin restore names the shared folder and offers no link moves', () => {
    const outcome = linkMovesAfterRelocate({
      result: { id: 'a.md', assetsLeftBehind: 'a.assets' },
      done: 'Restored a.md',
    })
    expect(outcome.moves).toEqual([])
    expect(outcome.notice).toMatch(/^Restored a\.md\. .*a\.assets/)
  })

  it('an ordinary restore has no warning', () => {
    const outcome = linkMovesAfterRelocate({ result: { id: 'a.md' }, done: 'Restored a.md' })
    expect(outcome.notice).toBe('Restored a.md')
  })
})
