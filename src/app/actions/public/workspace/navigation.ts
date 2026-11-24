import { isUnder } from '../../../../shared/vault-ids.ts'
import { ApiError, type NavigationApi } from './api.ts'
import type { NoteSession } from './note-session.ts'
import { type ReaderTab, Tabs, type TabsSnapshot } from './tabs.ts'
import type { AssetsLeftBehind, NoteDocument, ReaderDocument, WorkspaceData } from './types.ts'

/** Where each vault's tabs are kept between runs, by vault root: `localStorage` in the app, a map in tests. */
export interface TabStore {
  /**
   * The vault's saved snapshot (`TabsSnapshot` as written; `null` when there is none, or it cannot be read:
   * the vault then restores no tabs). Never throws: the sidebar reads other vaults' tab counts while it renders.
   */
  load(root: string): unknown
  /** Throws when the snapshot cannot be written (`localStorage` over its quota); the transition then rejects. */
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
 * back/forward trail, new and deleted notes, and vault switches. Each one that leaves the open note
 * (switching or closing the active tab, a new note, deleting the open note or a folder holding it, a vault
 * switch) runs the leave-note gate (`leave`) once; closing a background tab and deleting a note that is not
 * open skip it. Each holds the open note (`hold`) until it is done: it changes the tabs, loads the active
 * tab's note into the session (or its reader file), then saves the tabs to the tab store. Background tabs
 * therefore never hold unsaved text, and nothing typed during a transition is dropped by it.
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
  /** How many `hold`s are running; the session is locked while any is. */
  #holds = 0
  /** Counts changes of the active tab (or its note): `token` compares against it. */
  #transitions = 0
  /** Counts vault switches: `vaultToken` compares against it. */
  #vaults = 0
  /** The tabs changed since they were last saved to the tab store. */
  #unsaved = false

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
   * The one way to run work that awaits and then replaces, closes or relocates the open note: the gate first
   * (skipped with `gate: false`, when the work leaves the open note as it is at the start, such as deleting
   * another note), then `run`, the open note locked (`NoteSession.locked`: it takes no edits and the editor
   * is read-only) until `run` and every other hold running alongside it have settled. Nothing typed while
   * its requests are out can then be dropped by the note being replaced or closed, or be saved to a place
   * the vault just moved. Tab changes made while it runs are saved to the tab store once it is done, so a
   * store that throws rejects the hold with the tabs, the session and the lock agreeing. When `run` rejects
   * they are saved too and its error rethrown (a store error is then dropped: the tabs stay unsaved, so the
   * next save retries them). `null`, and `run` does not run, when the gate refused.
   */
  async hold<T>(run: () => Promise<T>, { gate = true }: { gate?: boolean } = {}): Promise<T | null> {
    if (gate && !(await this.leave())) return null
    this.#holds++
    this.#session.lock(true)
    try {
      let result: T
      try {
        result = await run()
      } catch (error) {
        try {
          this.#persist()
        } catch {
          // `run`'s error is the one to report; the tabs stay unsaved, so the next save retries them.
        }
        throw error
      }
      this.#persist()
      return result
    } finally {
      this.#holds--
      this.#session.lock(this.#holds > 0)
    }
  }

  /**
   * A handle on the transition running now: it answers `true` while no later transition has changed the
   * active tab or its note. A request's late result is dropped once it answers `false`.
   */
  token(): () => boolean {
    const at = this.#transitions
    return () => this.#transitions === at
  }

  /**
   * A handle on the vault on screen: it answers `true` while no vault switch has run since. The tab and session
   * follow-up of a request that returns after a switch is skipped: the tabs belong to another vault.
   */
  vaultToken(): () => boolean {
    const at = this.#vaults
    return () => this.#vaults === at
  }

  /**
   * Restores the vault's tabs from the tab store (after hydration, after a vault switch). `change` then
   * edits the restored tabs before the active one loads (and they are saved).
   */
  async restore(change?: (tabs: Tabs) => unknown): Promise<void> {
    await this.hold(
      async () => {
        const root = this.#host.root()
        this.#transitions++
        this.tabs.restore(root ? this.#store.load(root) : null, (id) => this.#host.hasNote(id))
        if (change) this.#edit(change)
        await this.#loadActive()
      },
      { gate: false },
    )
  }

  /** Opens a note after the gate: in the active tab, pushing onto its back trail, or with `newTab` in a new tab after it. */
  async open(id: string, options: { newTab?: boolean } = {}): Promise<void> {
    if (!options.newTab && this.#session.note?.id === id) return
    await this.#switch((tabs) => (options.newTab ? tabs.openNew(id) : tabs.navigate(id)))
  }

  async activate(key: number): Promise<void> {
    if (key !== this.tabs.activeKey) await this.#switch((tabs) => tabs.activate(key))
  }

  /** Cmd+1…8 select a tab by position, `-1` (Cmd+9) the last one (`Tabs.select`); selecting the tab that is already active does nothing (no gate). */
  async select(index: number): Promise<void> {
    const tab = this.tabs.at(index)
    if (!tab || tab.key === this.tabs.activeKey) return
    // The strip can change while the gate saves: the tab asked for is selected where it is then (gone: none).
    await this.#switch((tabs) => {
      const at = tabs.tabs.indexOf(tab)
      if (at !== -1) tabs.select(at)
    })
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
   * gate refused (nothing is created); `shown: false` when the note was created but is not shown: a later
   * transition changed the active tab meanwhile.
   */
  async newNote(folder: string): Promise<{ note: NoteDocument; shown: boolean } | null> {
    return this.hold(async () => {
      const current = this.token()
      const note = await this.#api.createNote(folder)
      if (!current()) return { note, shown: false }
      this.#edit((tabs) => tabs.navigate(note.id))
      this.#session.open(note)
      return { note, shown: true }
    })
  }

  /**
   * Moves note `id` to the trash, its latest edits included; its tabs close and the session follows the
   * active tab. When that can replace the open note (`#replaces`) the gate runs first: `null`, and nothing
   * is trashed, when it refused.
   */
  async deleteNote(id: string): Promise<AssetsLeftBehind | null> {
    const gone = (path: string) => path === id
    return this.hold(
      async () => {
        const sameVault = this.vaultToken()
        const trashed = await this.#api.deleteNote(id)
        if (sameVault()) await this.#forget(gone)
        return trashed
      },
      { gate: this.#replaces(gone) },
    )
  }

  /**
   * Moves folder `id` and everything in it to the trash; the tabs of its notes close. When that can replace
   * the open note (`#replaces`: a note inside it is open) the gate runs first: `false`, and nothing is
   * trashed, when it refused.
   */
  async deleteFolder(id: string): Promise<boolean> {
    const inside = (path: string) => isUnder(path, id)
    const deleted = await this.hold(
      async () => {
        const sameVault = this.vaultToken()
        await this.#api.deleteFolder(id)
        if (sameVault()) await this.#forget(inside)
        return true
      },
      { gate: this.#replaces(inside) },
    )
    return deleted ?? false
  }

  /**
   * Shows another vault (or none) after the gate. `load` asks main for it (`undefined`: no switch, such as a
   * cancelled folder picker); the host shows its lists, then its tabs are restored from the tab store,
   * `change` edits them (and they are saved) and the active one loads. `false` when the gate refused. A failing
   * restore rejects, so the caller's error handling sees it. A failing save of the tabs changed in the vault left
   * while `load` ran does not: the other vault shows by then, so the switch happened (callers that go on after it,
   * such as the open-request drain, still run) and the store error is reported through the host (`fail`). Main
   * may already be on the other vault while `load` runs, so edits made then could not be saved: the switch holds
   * the open note (`hold`).
   */
  async switchVault(
    load: () => Promise<WorkspaceData | undefined>,
    change?: (tabs: Tabs) => unknown,
  ): Promise<boolean> {
    const switched = await this.hold(async () => {
      const data = await load()
      if (!data) return true
      this.#vaults++
      this.#session.close()
      // Tab changes made in this vault while `load` ran (a background tab closed or dragged) are saved
      // under its root before the other vault's tabs replace them.
      let unsaved: { error: unknown } | undefined
      try {
        this.#persist()
      } catch (error) {
        // Main is on the other vault already: it shows first, then this error is reported.
        unsaved = { error }
      }
      this.#host.showVault(data)
      await this.restore(change)
      if (unsaved) this.#host.fail(unsaved.error)
      return true
    })
    return switched ?? false
  }

  /**
   * App renames/moves of notes or folders (`map` gives each path's new path): tabs, trails and closed tabs follow.
   * Run inside the relocation's `hold`, after the open note took its new place (`NoteSession.relocated`, or
   * `retarget` while it is read there again). When the active tab's note moved and the session does not hold it (its
   * read was out as the relocation landed, and is dropped as a stale transition), it loads at its new place.
   */
  async rebase(map: (path: string) => string): Promise<void> {
    const before = this.tabs.active
    const from = before?.kind === 'note' ? before.path : undefined
    this.#edit((tabs) => tabs.rebase(map))
    const active = this.tabs.active
    if (active?.kind !== 'note' || active.path === from || active.path === this.#session.note?.id) return
    await this.#loadActive()
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

  /** Runs the gate, applies `change` to the tabs and loads the (new) active tab, holding the open note (`hold`). */
  async #switch(change: (tabs: Tabs) => unknown): Promise<void> {
    await this.hold(async () => {
      this.#edit(change)
      await this.#loadActive()
    })
  }

  /**
   * Applies `change` to the tabs; a change of the active tab (or its note) is a transition (`token`). Every tab
   * change goes through here except `restore`, which loads the tabs from the store. Inside a `hold` the tabs
   * are saved once it is done; otherwise right away.
   */
  #edit(change: (tabs: Tabs) => unknown): void {
    const before = this.#activeShows()
    change(this.tabs)
    if (this.#activeShows() !== before) this.#transitions++
    this.#unsaved = true
    if (this.#holds === 0) this.#persist()
  }

  /** What the active tab shows: its key with its note's path or its reader ticket (`''`: no tab). */
  #activeShows(): string {
    const tab = this.tabs.active
    if (!tab) return ''
    return `${tab.key}:${tab.kind === 'note' ? `note:${tab.path}` : `reader:${tab.ticket}`}`
  }

  /** Saves the tabs for the vault on screen when they changed since the last save (it throws when the store does). */
  #persist(): void {
    const root = this.#host.root()
    if (!this.#unsaved || !root) return
    this.#store.save(root, this.tabs.toJSON())
    this.#unsaved = false
  }

  /**
   * Makes the session show the active tab's note, or reads the active reader tab's file (nothing without tabs).
   * Runs inside a `hold`: the open note it replaces or closes takes no edits meanwhile.
   */
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
    // A later transition can change the active tab (or its note) while the read is out: its late result
    // (or error) is dropped.
    const current = this.token()
    let note: NoteDocument
    try {
      note = await this.#api.readNote(id)
    } catch (error) {
      if (!current()) return
      if (!(error instanceof ApiError && error.status === 404)) {
        this.#host.fail(error)
        return
      }
      this.#host.notify('error', `Note not found: ${id}`)
      this.#edit((tabs) => tabs.forget((path) => path === id))
      await this.#loadActive()
      return
    }
    if (current()) this.#session.open(note)
  }

  /**
   * Whether closing the tabs of the notes `gone` matches can replace or close the open note: it is one of
   * them, or the active tab does not show it (its load is out, or failed), so the active tab's note loads.
   */
  #replaces(gone: (path: string) => boolean): boolean {
    const open = this.#session.note?.id
    if (open === undefined) return false
    const active = this.tabs.active
    return gone(open) || active?.kind !== 'note' || active.path !== open
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
    const current = this.token()
    try {
      const document = await this.#api.readReader(tab.ticket)
      if (!current()) return
      this.reader = { ticket: tab.ticket, document }
      this.#host.changed()
    } catch (error) {
      // A later transition left this tab: its failure is dropped too (the tab reads again when it is active).
      if (!current()) return
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
