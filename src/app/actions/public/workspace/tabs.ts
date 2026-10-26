/**
 * The workspace's tabs (Hubble semantics): a tab records which note it shows plus its own back/forward
 * trail. There is one editor; activating a tab loads its note, so background tabs hold no unsaved
 * text. Pure state, no I/O: `WorkspaceModel` saves/loads notes around these transitions and persists
 * `toJSON()` per vault. Paths are vault note ids (`work/todo.md`).
 */

export interface Tab {
  /** Stable identity for rendering and drag and drop (not persisted). */
  readonly key: number
  path: string
  /** Notes this tab showed before, oldest first. */
  back: string[]
  /** Notes `back()` stepped away from, nearest last. */
  forward: string[]
}

/** A closed tab Cmd+Shift+T can bring back to where it was. */
export interface ClosedTab {
  path: string
  index: number
}

/** What is persisted per vault: the tabs' notes in order, the active one, the closed-tab stack. Trails stay in memory. */
export interface TabsSnapshot {
  tabs: string[]
  /** Index into `tabs`; `-1` without tabs. */
  active: number
  /** Most recently closed last. */
  closed: ClosedTab[]
}

export const MAX_CLOSED_TABS = 40

/** Drops consecutive duplicates and entries equal to `current` at the trail's end (left behind by renames/deletions). */
function compact(trail: string[], current: string): string[] {
  const result: string[] = []
  for (const path of trail) if (result[result.length - 1] !== path) result.push(path)
  while (result[result.length - 1] === current) result.pop()
  return result
}

export class Tabs {
  tabs: Tab[] = []
  activeKey: number | null = null
  closed: ClosedTab[] = []
  #nextKey = 1

  /** Tabs from a persisted snapshot; notes that no longer exist are skipped. */
  static restore(snapshot: unknown, exists: (path: string) => boolean): Tabs {
    const tabs = new Tabs()
    if (typeof snapshot !== 'object' || snapshot === null) return tabs
    const { tabs: paths, active, closed } = snapshot as Partial<Record<keyof TabsSnapshot, unknown>>
    if (Array.isArray(paths)) {
      const activeIndex = typeof active === 'number' ? active : 0
      let activeTab: Tab | undefined
      paths.forEach((path: unknown, index) => {
        if (typeof path !== 'string' || !exists(path)) return
        const tab = tabs.#create(path)
        tabs.tabs.push(tab)
        // The active tab, or the nearest surviving tab before it.
        if (index <= activeIndex || activeTab === undefined) activeTab = tab
      })
      tabs.activeKey = activeTab?.key ?? null
    }
    if (Array.isArray(closed)) {
      for (const entry of closed.slice(-MAX_CLOSED_TABS)) {
        const { path, index } = (entry ?? {}) as Partial<Record<keyof ClosedTab, unknown>>
        if (typeof path === 'string' && typeof index === 'number' && exists(path)) tabs.closed.push({ path, index })
      }
    }
    return tabs
  }

  toJSON(): TabsSnapshot {
    return { tabs: this.tabs.map((tab) => tab.path), active: this.activeIndex, closed: [...this.closed] }
  }

  get active(): Tab | undefined {
    return this.tabs.find((tab) => tab.key === this.activeKey)
  }

  get activeIndex(): number {
    return this.tabs.findIndex((tab) => tab.key === this.activeKey)
  }

  /** Shows `path` in the active tab, pushing the note it showed onto its back trail (a new tab when there is none). */
  navigate(path: string): Tab {
    const tab = this.active
    if (!tab) return this.openNew(path)
    if (tab.path !== path) {
      tab.back.push(tab.path)
      tab.forward = []
      tab.path = path
    }
    return tab
  }

  /** Opens `path` in a new tab right after the active one and activates it. */
  openNew(path: string): Tab {
    const tab = this.#create(path)
    const index = this.activeIndex
    this.tabs.splice(index === -1 ? this.tabs.length : index + 1, 0, tab)
    this.activeKey = tab.key
    return tab
  }

  activate(key: number): Tab | undefined {
    const tab = this.tabs.find((item) => item.key === key)
    if (tab) this.activeKey = tab.key
    return tab
  }

  /** Closes a tab (remembered for `reopen`); a closed active tab hands over to its right, else left, neighbour. */
  close(key: number): Tab | undefined {
    const index = this.tabs.findIndex((tab) => tab.key === key)
    const tab = this.tabs[index]
    if (!tab) return this.active
    this.tabs.splice(index, 1)
    this.closed.push({ path: tab.path, index })
    if (this.closed.length > MAX_CLOSED_TABS) this.closed.splice(0, this.closed.length - MAX_CLOSED_TABS)
    if (this.activeKey === key) this.activeKey = this.tabs[Math.min(index, this.tabs.length - 1)]?.key ?? null
    return this.active
  }

  /** Reopens the most recently closed tab whose note still exists, at its former position. */
  reopen(exists: (path: string) => boolean): Tab | undefined {
    for (let entry = this.closed.pop(); entry; entry = this.closed.pop()) {
      if (!exists(entry.path)) continue
      const tab = this.#create(entry.path)
      this.tabs.splice(Math.min(entry.index, this.tabs.length), 0, tab)
      this.activeKey = tab.key
      return tab
    }
    return undefined
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab, wrapping around. */
  cycle(delta: 1 | -1): Tab | undefined {
    const count = this.tabs.length
    if (count === 0) return undefined
    const tab = this.tabs[(Math.max(this.activeIndex, 0) + delta + count) % count]
    if (tab) this.activeKey = tab.key
    return tab
  }

  /** Cmd+1…8 select a tab by position; `-1` (Cmd+9) the last one. */
  select(index: number): Tab | undefined {
    const tab = this.tabs[index === -1 ? this.tabs.length - 1 : index]
    if (tab) this.activeKey = tab.key
    return tab
  }

  /** Drag and drop: puts the tab at `index` of the strip. */
  move(key: number, index: number): void {
    const from = this.tabs.findIndex((tab) => tab.key === key)
    const [tab] = from === -1 ? [] : this.tabs.splice(from, 1)
    if (tab) this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab)
  }

  canGoBack(): boolean {
    return (this.active?.back.length ?? 0) > 0
  }

  canGoForward(): boolean {
    return (this.active?.forward.length ?? 0) > 0
  }

  /** Steps the active tab back along its trail, dropping entries whose note is gone; the new path, if it moved. */
  back(exists: (path: string) => boolean): string | undefined {
    return this.#step('back', 'forward', exists)
  }

  forward(exists: (path: string) => boolean): string | undefined {
    return this.#step('forward', 'back', exists)
  }

  /** Notes were renamed or moved (`map` gives each path's new path): tabs, trails and closed tabs follow. */
  rebase(map: (path: string) => string): void {
    for (const tab of this.tabs) {
      tab.path = map(tab.path)
      tab.back = compact(tab.back.map(map), tab.path)
      tab.forward = compact(tab.forward.map(map), tab.path)
    }
    for (const entry of this.closed) entry.path = map(entry.path)
  }

  /** Notes were deleted: tabs showing them close (not reopenable), trails and closed tabs forget them. */
  forget(gone: (path: string) => boolean): void {
    const activeGone = this.active ? gone(this.active.path) : false
    // Where the active tab's slot ends up once the gone tabs before it are removed.
    const slot = this.tabs.slice(0, Math.max(this.activeIndex, 0)).filter((tab) => !gone(tab.path)).length
    this.tabs = this.tabs.filter((tab) => !gone(tab.path))
    for (const tab of this.tabs) {
      tab.back = compact(
        tab.back.filter((path) => !gone(path)),
        tab.path,
      )
      tab.forward = compact(
        tab.forward.filter((path) => !gone(path)),
        tab.path,
      )
    }
    this.closed = this.closed.filter((entry) => !gone(entry.path))
    if (activeGone) this.activeKey = this.tabs[Math.min(slot, this.tabs.length - 1)]?.key ?? null
  }

  #step(from: 'back' | 'forward', to: 'back' | 'forward', exists: (path: string) => boolean): string | undefined {
    const tab = this.active
    if (!tab) return undefined
    for (let path = tab[from].pop(); path !== undefined; path = tab[from].pop()) {
      if (!exists(path) || path === tab.path) continue
      tab[to].push(tab.path)
      tab.path = path
      return path
    }
    return undefined
  }

  #create(path: string): Tab {
    const key = this.#nextKey
    this.#nextKey += 1
    return { key, path, back: [], forward: [] }
  }
}
