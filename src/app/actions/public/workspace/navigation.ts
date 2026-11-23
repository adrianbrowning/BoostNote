import { ApiError, type NavigationApi } from './api.ts'
import type { NoteSession } from './note-session.ts'
import { type ReaderTab, Tabs, type TabsSnapshot } from './tabs.ts'
import type { AssetsLeftBehind, NoteDocument, ReaderDocument, WorkspaceData } from './types.ts'

/** Where each vault's tabs are kept between runs, by vault root: `localStorage` in the app, a map in tests. */
export interface TabStore {
  /** The vault's saved snapshot (`TabsSnapshot` as written; `null` when there is none). */
  load(root: string): unknown
  save(root: string, snapshot: TabsSnapshot): void
}

/** The tab store of the app: `localStorage` under `boostnote.tabs:<vault root>`, where existing users' tabs are. */
export const localTabStore: TabStore = {
  load(root) {
    try {
      return JSON.parse(localStorage.getItem(`boostnote.tabs:${root}`) ?? 'null')
    } catch {
      // A corrupt entry restores no tabs.
      return null
    }
  },
  save(root, snapshot) {
    localStorage.setItem(`boostnote.tabs:${root}`, JSON.stringify(snapshot))
  },
}

/** What navigation needs from the workspace around it (`WorkspaceModel`). */
export interface NavigationHost {
  /** Root of the vault on screen (`undefined`: none); it keys the vault's tabs in the tab store. */
  root(): string | undefined
  /** Whether the vault on screen has a note with this id (as of the last list refresh). */
  hasNote(id: string): boolean
  /** Shows another vault's lists (or no vault), before its tabs are restored. */
  showVault(data: WorkspaceData): void
  notify(kind: 'error' | 'info', text: string): void
  /** Shows an unexpected failure. */
  fail(error: unknown): void
  /** Something visible changed (the tabs, the reader). */
  changed(): void
}

export interface NavigationOptions {
  /** The one note session: the editor's open note, always the active tab's. */
  session: NoteSession
  /** The page's `client`, or one over the router in tests (`createClient`). */
  api: NavigationApi
  store: TabStore
  host: NavigationHost
}

/**
 * Every note transition of the workspace: opening notes, selecting, closing and reopening tabs, the
 * back/forward trail, new and deleted notes, and vault switches. Each one runs the leave-note gate
 * (`leave`) once, changes the tabs, saves them to the tab store and loads the active tab's note into
 * the session (or its reader file). Background tabs therefore never hold unsaved text.
 */
export class Navigation {
  readonly tabs = new Tabs()
  /** The file of the reader tab with `ticket` as last read (`null` unless a reader tab is active). */
  reader: { ticket: string; document: ReaderDocument } | null = null
  /** Keys of reader tabs whose close, "Open folder as vault" or "Add to vault…" is in flight (one action at a time). */
  readonly busyReaders = new Set<number>()

  readonly #session: NoteSession
  readonly #api: NavigationApi
  readonly #store: TabStore
  readonly #host: NavigationHost

  constructor({ session, api, store, host }: NavigationOptions) {
    this.#session = session
    this.#api = api
    this.#store = store
    this.#host = host
  }

  /**
   * The leave-note gate: saves the open note; `false`, with the unsaved-changes notice, when unsaved work
   * would be lost by leaving it (its save failed, or it is in conflict or removed on disk).
   */
  async leave(): Promise<boolean> {
    if (await this.#session.flush()) return true
    this.#host.notify('error', 'This note has unsaved changes that could not be saved. Resolve them first.')
    return false
  }

  /**
   * Restores the vault's tabs from the tab store (after hydration, after a vault switch). `change` then
   * edits the restored tabs before the active one loads (and they are saved).
   */
  async restore(change?: (tabs: Tabs) => unknown): Promise<void> {
    const root = this.#host.root()
    this.tabs.restore(root ? this.#store.load(root) : null, (id) => this.#host.hasNote(id))
    if (change) this.#edit(change)
    await this.#loadActive()
  }

  /** Opens a note after the gate: in the active tab, pushing onto its back trail, or with `newTab` in a new tab after it. */
  async open(id: string, options: { newTab?: boolean } = {}): Promise<void> {
    if (!options.newTab && this.#session.note?.id === id) return
    await this.#switch((tabs) => (options.newTab ? tabs.openNew(id) : tabs.navigate(id)))
  }

  async activate(key: number): Promise<void> {
    if (key !== this.tabs.activeKey) await this.#switch((tabs) => tabs.activate(key))
  }

  /** Cmd+1…8 select a tab by position, `-1` (Cmd+9) the last one (`Tabs.select`); the active tab stays as it is. */
  async select(index: number): Promise<void> {
    const tab = this.tabs.at(index)
    if (tab && tab.key !== this.tabs.activeKey) await this.#switch((tabs) => tabs.select(index))
  }

  /**
   * Closes a tab (the active one by default). Closing the active tab runs the gate first; `discard`
   * drops unsaved edits instead (the "Close" of a note removed on disk). A background tab closes
   * without the gate. A reader tab closes once main revoked its ticket (a `404` means it already
   * was); if revoking fails the tab stays open. A reader that is already closing or opening its
   * folder as the vault is left to that action.
   */
  async close(key = this.tabs.activeKey, options: { discard?: boolean } = {}): Promise<void> {
    if (key === null) return
    const tab = this.tabs.tabs.find((item) => item.key === key)
    if (tab?.kind === 'reader') {
      if (this.busyReaders.has(key)) return
      this.busyReaders.add(key)
      try {
        await this.#api.closeReader(tab.ticket)
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
          this.#host.fail(error)
          return
        }
      } finally {
        this.busyReaders.delete(key)
      }
    }
    if (key !== this.tabs.activeKey) {
      this.#edit((tabs) => tabs.close(key))
      this.#host.changed()
      return
    }
    if (options.discard) this.#session.close()
    await this.#switch((tabs) => tabs.close(key))
  }

  /** Cmd+Shift+T: reopens the most recently closed tab whose note still exists. */
  async reopen(): Promise<void> {
    if (this.tabs.closed.length > 0) await this.#switch((tabs) => tabs.reopen((id) => this.#host.hasNote(id)))
  }

  async cycle(delta: 1 | -1): Promise<void> {
    if (this.tabs.tabs.length > 1) await this.#switch((tabs) => tabs.cycle(delta))
  }

  async back(): Promise<void> {
    if (this.tabs.canGoBack()) await this.#switch((tabs) => tabs.back((id) => this.#host.hasNote(id)))
  }

  async forward(): Promise<void> {
    if (this.tabs.canGoForward()) await this.#switch((tabs) => tabs.forward((id) => this.#host.hasNote(id)))
  }

  /** Drag and drop: puts the tab at `index` of the strip (the open note stays). */
  move(key: number, index: number): void {
    this.#edit((tabs) => tabs.move(key, index))
    this.#host.changed()
  }

  /** An outside `.md` file opened from the OS: its reader tab becomes active (a new one after the active tab). */
  async openReader(ticket: string, name: string): Promise<void> {
    await this.#switch((tabs) => tabs.openReader(ticket, name))
  }

  /**
   * Reader tab `key`'s file became note `id`: the tab turns into the note's tab at its position. Still
   * active, the tab switches to the note after the gate as usual. When the user moved to another tab
   * meanwhile (or the gate refused), the tab is replaced anyway (its ticket is gone, so it never
   * stays) and the active tab stays, its note not saved for this.
   */
  async readerImported(key: number, id: string): Promise<void> {
    if (key === this.tabs.activeKey) await this.#switch((tabs) => tabs.replaceReader(key, id))
    if (!this.tabs.tabs.some((tab) => tab.key === key && tab.kind === 'reader')) return
    const active = this.tabs.activeKey
    this.#edit((tabs) => {
      tabs.replaceReader(key, id)
      if (active !== null && active !== key) tabs.activate(active)
    })
    this.#host.changed()
  }

  /**
   * "New note": after the gate, creates a note in `folder` and shows it in the active tab. `null` when the
   * gate refused (nothing is created).
   */
  async newNote(folder: string): Promise<NoteDocument | null> {
    if (!(await this.leave())) return null
    const note = await this.#api.createNote(folder)
    this.#edit((tabs) => tabs.navigate(note.id))
    this.#session.open(note)
    return note
  }

  /**
   * Moves note `id` to the trash, its latest edits included; its tabs close and the session follows the
   * active tab. With `id` open the gate runs first: `null`, and nothing is trashed, when it refused.
   */
  async deleteNote(id: string): Promise<AssetsLeftBehind | null> {
    if (this.#session.note?.id === id && !(await this.leave())) return null
    const trashed = await this.#api.deleteNote(id)
    await this.#forget((path) => path === id)
    return trashed
  }

  /**
   * Moves folder `id` and everything in it to the trash; the tabs of its notes close. With a note inside
   * it open the gate runs first: `false`, and nothing is trashed, when it refused.
   */
  async deleteFolder(id: string): Promise<boolean> {
    const inside = (path: string) => path.startsWith(`${id}/`)
    const open = this.#session.note?.id
    if (open !== undefined && inside(open) && !(await this.leave())) return false
    await this.#api.deleteFolder(id)
    await this.#forget(inside)
    return true
  }

  /**
   * Shows another vault (or none) after the gate. `load` asks main for it (`undefined`: no switch, such as a
   * cancelled folder picker); the host shows its lists, then its tabs are restored from the tab store,
   * `change` edits them (and they are saved) and the active one loads. `false` when the gate refused; a
   * failing restore rejects, so the caller's error handling sees it.
   */
  async switchVault(
    load: () => Promise<WorkspaceData | undefined>,
    change?: (tabs: Tabs) => unknown,
  ): Promise<boolean> {
    if (!(await this.leave())) return false
    const data = await load()
    if (!data) return true
    this.#session.close()
    this.#host.showVault(data)
    await this.restore(change)
    return true
  }

  /** App renames/moves of notes or folders (`map` gives each path's new path): tabs, trails and closed tabs follow. */
  rebase(map: (path: string) => string): void {
    this.#edit((tabs) => tabs.rebase(map))
  }

  /**
   * After a list refresh: background tabs (and trail entries) of notes that are gone close; the active tab
   * keeps its note until the user resolves the removal (the removed bar).
   */
  dropMissing(): void {
    const active = this.tabs.active?.kind === 'note' ? this.tabs.active.path : undefined
    this.#edit((tabs) => tabs.forget((path) => path !== active && !this.#host.hasNote(path)))
  }

  /** How many tabs an open vault keeps: its saved tabs; the vault on screen, its live tabs. */
  tabCount(root: string): number {
    if (root === this.#host.root()) return this.tabs.tabs.length
    const snapshot = this.#store.load(root)
    const tabs = typeof snapshot === 'object' && snapshot !== null && 'tabs' in snapshot ? snapshot.tabs : []
    return Array.isArray(tabs) ? tabs.length : 0
  }

  /** Runs the gate, applies `change` to the tabs and loads the (new) active tab; `false` when the gate refused. */
  async #switch(change: (tabs: Tabs) => unknown): Promise<boolean> {
    if (!(await this.leave())) return false
    this.#edit(change)
    await this.#loadActive()
    return true
  }

  /** Applies `change` to the tabs and saves them for the vault on screen: the one way the tabs change. */
  #edit(change: (tabs: Tabs) => unknown): void {
    change(this.tabs)
    const root = this.#host.root()
    if (root) this.#store.save(root, this.tabs.toJSON())
  }

  /** Makes the session show the active tab's note, or reads the active reader tab's file (nothing without tabs). */
  async #loadActive(): Promise<void> {
    const tab = this.tabs.active
    if (tab?.kind === 'reader') {
      if (this.#session.note) this.#session.close()
      await this.#loadReader(tab)
      return
    }
    this.reader = null
    const id = tab?.path
    if (id === undefined) {
      if (this.#session.note) this.#session.close()
      this.#host.changed()
      return
    }
    if (id === this.#session.note?.id) {
      this.#host.changed()
      return
    }
    try {
      this.#session.open(await this.#api.readNote(id))
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        this.#host.fail(error)
        return
      }
      this.#host.notify('error', `Note not found: ${id}`)
      this.#edit((tabs) => tabs.forget((path) => path === id))
      await this.#loadActive()
    }
  }

  /**
   * Reads the reader tab's file again. A `404` (ticket revoked, or the file is gone) closes the tab;
   * closing still revokes the ticket, so a file that went away does not keep a live grant.
   */
  async #loadReader(tab: ReaderTab): Promise<void> {
    // Another reader's content never shows under this tab while it loads (or after it failed).
    if (this.reader?.ticket !== tab.ticket) {
      this.reader = null
      this.#host.changed()
    }
    try {
      const document = await this.#api.readReader(tab.ticket)
      if (this.tabs.active !== tab) return
      this.reader = { ticket: tab.ticket, document }
      this.#host.changed()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        this.#host.fail(error)
        return
      }
      this.#host.notify('error', error.message)
      await this.close(tab.key)
    }
  }

  /** Notes were deleted by the app: their tabs close; the session follows the active tab. */
  async #forget(gone: (path: string) => boolean): Promise<void> {
    const open = this.#session.note?.id
    this.#edit((tabs) => tabs.forget(gone))
    if (open !== undefined && gone(open)) this.#session.close()
    await this.#loadActive()
  }
}
