import { describe, expect, it } from 'vitest'

import { MAX_CLOSED_TABS, scratchTabsOf, type Tab, Tabs } from '../../src/app/actions/public/workspace/tabs.ts'

const always = () => true
/** A note tab's path, `reader:<name>` for a reader tab, or `scratch:<id>` for a scratch tab. */
const label = (tab: Tab | undefined) => {
  if (tab === undefined) return undefined
  if (tab.kind === 'note') return tab.path
  return tab.kind === 'reader' ? `reader:${tab.name}` : `scratch:${tab.id}`
}
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

  describe('scratch tabs', () => {
    it('open after the active tab and activate, once per id', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openNew('b.md')
      tabs.activate(tabs.tabs[0]?.key ?? 0)
      const tab = tabs.openScratch('s1')
      expect(tab).toEqual({ key: tab.key, kind: 'scratch', id: 's1' })
      expect(paths(tabs)).toEqual(['a.md', 'scratch:s1', 'b.md'])
      expect(label(tabs.active)).toBe('scratch:s1')

      tabs.activate(tabs.tabs[2]?.key ?? 0)
      // The same id again activates its tab instead of opening a second one.
      expect(tabs.openScratch('s1')).toBe(tab)
      expect(paths(tabs)).toEqual(['a.md', 'scratch:s1', 'b.md'])
      expect(label(tabs.active)).toBe('scratch:s1')
    })

    it('are never persisted, and stay (the active one active) when another vault’s tabs are restored', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openScratch('s1')
      tabs.openReader('t1', 'outside.md')
      tabs.openNew('b.md')
      tabs.openScratch('s2')
      expect(JSON.parse(JSON.stringify(tabs))).toEqual({ tabs: ['a.md', 'b.md'], active: -1, closed: [] })

      // Switching vaults: the other vault's tabs replace the notes; reader and scratch tabs stay, in order, after
      // them, and the active scratch tab stays active.
      tabs.restore({ tabs: ['x.md', 'y.md'], active: 1, closed: [] }, always)
      expect(paths(tabs)).toEqual(['x.md', 'y.md', 'scratch:s1', 'reader:outside.md', 'scratch:s2'])
      expect(label(tabs.active)).toBe('scratch:s2')

      // From a note tab, the snapshot's active note becomes active.
      tabs.select(0)
      tabs.restore({ tabs: ['x.md', 'y.md'], active: 1, closed: [] }, always)
      expect(label(tabs.active)).toBe('y.md')

      tabs.select(2)
      tabs.restore({ tabs: ['x.md'], active: 0, closed: [] }, always)
      expect(paths(tabs)).toEqual(['x.md', 'scratch:s1', 'reader:outside.md', 'scratch:s2'])
      expect(label(tabs.active)).toBe('scratch:s1')

      // Closing the vault: only reader and scratch tabs are left; the active scratch tab stays active.
      tabs.restore(null, always)
      expect(paths(tabs)).toEqual(['scratch:s1', 'reader:outside.md', 'scratch:s2'])
      expect(label(tabs.active)).toBe('scratch:s1')
    })

    it('have no trail, are untouched by rebase and forget, and navigating from one opens a new note tab', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.navigate('b.md')
      tabs.openScratch('s1')
      expect(tabs.canGoBack()).toBe(false)
      expect(tabs.canGoForward()).toBe(false)
      expect(tabs.back(always)).toBeUndefined()
      expect(tabs.forward(always)).toBeUndefined()

      tabs.rebase((path) => `moved/${path}`)
      expect(paths(tabs)).toEqual(['moved/b.md', 'scratch:s1'])
      tabs.forget(() => true)
      expect(paths(tabs)).toEqual(['scratch:s1'])
      expect(label(tabs.active)).toBe('scratch:s1')

      tabs.navigate('c.md')
      expect(paths(tabs)).toEqual(['scratch:s1', 'c.md'])
      expect(label(tabs.active)).toBe('c.md')
    })

    it('close to the right neighbour and are not reopened', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      tabs.openNew('b.md')
      tabs.select(0)
      tabs.openScratch('s1')
      expect(paths(tabs)).toEqual(['a.md', 'scratch:s1', 'b.md'])
      expect(label(tabs.close(tabs.active?.key ?? 0))).toBe('b.md')
      expect(paths(tabs)).toEqual(['a.md', 'b.md'])
      expect(tabs.closed).toEqual([])
      expect(tabs.reopen(always)).toBeUndefined()
      expect(paths(tabs)).toEqual(['a.md', 'b.md'])
    })

    it('turn into a note tab in place, or make way for the note’s open tab', () => {
      const tabs = new Tabs()
      tabs.navigate('a.md')
      const scratch = tabs.openScratch('s1')
      tabs.openNew('b.md')
      const note = tabs.replaceScratch(scratch.key, 'new.md')
      expect(note).toEqual({ key: scratch.key, kind: 'note', path: 'new.md', back: [], forward: [] })
      expect(paths(tabs)).toEqual(['a.md', 'new.md', 'b.md'])
      expect(label(tabs.active)).toBe('new.md')

      // A tab already showing the note moves into the scratch tab's slot, with its trail.
      tabs.select(2)
      tabs.navigate('c.md')
      tabs.select(0)
      const other = tabs.openScratch('s2')
      expect(paths(tabs)).toEqual(['a.md', 'scratch:s2', 'new.md', 'c.md'])
      const moved = tabs.replaceScratch(other.key, 'c.md')
      expect(paths(tabs)).toEqual(['a.md', 'c.md', 'new.md'])
      expect(moved?.back).toEqual(['b.md'])
      expect(label(tabs.active)).toBe('c.md')

      // No scratch tab under that key.
      expect(tabs.replaceScratch(tabs.tabs[0]?.key ?? 0, 'x.md')).toBeUndefined()
      expect(paths(tabs)).toEqual(['a.md', 'c.md', 'new.md'])
    })
  })
})

describe('scratchTabsOf', () => {
  it.each([
    [null, { ids: [], active: -1 }],
    ['x', { ids: [], active: -1 }],
    [
      { ids: 'a', active: 0 },
      { ids: [], active: -1 },
    ],
    [
      { ids: [1, 'a', 'b'], active: 2 },
      { ids: ['a', 'b'], active: 1 },
    ],
    [
      { ids: ['a'], active: 5 },
      { ids: ['a'], active: -1 },
    ],
    [
      { ids: [1, 'a'], active: 0 },
      { ids: ['a'], active: -1 },
    ],
    [
      { ids: ['a', 'b'], active: '1' },
      { ids: ['a', 'b'], active: -1 },
    ],
  ])('reads the stored entry %j as %j', (stored, snapshot) => {
    expect(scratchTabsOf(stored)).toEqual(snapshot)
  })
})
