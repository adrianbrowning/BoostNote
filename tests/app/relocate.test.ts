import { describe, expect, it } from 'vitest'

import {
  linksUpdatedNotice,
  linkUpdateFailedNotice,
  refreshFailedNotice,
  relocateNotice,
} from '../../src/app/actions/public/workspace/relocate.ts'

describe('relocateNotice', () => {
  it('a twin rename names the shared folder', () => {
    expect(relocateNotice({ assetsLeftBehind: 'a.assets' }).notice).toContain('a.assets')
  })

  it('a twin move keeps the done text and names the shared folder', () => {
    const outcome = relocateNotice({ assetsLeftBehind: 'a.assets', done: 'Moved to sub' })
    expect(outcome.notice).toMatch(/^Moved to sub\. .*a\.assets/)
  })

  it('an ordinary rename gives no notice', () => {
    expect(relocateNotice({}).notice).toBeUndefined()
  })

  it('an ordinary move gives only the done text', () => {
    expect(relocateNotice({ done: 'Moved to sub' }).notice).toBe('Moved to sub')
  })

  it('a twin restore names the shared folder', () => {
    const outcome = relocateNotice({ assetsLeftBehind: 'a.assets', done: 'Restored a.md' })
    expect(outcome.notice).toMatch(/^Restored a\.md\. .*a\.assets/)
  })
})

describe('sticky assets warning', () => {
  it('a notice carrying the assets warning stays until closed', () => {
    const outcome = relocateNotice({ assetsLeftBehind: 'a.assets' })
    expect(outcome.sticky).toBe(true)
    expect(outcome.warning).toContain('a.assets')
  })

  it('an ordinary notice closes on its own', () => {
    const outcome = relocateNotice({ done: 'Moved to sub' })
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

describe('link-update failure notice', () => {
  it('keeps the assets warning beside the error and stays open', () => {
    expect(linkUpdateFailedNotice('Server unreachable', 'The assets folder a.assets stayed in place')).toEqual({
      text: 'Server unreachable. The assets folder a.assets stayed in place',
      sticky: true,
    })
  })

  it('without a warning is only the error and closes on its own', () => {
    expect(linkUpdateFailedNotice('Server unreachable')).toEqual({ text: 'Server unreachable', sticky: false })
  })
})

describe('could-not-refresh notice', () => {
  it('follows an assets warning with no doubled period', () => {
    const done = relocateNotice({ assetsLeftBehind: 'a.assets', done: 'Moved to g' }).notice
    expect(refreshFailedNotice('Disk full', done)).toBe(
      "Moved to g. The assets folder a.assets stayed in place for the note with the same name; this note's links into it may break. Could not refresh: Disk full",
    )
  })
})
