import { describe, expect, it } from 'vitest'

import { MAX_CLOSED_TABS, type Tab, Tabs } from '../../src/app/actions/public/workspace/tabs.ts'

const always = () => true
/** A note tab's path, or `reader:<name>` for a reader tab. */
const label = (tab: Tab | undefined) =>
  tab === undefined ? undefined : tab.kind === 'note' ? tab.path : `reader:${tab.name}`
const paths = (tabs: Tabs) => tabs.tabs.map(label)

function activeNote(tabs: Tabs) {
  const tab = tabs.active
  return tab?.kind === 'note' ? tab : undefined
}

function restoredTabs(snapshot: unknown, exists: (path: string) => boolean): Tabs {
  const tabs = new Tabs()
  tabs.restore(snapshot, exists)
  return tabs
}

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
    expect(label(tabs.active)).toBe('b.md')
    tabs.activate(tabs.tabs[0]?.key ?? 0)
    tabs.openNew('c.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md', 'b.md'])
    tabs.navigate('d.md')
    expect(paths(tabs)).toEqual(['a.md', 'd.md', 'b.md'])
    expect(activeNote(tabs)?.back).toEqual(['c.md'])
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
    expect(activeNote(tabs)?.back).toEqual(['a.md', 'b.md'])
    // Missing notes are skipped (and dropped).
    expect(tabs.back((path) => path !== 'b.md')).toBe('a.md')
    expect(activeNote(tabs)?.forward).toEqual(['d.md'])
  })

  it('closes tabs, activating the right neighbour, and reopens them at their former positions', () => {
    const tabs = threeTabs()
    tabs.select(1)
    expect(label(tabs.close(tabs.active?.key ?? 0))).toBe('c.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md'])
    tabs.close(tabs.tabs[0]?.key ?? 0)
    expect(paths(tabs)).toEqual(['c.md'])
    expect(label(tabs.active)).toBe('c.md')

    expect(tabs.reopen(always)?.path).toBe('a.md')
    expect(paths(tabs)).toEqual(['a.md', 'c.md'])
    expect(tabs.reopen(always)?.path).toBe('b.md')
    expect(paths(tabs)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(label(tabs.active)).toBe('b.md')
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
    expect(label(tabs.cycle(1))).toBe('a.md')
    expect(label(tabs.cycle(-1))).toBe('c.md')
    expect(label(tabs.select(0))).toBe('a.md')
    expect(label(tabs.select(-1))).toBe('c.md')
    expect(tabs.select(7)).toBeUndefined()
    tabs.move(tabs.tabs[0]?.key ?? 0, 2)
    expect(paths(tabs)).toEqual(['b.md', 'c.md', 'a.md'])
    tabs.move(tabs.tabs[2]?.key ?? 0, 0)
    expect(paths(tabs)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(label(tabs.active)).toBe('c.md')
  })

  it('persists tab paths, the active tab and closed tabs, and restores them skipping missing notes', () => {
    const tabs = threeTabs()
    tabs.navigate('d.md')
    tabs.close(tabs.tabs[0]?.key ?? 0)
    tabs.select(1)
    const snapshot = JSON.parse(JSON.stringify(tabs))
    expect(snapshot).toEqual({ tabs: ['b.md', 'd.md'], active: 1, closed: [{ path: 'a.md', index: 0 }] })

    const restored = restoredTabs(snapshot, always)
    expect(paths(restored)).toEqual(['b.md', 'd.md'])
    expect(label(restored.active)).toBe('d.md')
    // Trails are not persisted.
    expect(restored.canGoBack()).toBe(false)

    const missing = restoredTabs(snapshot, (path) => path !== 'd.md' && path !== 'a.md')
    expect(paths(missing)).toEqual(['b.md'])
    expect(label(missing.active)).toBe('b.md')
    expect(missing.closed).toEqual([])

    expect(paths(restoredTabs(null, always))).toEqual([])
    expect(paths(restoredTabs({ tabs: [1, 'x.md'], active: 'nope', closed: [null] }, always))).toEqual(['x.md'])
  })

  it('follows renames and moves, and forgets deleted notes', () => {
    const tabs = threeTabs()
    tabs.navigate('work/d.md')
    tabs.close(tabs.tabs[0]?.key ?? 0)
    // Folder rename work → archive, note rename b → bee.
    tabs.rebase((path) => (path.startsWith('work/') ? `archive/${path.slice(5)}` : path === 'b.md' ? 'bee.md' : path))
    expect(paths(tabs)).toEqual(['bee.md', 'archive/d.md'])
    expect(activeNote(tabs)?.back).toEqual(['c.md'])
    expect(tabs.closed).toEqual([{ path: 'a.md', index: 0 }])

    tabs.forget((path) => path === 'archive/d.md' || path === 'a.md')
    expect(paths(tabs)).toEqual(['bee.md'])
    expect(label(tabs.active)).toBe('bee.md')
    expect(tabs.closed).toEqual([])
  })

  describe('reader tabs', () => {
    it('open after the active tab, once per ticket, with no back/forward trail', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openReader('t1', 'outside.md')
      expect(paths(tabs)).toEqual(['a.md', 'reader:outside.md'])
      expect(label(tabs.active)).toBe('reader:outside.md')
      expect(tabs.canGoBack()).toBe(false)
      expect(tabs.back(always)).toBeUndefined()

      tabs.activate(tabs.tabs[0]?.key ?? 0)
      // The same ticket again activates its tab instead of opening a second one.
      tabs.openReader('t1', 'outside.md')
      expect(paths(tabs)).toEqual(['a.md', 'reader:outside.md'])
      expect(label(tabs.active)).toBe('reader:outside.md')

      // Navigating from a reader tab opens the note in a new tab after it; the reader stays.
      tabs.navigate('b.md')
      expect(paths(tabs)).toEqual(['a.md', 'reader:outside.md', 'b.md'])
      expect(tabs.canGoBack()).toBe(false)
      tabs.openReader('t2', 'other.md')
      expect(paths(tabs)).toEqual(['a.md', 'reader:outside.md', 'b.md', 'reader:other.md'])
    })

    it('are never persisted or reopened, and stay when another vault’s tabs are restored', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openReader('t1', 'outside.md')
      tabs.openNew('b.md')
      tabs.openReader('t2', 'other.md')
      expect(JSON.parse(JSON.stringify(tabs))).toEqual({ tabs: ['a.md', 'b.md'], active: -1, closed: [] })
      tabs.select(1)
      expect(tabs.toJSON().active).toBe(-1)
      tabs.select(2)
      expect(tabs.toJSON().active).toBe(1)

      // Closing a reader tab does not make it reopenable.
      tabs.openReader('t3', 'third.md')
      tabs.close(tabs.active?.key ?? 0)
      expect(tabs.closed).toEqual([])
      expect(tabs.reopen(always)).toBeUndefined()

      // Switching vaults: the other vault's tabs replace the notes; every reader tab stays, in order, after them.
      tabs.restore({ tabs: ['x.md', 'y.md'], active: 1, closed: [{ path: 'z.md', index: 0 }] }, always)
      expect(paths(tabs)).toEqual(['x.md', 'y.md', 'reader:outside.md', 'reader:other.md'])
      expect(label(tabs.active)).toBe('y.md')
      expect(tabs.closed).toEqual([{ path: 'z.md', index: 0 }])
      tabs.openReader('t1', 'outside.md')
      expect(tabs.tabs).toHaveLength(4)

      // Closing the vault: only reader tabs are left; the active reader stays active.
      tabs.restore(null, always)
      expect(paths(tabs)).toEqual(['reader:outside.md', 'reader:other.md'])
      expect(label(tabs.active)).toBe('reader:outside.md')
      tabs.restore({ tabs: [], active: -1, closed: [] }, always)
      expect(label(tabs.active)).toBe('reader:outside.md')
    })

    it('are untouched by rebase and forget', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openReader('t1', 'a.md')
      tabs.rebase((path) => `moved/${path}`)
      expect(paths(tabs)).toEqual(['moved/a.md', 'reader:a.md'])
      tabs.forget(() => true)
      expect(paths(tabs)).toEqual(['reader:a.md'])
      expect(label(tabs.active)).toBe('reader:a.md')
    })
  })
})
