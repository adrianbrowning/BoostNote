import { describe, expect, it } from 'vitest'

import { linkMovesAfterRelocate, linksUpdatedNotice } from '../../src/app/actions/public/workspace/relocate.ts'

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

describe('sticky assets warning', () => {
  it('a notice carrying the assets warning stays until closed', () => {
    const outcome = linkMovesAfterRelocate({ from: 'a.md', result: { id: 'b.md', assetsLeftBehind: 'a.assets' } })
    expect(outcome.sticky).toBe(true)
    expect(outcome.warning).toContain('a.assets')
  })

  it('an ordinary notice closes on its own', () => {
    const outcome = linkMovesAfterRelocate({ from: 'a.md', result: { id: 'sub/a.md' }, done: 'Moved to sub' })
    expect(outcome.sticky).toBe(false)
    expect(outcome.warning).toBeUndefined()
  })

  it('the links-updated notice keeps the assets warning and stays', () => {
    const notice = linksUpdatedNotice(3, 'The assets folder a.assets stayed in place')
    expect(notice).toEqual({ text: 'Updated 3 links. The assets folder a.assets stayed in place', sticky: true })
  })

  it('the links-updated notice without a warning closes on its own', () => {
    expect(linksUpdatedNotice(1)).toEqual({ text: 'Updated 1 link', sticky: false })
  })
})
