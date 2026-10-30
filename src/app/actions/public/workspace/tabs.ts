/**
 * The workspace's tabs (Hubble semantics). A note tab records which note it shows plus its own
 * back/forward trail. A reader tab shows an outside `.md` read-only through a `ReaderGrants` ticket:
 * it has no trail, is never persisted, and is left alone by rebase/forget and by restoring another
 * vault's tabs, so it stays open across vault switches. There is one editor; activating a tab loads
 * its note, so background tabs hold no unsaved text. Pure state, no I/O: `WorkspaceModel`
 * saves/loads notes around these transitions and persists `toJSON()` per vault. Note paths are vault
 * note ids (`work/todo.md`).
 */

export interface NoteTab {
  /** Stable identity for rendering and drag and drop (not persisted). */
  readonly key: number
  readonly kind: 'note'
  path: string
  /** Notes this tab showed before, oldest first. */
  back: string[]
  /** Notes `back()` stepped away from, nearest last. */
  forward: string[]
}

export interface ReaderTab {
  readonly key: number
  readonly kind: 'reader'
  /** `ReaderGrants` ticket of the file (`GET /api/reader/:ticket`). */
  readonly ticket: string
  /** The file's base name. */
  readonly name: string
}

export type Tab = NoteTab | ReaderTab

/** A closed tab Cmd+Shift+T can bring back to where it was. */
export interface ClosedTab {
  path: string
  index: number
}

/** What is persisted per vault: the note tabs in order, the active one, the closed-tab stack. Trails stay in memory. */
export interface TabsSnapshot {
  tabs: string[]
  /** Index into `tabs`; `-1` without tabs or when a reader tab is active. */
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

  /**
   * Replaces the note tabs and closed tabs with a persisted snapshot (another vault's, or none when
   * no vault is open); notes that no longer exist are skipped. Reader tabs stay, after the notes.
   * The snapshot's active note becomes active; without note tabs an active reader tab stays active.
   */
  restore(snapshot: unknown, exists: (path: string) => boolean): void {
    const readers = this.tabs.filter((tab) => tab.kind === 'reader')
    const activeReader = this.active?.kind === 'reader' ? this.activeKey : null
    const notes: NoteTab[] = []
    let activeNote: NoteTab | undefined
    this.closed = []
    if (typeof snapshot === 'object' && snapshot !== null) {
      const { tabs: paths, active, closed } = snapshot as Partial<Record<keyof TabsSnapshot, unknown>>
      if (Array.isArray(paths)) {
        const activeIndex = typeof active === 'number' ? active : 0
        paths.forEach((path: unknown, index) => {
          if (typeof path !== 'string' || !exists(path)) return
          const tab = this.#createNote(path)
          notes.push(tab)
          // The active tab, or the nearest surviving tab before it.
          if (index <= activeIndex || activeNote === undefined) activeNote = tab
        })
      }
      if (Array.isArray(closed)) {
        for (const entry of closed.slice(-MAX_CLOSED_TABS)) {
          const { path, index } = (entry ?? {}) as Partial<Record<keyof ClosedTab, unknown>>
          if (typeof path === 'string' && typeof index === 'number' && exists(path)) this.closed.push({ path, index })
        }
      }
    }
    this.tabs = [...notes, ...readers]
    this.activeKey = activeNote?.key ?? activeReader ?? readers[0]?.key ?? null
  }

  toJSON(): TabsSnapshot {
    const notes = this.tabs.filter((tab) => tab.kind === 'note')
    return {
      tabs: notes.map((tab) => tab.path),
      active: notes.findIndex((tab) => tab.key === this.activeKey),
      closed: [...this.closed],
    }
  }

  get active(): Tab | undefined {
    return this.tabs.find((tab) => tab.key === this.activeKey)
  }

  get activeIndex(): number {
    return this.tabs.findIndex((tab) => tab.key === this.activeKey)
  }

  /**
   * Shows `path` in the active note tab, pushing the note it showed onto its back trail. Without
   * one, or from a reader tab, the note opens in a new tab.
   */
  navigate(path: string): NoteTab {
    const tab = this.active
    if (tab?.kind !== 'note') return this.openNew(path)
    if (tab.path !== path) {
      tab.back.push(tab.path)
      tab.forward = []
      tab.path = path
    }
    return tab
  }

  /** Opens `path` in a new tab right after the active one and activates it. */
  openNew(path: string): NoteTab {
    const tab = this.#createNote(path)
    this.#insert(tab)
    return tab
  }

  /** Activates the reader tab of `ticket`, opening it right after the active tab when there is none. */
  openReader(ticket: string, name: string): ReaderTab {
    const open = this.tabs.find((tab): tab is ReaderTab => tab.kind === 'reader' && tab.ticket === ticket)
    if (open) {
      this.activeKey = open.key
      return open
    }
    const tab: ReaderTab = { key: this.#takeKey(), kind: 'reader', ticket, name }
    this.#insert(tab)
    return tab
  }

  activate(key: number): Tab | undefined {
    const tab = this.tabs.find((item) => item.key === key)
    if (tab) this.activeKey = tab.key
    return tab
  }

  /**
   * Closes a tab; a closed active tab hands over to its right, else left, neighbour. Note tabs are
   * remembered for `reopen`; a reader tab is not (its ticket is revoked when it closes).
   */
  close(key: number): Tab | undefined {
    const index = this.tabs.findIndex((tab) => tab.key === key)
    const tab = this.tabs[index]
    if (!tab) return this.active
    this.tabs.splice(index, 1)
    if (tab.kind === 'note') {
      this.closed.push({ path: tab.path, index })
      if (this.closed.length > MAX_CLOSED_TABS) this.closed.splice(0, this.closed.length - MAX_CLOSED_TABS)
    }
    if (this.activeKey === key) this.activeKey = this.tabs[Math.min(index, this.tabs.length - 1)]?.key ?? null
    return this.active
  }

  /** Reopens the most recently closed tab whose note still exists, at its former position. */
  reopen(exists: (path: string) => boolean): NoteTab | undefined {
    for (let entry = this.closed.pop(); entry; entry = this.closed.pop()) {
      if (!exists(entry.path)) continue
      const tab = this.#createNote(entry.path)
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
    const tab = this.active
    return tab?.kind === 'note' && tab.back.length > 0
  }

  canGoForward(): boolean {
    const tab = this.active
    return tab?.kind === 'note' && tab.forward.length > 0
  }

  /** Steps the active tab back along its trail, dropping entries whose note is gone; the new path, if it moved. */
  back(exists: (path: string) => boolean): string | undefined {
    return this.#step('back', 'forward', exists)
  }

  forward(exists: (path: string) => boolean): string | undefined {
    return this.#step('forward', 'back', exists)
  }

  /** Notes were renamed or moved (`map` gives each path's new path): note tabs, trails and closed tabs follow. */
  rebase(map: (path: string) => string): void {
    for (const tab of this.tabs) {
      if (tab.kind !== 'note') continue
      tab.path = map(tab.path)
      tab.back = compact(tab.back.map(map), tab.path)
      tab.forward = compact(tab.forward.map(map), tab.path)
    }
    for (const entry of this.closed) entry.path = map(entry.path)
  }

  /** Notes were deleted: note tabs showing them close (not reopenable), trails and closed tabs forget them. */
  forget(gone: (path: string) => boolean): void {
    const isGone = (tab: Tab) => tab.kind === 'note' && gone(tab.path)
    const activeGone = this.active ? isGone(this.active) : false
    // Where the active tab's slot ends up once the gone tabs before it are removed.
    const slot = this.tabs.slice(0, Math.max(this.activeIndex, 0)).filter((tab) => !isGone(tab)).length
    this.tabs = this.tabs.filter((tab) => !isGone(tab))
    for (const tab of this.tabs) {
      if (tab.kind !== 'note') continue
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
    if (tab?.kind !== 'note') return undefined
    for (let path = tab[from].pop(); path !== undefined; path = tab[from].pop()) {
      if (!exists(path) || path === tab.path) continue
      tab[to].push(tab.path)
      tab.path = path
      return path
    }
    return undefined
  }

  /** Puts `tab` right after the active tab (at the end without one) and activates it. */
  #insert(tab: Tab): void {
    const index = this.activeIndex
    this.tabs.splice(index === -1 ? this.tabs.length : index + 1, 0, tab)
    this.activeKey = tab.key
  }

  #createNote(path: string): NoteTab {
    return { key: this.#takeKey(), kind: 'note', path, back: [], forward: [] }
  }

  #takeKey(): number {
    const key = this.#nextKey
    this.#nextKey += 1
    return key
  }
}
