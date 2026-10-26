import { describe, expect, it } from 'vitest'

import { MAX_CLOSED_TABS, Tabs } from '../../src/app/actions/public/workspace/tabs.ts'

const always = () => true
const paths = (tabs: Tabs) => tabs.tabs.map((tab) => tab.path)

function threeTabs(): Tabs {
  const tabs = new Tabs()
  tabs.navigate('a.md')
  tabs.openNew('b.md')
  tabs.openNew('c.md')
  return tabs
}

describe('Tabs', () => {
  it('opens the first note in a tab, then navigates the active tab or opens new tabs after it', () => {
    const tabs = new Tabs()
    tabs.navigate('a.md')
    expect(paths(tabs)).toEqual(['a.md'])
    tabs.openNew('b.md')
    expect(tabs.active?.path).toBe('b.md')
    tabs.activate(tabs.tabs[0]?.key ?? 0)
    tabs.openNew('c.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md', 'b.md'])
    tabs.navigate('d.md')
    expect(paths(tabs)).toEqual(['a.md', 'd.md', 'b.md'])
    expect(tabs.active?.back).toEqual(['c.md'])
  })

  it('keeps a back/forward trail per tab', () => {
    const tabs = new Tabs()
    tabs.navigate('a.md')
    tabs.navigate('b.md')
    tabs.navigate('c.md')
    const first = tabs.active
    tabs.openNew('x.md')
    expect(tabs.canGoBack()).toBe(false)

    tabs.activate(first?.key ?? 0)
    expect(tabs.back(always)).toBe('b.md')
    expect(tabs.back(always)).toBe('a.md')
    expect(tabs.back(always)).toBeUndefined()
    expect(tabs.forward(always)).toBe('b.md')
    expect(tabs.canGoForward()).toBe(true)
    // Navigating drops the forward trail.
    tabs.navigate('d.md')
    expect(tabs.canGoForward()).toBe(false)
    expect(tabs.active?.back).toEqual(['a.md', 'b.md'])
    // Missing notes are skipped (and dropped).
    expect(tabs.back((path) => path !== 'b.md')).toBe('a.md')
    expect(tabs.active?.forward).toEqual(['d.md'])
  })

  it('closes tabs, activating the right neighbour, and reopens them at their former positions', () => {
    const tabs = threeTabs()
    tabs.select(1)
    expect(tabs.close(tabs.active?.key ?? 0)?.path).toBe('c.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md'])
    tabs.close(tabs.tabs[0]?.key ?? 0)
    expect(paths(tabs)).toEqual(['c.md'])
    expect(tabs.active?.path).toBe('c.md')

    expect(tabs.reopen(always)?.path).toBe('a.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md'])
    expect(tabs.reopen(always)?.path).toBe('b.md')
    expect(paths(tabs)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(tabs.active?.path).toBe('b.md')
    expect(tabs.reopen(always)).toBeUndefined()

    // Closing the last tab leaves no active tab.
    for (const tab of [...tabs.tabs]) tabs.close(tab.key)
    expect(tabs.active).toBeUndefined()
    // Notes deleted since are not reopened.
    expect(tabs.reopen((path) => path !== 'c.md')?.path).toBe('b.md')
  })

  it(`remembers at most ${MAX_CLOSED_TABS} closed tabs`, () => {
    const tabs = new Tabs()
    for (let index = 0; index < MAX_CLOSED_TABS + 5; index++) tabs.close(tabs.openNew(`${index}.md`).key)
    expect(tabs.closed).toHaveLength(MAX_CLOSED_TABS)
    expect(tabs.closed[0]?.path).toBe('5.md')
  })

  it('cycles, selects by position and reorders', () => {
    const tabs = threeTabs()
    expect(tabs.cycle(1)?.path).toBe('a.md')
    expect(tabs.cycle(-1)?.path).toBe('c.md')
    expect(tabs.select(0)?.path).toBe('a.md')
    expect(tabs.select(-1)?.path).toBe('c.md')
    expect(tabs.select(7)).toBeUndefined()
    tabs.move(tabs.tabs[0]?.key ?? 0, 2)
    expect(paths(tabs)).toEqual(['b.md', 'c.md', 'a.md'])
    tabs.move(tabs.tabs[2]?.key ?? 0, 0)
    expect(paths(tabs)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(tabs.active?.path).toBe('c.md')
  })

  it('persists tab paths, the active tab and closed tabs, and restores them skipping missing notes', () => {
    const tabs = threeTabs()
    tabs.navigate('d.md')
    tabs.close(tabs.tabs[0]?.key ?? 0)
    tabs.select(1)
    const snapshot = JSON.parse(JSON.stringify(tabs))
    expect(snapshot).toEqual({ tabs: ['b.md', 'd.md'], active: 1, closed: [{ path: 'a.md', index: 0 }] })

    const restored = Tabs.restore(snapshot, always)
    expect(paths(restored)).toEqual(['b.md', 'd.md'])
    expect(restored.active?.path).toBe('d.md')
    // Trails are not persisted.
    expect(restored.canGoBack()).toBe(false)

    const missing = Tabs.restore(snapshot, (path) => path !== 'd.md' && path !== 'a.md')
    expect(paths(missing)).toEqual(['b.md'])
    expect(missing.active?.path).toBe('b.md')
    expect(missing.closed).toEqual([])

    expect(paths(Tabs.restore(null, always))).toEqual([])
    expect(paths(Tabs.restore({ tabs: [1, 'x.md'], active: 'nope', closed: [null] }, always))).toEqual(['x.md'])
  })

  it('follows renames and moves, and forgets deleted notes', () => {
    const tabs = threeTabs()
    tabs.navigate('work/d.md')
    tabs.close(tabs.tabs[0]?.key ?? 0)
    // Folder rename work → archive, note rename b → bee.
    tabs.rebase((path) => (path.startsWith('work/') ? `archive/${path.slice(5)}` : path === 'b.md' ? 'bee.md' : path))
    expect(paths(tabs)).toEqual(['bee.md', 'archive/d.md'])
    expect(tabs.active?.back).toEqual(['c.md'])
    expect(tabs.closed).toEqual([{ path: 'a.md', index: 0 }])

    tabs.forget((path) => path === 'archive/d.md' || path === 'a.md')
    expect(paths(tabs)).toEqual(['bee.md'])
    expect(tabs.active?.path).toBe('bee.md')
    expect(tabs.closed).toEqual([])
  })
})
