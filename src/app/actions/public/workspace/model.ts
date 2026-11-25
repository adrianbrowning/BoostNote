import { TypedEventTarget } from 'remix/component'

import { scratchTitle } from '../../../../shared/scratch.ts'
import { isAtOrUnder, lastSegment, noteStem, parentOf, toMeta } from '../../../../shared/vault-ids.ts'
import { ApiError, type Client, setPageVault } from './api.ts'
import type { DropTicket } from './drop-import.ts'
import { Navigation, type TabStore } from './navigation.ts'
import { NoteSaving } from './note-saving.ts'
import { NoteSession } from './note-session.ts'
import { folderChain } from './paths.ts'
import { relocateNotice } from './relocate.ts'
import { Relocation } from './relocation.ts'
import type { ReaderTab, Tabs } from './tabs.ts'
import type {
  FolderSummary,
  ImportFilesReport,
  JsonValue,
  LinkUpdate,
  NoteDocument,
  NoteSummary,
  PaneLayout,
  PreferencesState,
  TitleRename,
  TitleRenameReport,
  UiPatch,
  UiPreferences,
  UpdateInfo,
  VaultChangeEvent,
  WorkspaceData,
} from './types.ts'

export type Selection =
  | { kind: 'all' }
  | { kind: 'starred' }
  | { kind: 'trash' }
  | { kind: 'tag'; tag: string }
  | { kind: 'folder'; id: string }

export type SortKey = 'updated' | 'created' | 'title'

export type Connection = 'connecting' | 'connected' | 'disconnected'

export interface MenuAction {
  kind: 'action'
  label: string
  run(): void
  danger?: boolean
  disabled?: boolean
  /** Set: a radio item (✓ when `true`), e.g. the vault on screen. */
  checked?: boolean
  /** Muted text after the label ("2 tabs"). */
  detail?: string
  /** Tooltip, and the render key when labels can repeat (two vaults named `notes`). */
  title?: string
  /** A small × button at the end of the row (close this vault). */
  secondary?: { label: string; run(): void }
}

export interface MenuColors {
  kind: 'colors'
  current: string | undefined
  pick(color: string | null): void
}

export type MenuEntry = MenuAction | MenuColors | { kind: 'separator' } | { kind: 'heading'; label: string }

export interface ContextMenu {
  x: number
  y: number
  entries: MenuEntry[]
}

export type Dialog =
  | {
      kind: 'prompt'
      title: string
      label: string
      value: string
      confirm: string
      resolve(value: string | null): void
    }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger: boolean; resolve(ok: boolean): void }
  | {
      kind: 'choose'
      title: string
      label: string
      options: Array<{ value: string; label: string }>
      value: string
      confirm: string
      resolve(value: string | null): void
    }
  | {
      kind: 'links'
      title: string
      message: string
      notes: LinkUpdate[]
      confirm: string
      cancel: string
      resolve(ok: boolean): void
    }

export interface Notice {
  kind: 'error' | 'info'
  text: string
  /** Lines listed under the text (what an import skipped). */
  details?: string[]
}

/** Folder colours offered in the folder menu (legacy Boostnote's palette). */
export const FOLDER_COLORS = ['#E10051', '#FF8E00', '#E8D252', '#3FD941', '#30D5C8', '#2BA5F7', '#B013A4']

const SEARCH_DELAY_MS = 200
const REFRESH_DELAY_MS = 100

/** Moves keyboard focus into the editor; `atEnd` also puts the cursor after the last character (new notes). */
export class FocusEditorEvent extends Event {
  readonly atEnd: boolean

  constructor(atEnd: boolean) {
    super('focus-editor')
    this.atEnd = atEnd
  }
}

/**
 * What the workspace talks to: the `/api` client and where each vault's tabs are kept. The page passes its
 * `client` and `localTabStore`; tests pass `createClient` over the router and a memory `TabStore`.
 */
export interface WorkspaceOptions {
  api: Client
  store: TabStore
}

/**
 * State and operations of the workspace: the vault's lists (from `GET /api/workspace`), the sidebar
 * selection, sorting and search, menus and dialogs, the tabs and the open note (`session`, always
 * the active tab's note; every note transition goes through `navigation`), and the preferences.
 * Components render it and call its methods; it emits `change` whenever something visible changed.
 */
export class WorkspaceModel extends TypedEventTarget<{
  change: Event
  'focus-editor': FocusEditorEvent
  find: Event
}> {
  data: WorkspaceData
  selection: Selection = { kind: 'all' }
  sort: SortKey = 'updated'
  query = ''
  /** Search result ids, best first; `null` without a query. */
  hits: string[] | null = null
  readonly expanded = new Set<string>()
  selectedTrashId: string | null = null
  menu: ContextMenu | null = null
  dialog: Dialog | null = null
  titleRenamesOpen = false
  importOpen = false
  preferencesOpen = false
  notice: Notice | null = null
  connection: Connection = 'connecting'
  readonly session: NoteSession
  /** Every note transition (tabs, new and deleted notes, vault switches), each through the one leave-note gate. */
  readonly navigation: Navigation
  readonly #saving: NoteSaving
  /** Every rename and move of notes and folders, and the title renames (one relocation sequence). */
  readonly #relocation: Relocation
  readonly #api: Client
  preferences: UiPreferences
  hotkeyRegistered: boolean
  /** Newer release shown in the status bar. */
  update: UpdateInfo | null

  #searchTimer: ReturnType<typeof setTimeout> | undefined
  #searchAbort: AbortController | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #noticeTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The work running in open order (`#inOpenOrder`): an open-request drain, a reader's "Open folder
   * as vault", or a reader's "Add to vault…" from its folder dialog to main's answer. Later ones
   * queue behind it, so vault switches, imports and the tabs they open never interleave.
   */
  #openRequests: Promise<void> = Promise.resolve()
  /** An "Update links?" question waiting for the dialog over it to close (`#showDialog`). */
  #parked: Dialog | null = null
  /** Counts the requests that return the lists (`refresh`, `#snapshot`), in the order they started. */
  #refreshes = 0
  /**
   * The `#refreshes` count of the latest-started request whose lists showed: refreshes started before it are
   * dropped when they return.
   */
  #listsShown = 0
  /**
   * The editor focus asked for that no editor pane took yet (`takeEditorFocus`): with no vault open, the pane
   * mounts only after the first tab opened, after the request.
   */
  #focusWanted: FocusEditorEvent | null = null
  /** Scratch notes' titles by id, as last shown in the editor (`scratchTabTitle`). */
  readonly #scratchTitles = new Map<string, string>()

  constructor(initial: WorkspaceData, preferences: PreferencesState, { api, store }: WorkspaceOptions) {
    super()
    this.#api = api
    this.data = initial
    this.session = new NoteSession(api)
    this.navigation = new Navigation({
      session: this.session,
      api,
      store,
      host: {
        root: () => this.data.vault?.root,
        hasNote: (id) => this.hasNote(id),
        showVault: (data) => this.#showVault(data),
        notify: (kind, text) => this.notify(kind, text),
        fail: (error) => this.fail(error),
        changed: () => this.changed(),
      },
    })
    this.#saving = new NoteSaving(this.session, (text) => this.notify('error', text))
    this.#relocation = new Relocation({
      session: this.session,
      navigation: this.navigation,
      api,
      host: {
        folderName: (id) => this.folderName(id),
        folderMoved: (map) => {
          if (this.selection.kind === 'folder') this.selection = { kind: 'folder', id: map(this.selection.id) }
          for (const folder of [...this.expanded]) {
            this.expanded.delete(folder)
            this.expanded.add(map(folder))
          }
        },
        refresh: () => this.refresh(),
        notify: (kind, text, sticky) => this.notify(kind, text, [], sticky),
        askLinks: (question) => {
          const { promise, resolve } = Promise.withResolvers<boolean>()
          this.#showDialog({ kind: 'links', ...question, resolve: this.#closing(resolve) })
          return promise
        },
      },
    })
    setPageVault(initial.vault?.root ?? null)
    this.preferences = preferences.ui
    this.hotkeyRegistered = preferences.hotkeyRegistered
    this.update = preferences.update
    this.session.addEventListener('saved', (event) => this.#putSummary(event.note))
    this.session.addEventListener('change', () => {
      const scratch = this.session.scratch
      if (scratch) this.#scratchTitles.set(scratch.id, scratchTitle(this.session.body, scratch.created))
      this.changed()
    })
  }

  changed(): void {
    this.dispatchEvent(new Event('change'))
  }

  // ── Derived lists ────────────────────────────────────────────────────────────────────────

  get openId(): string | null {
    return this.session.note?.id ?? null
  }

  get tabs(): Tabs {
    return this.navigation.tabs
  }

  /** The file of the active reader tab as last read (`null` unless a reader tab is active). */
  get reader() {
    return this.navigation.reader
  }

  /**
   * The tab title of scratch note `id` (`scratchTitle`): the open scratch note's follows its text as typed; another
   * one keeps the title it had when it was last open.
   */
  scratchTabTitle(id: string): string {
    return this.#scratchTitles.get(id) ?? 'Scratch note'
  }

  /** Takes the editor focus asked for that no editor pane took yet (`null`: none); the pane calls this as it mounts. */
  takeEditorFocus(): FocusEditorEvent | null {
    const wanted = this.#focusWanted
    this.#focusWanted = null
    return wanted
  }

  /** Moves keyboard focus into the editor (`focus-editor`), or into the editor pane that mounts next. */
  #focusEditor(atEnd: boolean): void {
    this.#focusWanted = new FocusEditorEvent(atEnd)
    this.dispatchEvent(this.#focusWanted)
  }

  /** The note list for the current selection, search and sort; pinned notes first, in that order. */
  get visibleNotes(): NoteSummary[] {
    const selection = this.selection
    let notes = this.data.notes.filter((note) => {
      if (selection.kind === 'starred') return note.starred
      if (selection.kind === 'tag') return note.tags.includes(selection.tag)
      if (selection.kind === 'folder') return note.folder === selection.id
      return selection.kind === 'all'
    })
    let order: (a: NoteSummary, b: NoteSummary) => number
    if (this.hits) {
      const rank = new Map(this.hits.map((id, index) => [id, index]))
      notes = notes.filter((note) => rank.has(note.id))
      order = (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)
    } else {
      const sort = this.sort
      order = (a, b) =>
        sort === 'title'
          ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
          : b[sort].localeCompare(a[sort])
    }
    return notes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || order(a, b))
  }

  /** Tags with their note counts, case-insensitively sorted. */
  get tags(): Array<[tag: string, count: number]> {
    const counts = new Map<string, number>()
    for (const note of this.data.notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }

  /** Every folder, depth-first, for "Move to…" (root first). */
  get folderOptions(): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = []
    const walk = (folder: FolderSummary, depth: number) => {
      options.push({ value: folder.id, label: `${'\u2003'.repeat(depth)}${folder.name}` })
      for (const child of folder.folders) walk(child, depth + 1)
    }
    if (this.data.tree) walk(this.data.tree, 0)
    return options
  }

  folderName(id: string): string {
    if (id === '') return this.data.vault?.name ?? ''
    return lastSegment(id)
  }

  get selectionTitle(): string {
    const selection = this.selection
    if (selection.kind === 'starred') return 'Starred'
    if (selection.kind === 'trash') return 'Trash'
    if (selection.kind === 'tag') return `#${selection.tag}`
    if (selection.kind === 'folder') return this.folderName(selection.id)
    return 'All notes'
  }

  // ── Selection, search, sorting ──────────────────────────────────────────────────────────

  select(selection: Selection): void {
    this.selection = selection
    this.selectedTrashId = null
    if (selection.kind === 'folder') for (const id of folderChain(parentOf(selection.id))) this.expanded.add(id)
    this.changed()
  }

  toggleExpanded(id: string): void {
    if (!this.expanded.delete(id)) this.expanded.add(id)
    this.changed()
  }

  setSort(sort: SortKey): void {
    this.sort = sort
    this.changed()
  }

  /** Debounced full-text search through the vault index. */
  setQuery(query: string): void {
    this.query = query
    clearTimeout(this.#searchTimer)
    this.#searchAbort?.abort()
    if (query.trim() === '') {
      this.hits = null
      this.changed()
      return
    }
    this.changed()
    this.#searchTimer = setTimeout(() => void this.#search(), SEARCH_DELAY_MS)
  }

  async #search(): Promise<void> {
    const abort = new AbortController()
    this.#searchAbort = abort
    try {
      const { ids } = await this.#api.search(this.query, abort.signal)
      if (abort.signal.aborted) return
      this.hits = ids
      this.changed()
    } catch (error) {
      if (!abort.signal.aborted) this.fail(error)
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────

  /** Whether the vault has a note with this id (as of the last list refresh). */
  hasNote = (id: string): boolean => this.data.notes.some((note) => note.id === id)

  /** Restores the open vault's tabs (after hydration) and loads the active one. */
  restoreTabs(): Promise<void> {
    return this.navigation.restore()
  }

  openNote(id: string, options: { newTab?: boolean } = {}): Promise<void> {
    return this.navigation.open(id, options)
  }

  activateTab(key: number): Promise<void> {
    return this.navigation.activate(key)
  }

  /** Closes a tab (the active one by default); `discard` drops the open note's unsaved edits (see `Navigation.close`). */
  closeTab(key?: number, options: { discard?: boolean } = {}): Promise<void> {
    return this.navigation.close(key, options)
  }

  /**
   * A reader tab's "Open folder as vault": main opens the folder of the tab's file as the vault (the
   * page sends only the ticket) and revokes the ticket; the reader tab becomes that note's tab at
   * the same position, next to the vault's restored tabs. Main refuses a file that can be no note
   * of its folder (a dot-name); the notice says so and the reader stays. Ignored
   * while the reader is closing, opening its folder or being added to the vault, so the tab is
   * still there to turn into the note's. The switch waits for a running open-request drain.
   */
  async openReaderFolder(key: number): Promise<void> {
    const tab = this.tabs.tabs.find((item): item is ReaderTab => item.key === key && item.kind === 'reader')
    const busy = this.navigation.busyReaders
    if (!tab || busy.has(key)) return
    // Claimed before the first await, so a second click while this runs does nothing.
    busy.add(key)
    try {
      await this.#inOpenOrder(() =>
        this.attempt(async () => {
          let id = ''
          await this.navigation.switchVault(
            async () => {
              const opened = await this.#api.openReaderFolder(tab.ticket)
              id = opened.id
              return opened.workspace
            },
            (tabs) => tabs.replaceReader(tab.key, id),
          )
        }),
      )
    } finally {
      busy.delete(key)
    }
  }

  /**
   * A reader tab's "Add to vault…": asks for a folder of the open vault (`dropFolder` first); main
   * then imports the tab's file and its images there and revokes the ticket once a note came in (the
   * page sends only the ticket and the folder id). The open note is saved before the request (a
   * refused save leaves the vault and the ticket as they were). The reader tab becomes the new
   * note's tab at the same position and the notice is the one of a drop; when main imported no
   * note (the file is already in that folder, or skipped) the notice says "Nothing imported: …" and
   * the reader tab stays, its ticket live, so another folder can be chosen. The button is disabled
   * without an open vault; nothing happens while the reader is closing, opening its folder or
   * already being added. The whole action (choosing included) runs in open order: after a running
   * open-request drain, in the vault that drain left open (an error notice when it left none), and
   * a drain that starts meanwhile waits for it.
   */
  async addReaderToVault(key: number): Promise<void> {
    const tab = this.tabs.tabs.find((item): item is ReaderTab => item.key === key && item.kind === 'reader')
    const busy = this.navigation.busyReaders
    if (!tab || !this.data.vault || busy.has(key)) return
    // Claimed before the first await, so a second click while this waits or runs does nothing.
    busy.add(key)
    try {
      await this.#inOpenOrder(async () => {
        if (!this.data.vault) {
          this.notify('error', 'Open a vault first, then add the file to it.')
          return
        }
        const folder = await this.choose({
          title: 'Add to vault',
          label: 'Folder',
          options: this.folderOptions,
          value: this.dropFolder,
          confirm: 'Add',
        })
        if (folder === null || !(await this.navigation.leave())) return
        await this.attempt(async () => {
          const { report, workspace } = await this.#snapshot(() => this.#api.importReader(tab.ticket, folder))
          this.#showData(workspace)
          await this.#reportImport(report, folder, (id) => this.navigation.readerImported(key, id))
        })
      })
    } finally {
      busy.delete(key)
    }
  }

  reopenTab(): Promise<void> {
    return this.navigation.reopen()
  }

  cycleTab(delta: 1 | -1): Promise<void> {
    return this.navigation.cycle(delta)
  }

  selectTab(index: number): Promise<void> {
    return this.navigation.select(index)
  }

  moveTab(key: number, index: number): void {
    this.navigation.move(key, index)
  }

  goBack(): Promise<void> {
    return this.navigation.back()
  }

  goForward(): Promise<void> {
    return this.navigation.forward()
  }

  // ── Notes ──────────────────────────────────────────────────────────────────────────────

  /**
   * Saves the open note's pending edits now, with no notice (editor focusout, window hidden, quit); `false`
   * when unsaved work remains, which decides main's "Quit Anyway?" dialog.
   */
  saveNow(): Promise<boolean> {
    return this.#saving.saveNow()
  }

  /**
   * Saves an image pasted, dropped or picked into the open note (`NoteSession.saveAsset`). A failure is shown as an
   * error notice and rejects too, so the editor inserts no link.
   */
  async saveAsset(file: File): Promise<string> {
    try {
      return await this.session.saveAsset(file)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Conflict bar "Retry" (a save that failed). */
  retrySave(): Promise<void> {
    return this.#saving.retry()
  }

  /** Conflict bar "Keep mine": the editor's version overwrites the one changed on disk. */
  keepMine(): Promise<void> {
    return this.#saving.keepMine()
  }

  /** Removed bar "Save my copy": the editor's version is written back where the note was. */
  saveMyCopy(): Promise<void> {
    return this.#saving.saveMyCopy()
  }

  /** Conflict bar "Load theirs": the editor's edits are dropped for the version on disk. */
  loadTheirs(): void {
    this.#saving.loadTheirs()
  }

  /** Arrow keys in the note list. */
  moveSelection(delta: 1 | -1): void {
    const notes = this.visibleNotes
    const index = notes.findIndex((note) => note.id === this.openId)
    const next = notes[index === -1 ? (delta > 0 ? 0 : notes.length - 1) : index + delta]
    if (next) void this.openNote(next.id)
  }

  async newNote(folder = this.selection.kind === 'folder' ? this.selection.id : ''): Promise<void> {
    if (!this.data.vault) return
    await this.attempt(async () => {
      const created = await this.navigation.newNote(folder)
      if (!created) return
      // A note created but not shown (the active tab moved meanwhile) is still listed.
      if (created.shown) {
        if (this.selection.kind !== 'folder' || this.selection.id !== folder) {
          this.selection = folder === '' ? { kind: 'all' } : { kind: 'folder', id: folder }
        }
        this.setQuery('')
      }
      this.#putSummary(created.note)
      if (created.shown) this.#focusEditor(true)
      await this.refresh()
    })
  }

  /**
   * File › New Scratch Note: after the gate, a new scratch note in a new scratch tab, the cursor in the editor. It
   * is kept outside every vault, so this works with no vault open too.
   */
  async newScratchNote(): Promise<void> {
    await this.attempt(async () => {
      const created = await this.navigation.newScratch()
      if (created?.shown) this.#focusEditor(true)
    })
  }

  async renameNote(id: string): Promise<void> {
    const note = this.data.notes.find((item) => item.id === id)
    if (!note) return
    const stem = noteStem(id)
    const name = await this.prompt({ title: 'Rename note', label: 'File name', value: stem, confirm: 'Rename' })
    if (name === null || name.trim() === '' || name.trim() === stem) return
    await this.attempt(() => this.#relocation.renameNote(id, name.trim()))
  }

  /**
   * Inline rename of the open note (editor header): renames the file, or, for a note whose name
   * comes from a frontmatter `title`, changes that key (cleared: the file name shows again).
   * Resolves with the error message to show, or `null` once renamed.
   */
  async renameOpenNote(name: string): Promise<string | null> {
    const note = this.session.note
    if (!note) return null
    const next = name.trim()
    try {
      if (typeof note.frontmatter.title === 'string' && note.frontmatter.title.trim() !== '') {
        if (next === note.title) return null
        const { title: _title, ...rest } = note.frontmatter
        const ok = await this.session.setFrontmatter(next === '' ? rest : { ...note.frontmatter, title: next })
        return ok ? null : 'Could not update the note'
      }
      if (next === '') return 'A note needs a name'
      if (next === noteStem(note.id)) return null
      await this.#relocation.renameNote(note.id, next)
      return null
    } catch (error) {
      if (error instanceof ApiError && error.code === 'EXISTS') return `A note named “${next}” already exists here`
      if (error instanceof ApiError && error.code === 'INVALID_PATH') return `“${next}” is not a valid note name`
      return error instanceof Error ? error.message : String(error)
    }
  }

  setTitleRenamesOpen(open: boolean): void {
    this.titleRenamesOpen = open
    this.closeMenu()
    this.changed()
  }

  /** File › Rename Files From Titles…, after the user confirmed the plan (`Relocation.applyTitleRenames`). */
  applyTitleRenames(renames: TitleRename[]): Promise<TitleRenameReport | null> {
    return this.#relocation.applyTitleRenames(renames)
  }

  async moveNote(id: string, folder: string): Promise<void> {
    if (parentOf(id) === folder) return
    await this.attempt(() => this.#relocation.moveNote(id, folder))
  }

  async chooseMoveTarget(id: string): Promise<void> {
    const folder = await this.choose({
      title: 'Move note',
      label: 'Folder',
      options: this.folderOptions,
      value: parentOf(id),
      confirm: 'Move',
    })
    if (folder !== null) await this.moveNote(id, folder)
  }

  /** Moves a note to the trash (its latest edits included; refused when the open note cannot be saved); its tabs close. */
  async deleteNote(id: string): Promise<void> {
    if (
      this.preferences.confirmDelete &&
      !(await this.confirm({
        title: 'Move to Trash',
        message: `Move “${this.data.notes.find((note) => note.id === id)?.title ?? id}” to the Trash?`,
        confirm: 'Move to Trash',
        danger: true,
      }))
    ) {
      return
    }
    await this.attempt(async () => {
      const trashed = await this.navigation.deleteNote(id)
      if (!trashed) return
      await this.refresh()
      const { notice, sticky } = relocateNotice({ assetsLeftBehind: trashed.assetsLeftBehind, done: 'Moved to Trash' })
      if (notice) this.notify('info', notice, [], sticky)
    })
  }

  /** Actions of a note's context menu (note list and editor header). */
  noteMenu(id: string): MenuEntry[] {
    const reveal = /Mac/.test(navigator.platform) ? 'Reveal in Finder' : 'Show in Folder'
    const pinned = this.data.notes.find((note) => note.id === id)?.pinned
    return [
      { kind: 'action', label: 'Open in New Tab', run: () => void this.openNote(id, { newTab: true }) },
      { kind: 'action', label: pinned ? 'Unpin' : 'Pin', run: () => void this.toggleFlag('pinned', id) },
      { kind: 'separator' },
      { kind: 'action', label: 'Rename…', run: () => void this.renameNote(id) },
      { kind: 'action', label: 'Move to…', run: () => void this.chooseMoveTarget(id) },
      { kind: 'action', label: reveal, run: () => void this.revealNote(id) },
      { kind: 'separator' },
      { kind: 'action', label: 'Move to Trash', danger: true, run: () => void this.deleteNote(id) },
    ]
  }

  async revealNote(id = this.openId): Promise<void> {
    if (id) await this.attempt(() => this.#api.revealNote(id))
  }

  /** File > Export / Print for the open note; its latest edits are saved first. */
  async exportNote(format: 'html' | 'pdf' | 'markdown' | 'print'): Promise<void> {
    const id = this.openId
    if (!id) {
      this.notify('error', 'Open a note to export it')
      return
    }
    if (!(await this.navigation.leave())) return
    await this.attempt(async () => {
      const { path } = await this.#api.exportNote(id, format)
      if (path) this.notify('info', `Exported to ${path}`)
    })
  }

  /** Exports a folder (`''`: the whole vault) as HTML pages with an index. */
  async exportFolder(folder: string): Promise<void> {
    if (!(await this.navigation.leave())) return
    await this.attempt(async () => {
      const { path } = await this.#api.exportFolder(folder)
      if (path) this.notify('info', `Exported to ${path}`)
    })
  }

  /**
   * `.md`/`.mdx` files opened from Finder/Explorer, taken from main until its queue is empty. A note of a
   * known vault switches to that vault (unless it is already open) and opens in a new tab (or its
   * existing tab); an outside file opens in a reader tab (its existing one when it already has one)
   * and leaves the vault alone. Called after hydration and on SSE `open-request`; a call made while
   * a drain runs starts its own drain after that one, so a request queued as the running drain ends
   * is still taken.
   */
  takeOpenRequest(): Promise<void> {
    return this.#inOpenOrder(() => this.#drainOpenRequests())
  }

  /**
   * Runs `task` after the work in open order running now (and that queued before): an open-request
   * drain, a reader's "Open folder as vault", or a reader's "Add to vault…" (its folder dialog
   * included, so a drain waits while the user chooses).
   */
  #inOpenOrder(task: () => Promise<void>): Promise<void> {
    const run = this.#openRequests.then(task)
    this.#openRequests = run.catch(() => undefined)
    return run
  }

  async #drainOpenRequests(): Promise<void> {
    await this.attempt(async () => {
      for (let request = await this.#api.takeOpenRequest(); request; request = await this.#api.takeOpenRequest()) {
        if (request.kind === 'external') {
          const { ticket, name } = request
          await this.navigation.openReader(ticket, name)
          continue
        }
        if (this.data.vault?.root !== request.vault) {
          const open = async () => (await this.#api.openVault(request.vault)).workspace
          if (!(await this.navigation.switchVault(open))) return
        }
        const id = request.id
        const tab = this.tabs.tabs.find((item) => item.kind === 'note' && item.path === id)
        if (tab) await this.activateTab(tab.key)
        else await this.openNote(id, { newTab: true })
      }
    })
  }

  /** Where dropped files go when not dropped onto a folder row: the selected folder, else the root. */
  get dropFolder(): string {
    return this.selection.kind === 'folder' ? this.selection.id : ''
  }

  /**
   * Drag and drop: copies the `.md`/`.mdx` files and folders behind a preload drop ticket into `folder`.
   * A single dropped note opens in a new tab; the notice sums up the import and lists what was skipped.
   */
  async importDropped(drop: DropTicket | undefined, folder: string): Promise<void> {
    if (!this.data.vault) {
      this.notify('error', 'Open a vault first, then drop Markdown files onto it.')
      return
    }
    if (!drop || drop.count === 0) {
      this.notify('error', 'Only files and folders from disk can be dropped here.')
      return
    }
    await this.attempt(async () => {
      const report = await this.#api.importFiles(drop.ticket, folder)
      await this.refresh()
      await this.#reportImport(
        report,
        folder,
        drop.count === 1 ? (id) => this.openNote(id, { newTab: true }) : undefined,
      )
    })
  }

  /**
   * The notice of a file import into `folder` (a drop, a reader's "Add to vault…"): what was
   * imported, images copied, and what was skipped or left as is. When exactly one note was
   * imported, `open` (if given) opens it first.
   */
  async #reportImport(report: ImportFilesReport, folder: string, open?: (id: string) => Promise<void>): Promise<void> {
    const details = [
      ...report.skipped.map((skip) => `Skipped ${lastSegment(skip.source)}: ${skip.reason}`),
      ...report.unresolved.map((link) => `${lastSegment(link.id)}: link “${link.link}” left as is (${link.reason})`),
    ]
    const imported = report.notes.length
    if (imported === 0) {
      const only = report.skipped.length === 1 ? report.skipped[0] : undefined
      this.notify(
        'info',
        only ? `Nothing imported: ${lastSegment(only.source)} is ${only.reason}` : 'Nothing imported',
        details,
      )
      return
    }
    const first = report.notes[0]
    if (open && imported === 1 && first) await open(first.id)
    const extras = [`${report.assets} ${report.assets === 1 ? 'image' : 'images'} copied`]
    if (report.skipped.length > 0) extras.push(`${report.skipped.length} skipped`)
    this.notify(
      'info',
      `Imported ${imported} ${imported === 1 ? 'note' : 'notes'} into ${this.folderName(folder)} (${extras.join(', ')})`,
      details,
    )
  }

  /**
   * Sets or removes `starred: true` / `pinned: true` on a note (default: the open one). The open note
   * goes through its session, so typing not yet saved is kept; another note is read and saved by hash.
   */
  async toggleFlag(key: 'starred' | 'pinned', id = this.openId): Promise<void> {
    const flip = (note: NoteDocument) => {
      const { [key]: _old, ...rest } = note.frontmatter
      return note[key] ? rest : { ...note.frontmatter, [key]: true }
    }
    const open = this.session.note
    if (open && open.id === id) {
      if (!(await this.session.setFrontmatter(flip(open)))) this.notify('error', 'Could not update the note')
      return
    }
    if (!id) return
    await this.attempt(async () => {
      const note = await this.#api.readNote(id)
      this.#putSummary(await this.#api.saveNote({ id, body: note.body, baseHash: note.hash, frontmatter: flip(note) }))
    })
  }

  /**
   * Properties panel: writes the open note's frontmatter (keys sent back unchanged keep their YAML bytes).
   * `false` when it was not written: no open note (no notice), or the note is locked or its save failed (with the "could not update" notice).
   */
  async setFrontmatter(frontmatter: Record<string, JsonValue>): Promise<boolean> {
    if (!this.session.note) return false
    if (await this.session.setFrontmatter(frontmatter)) return true
    this.notify('error', 'Could not update the note')
    return false
  }

  // ── Preferences and layout ──────────────────────────────────────────────────────────────

  /** Stores and applies preferences; the error message when they were refused (a taken hotkey), else `null`. */
  async savePreferences(patch: UiPatch): Promise<string | null> {
    try {
      const state = await this.#api.savePreferences(patch)
      this.preferences = state.ui
      this.hotkeyRegistered = state.hotkeyRegistered
      this.update = state.update
      this.changed()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Pane sizes and visibility: shown right away, stored in `settings.json`. */
  setPanes(panes: Partial<PaneLayout>): void {
    this.preferences = { ...this.preferences, panes: { ...this.preferences.panes, ...panes } }
    this.changed()
    void this.savePreferences({ panes }).then((error) => {
      if (error) this.notify('error', error)
    })
  }

  togglePane(pane: 'sidebarCollapsed' | 'listCollapsed' | 'propertiesOpen'): void {
    this.setPanes({ [pane]: !this.preferences.panes[pane] })
  }

  setPreferencesOpen(open: boolean): void {
    this.preferencesOpen = open
    this.closeMenu()
    this.changed()
  }

  /** Edit > Find: the editor opens its search panel. */
  find(): void {
    if (this.session.note) this.dispatchEvent(new Event('find'))
  }

  // ── Folders ────────────────────────────────────────────────────────────────────────────

  async newFolder(parent = this.selection.kind === 'folder' ? this.selection.id : ''): Promise<void> {
    if (!this.data.vault) return
    const name = await this.prompt({ title: 'New folder', label: 'Folder name', value: '', confirm: 'Create' })
    if (name === null || name.trim() === '') return
    await this.attempt(async () => {
      const { id } = await this.#api.createFolder(parent, name.trim())
      await this.refresh()
      this.select({ kind: 'folder', id })
    })
  }

  async renameFolder(id: string): Promise<void> {
    const current = this.folderName(id)
    const name = await this.prompt({ title: 'Rename folder', label: 'Folder name', value: current, confirm: 'Rename' })
    if (name === null || name.trim() === '' || name.trim() === current) return
    await this.attempt(() => this.#relocation.renameFolder(id, name.trim()))
  }

  async moveFolder(id: string, parent: string): Promise<void> {
    if (parentOf(id) === parent || isAtOrUnder(parent, id)) return
    await this.attempt(() => this.#relocation.moveFolder(id, parent))
  }

  async deleteFolder(id: string): Promise<void> {
    if (this.preferences.confirmDelete) {
      const ok = await this.confirm({
        title: 'Delete folder',
        message: `Move “${this.folderName(id)}” and everything in it to the Trash?`,
        confirm: 'Move to Trash',
        danger: true,
      })
      if (!ok) return
    }
    await this.attempt(async () => {
      if (!(await this.navigation.deleteFolder(id))) return
      if (this.selection.kind === 'folder' && isAtOrUnder(this.selection.id, id)) {
        this.selection = { kind: 'all' }
      }
      await this.refresh()
    })
  }

  async setFolderColor(id: string, color: string | null): Promise<void> {
    await this.attempt(async () => {
      await this.#api.setFolderColor(id, color)
      await this.refresh()
    })
  }

  // ── Trash ──────────────────────────────────────────────────────────────────────────────

  async restore(trashId: string): Promise<void> {
    await this.attempt(async () => {
      const restored = await this.#api.restore(trashId)
      this.selectedTrashId = null
      await this.refresh()
      const { notice, sticky } = relocateNotice({
        assetsLeftBehind: restored.assetsLeftBehind,
        done: `Restored ${restored.id}`,
      })
      if (notice) this.notify('info', notice, [], sticky)
    })
  }

  async emptyTrash(): Promise<void> {
    const ok = await this.confirm({
      title: 'Empty Trash',
      message: 'Permanently delete everything in the Trash? This cannot be undone.',
      confirm: 'Empty Trash',
      danger: true,
    })
    if (ok) {
      await this.attempt(async () => {
        await this.#api.emptyTrash()
        await this.refresh()
      })
    }
  }

  // ── Vaults ─────────────────────────────────────────────────────────────────────────────

  async pickVault(): Promise<void> {
    await this.attempt(() => this.navigation.switchVault(async () => (await this.#api.pickVault()).workspace))
  }

  async openVault(path: string): Promise<void> {
    await this.attempt(() => this.navigation.switchVault(async () => (await this.#api.openVault(path)).workspace))
  }

  /**
   * Closes an open vault (default: the one on screen). Closing the vault on screen switches to the
   * most recently used other open vault; closing another one only updates the vault lists.
   */
  async closeVault(root = this.data.vault?.root): Promise<void> {
    if (!root) return
    if (root !== this.data.vault?.root) {
      await this.attempt(async () => {
        this.data = await this.#snapshot(() => this.#api.closeVault(root))
        this.changed()
      })
      return
    }
    await this.attempt(() => this.navigation.switchVault(() => this.#api.closeVault(root)))
  }

  /** How many tabs an open vault keeps (its saved tabs; the vault on screen: its live tabs). */
  tabCount(root: string): number {
    return this.navigation.tabCount(root)
  }

  async forgetVault(path: string): Promise<void> {
    await this.attempt(async () => {
      this.data = await this.#snapshot(() => this.#api.forgetVault(path))
      this.changed()
    })
  }

  /**
   * Shows another vault's lists (or none) before `navigation` restores its tabs. An "Update links?" question of the
   * vault left, showing or parked, is answered "Don't update" (its links are not this vault's), so the questions
   * queued behind it go on; a dialog over it stays.
   */
  #showVault(data: WorkspaceData): void {
    this.data = data
    setPageVault(data.vault?.root ?? null)
    this.selection = { kind: 'all' }
    this.expanded.clear()
    this.importOpen = false
    this.setQuery('')
    const question = this.dialog?.kind === 'links' ? this.dialog : this.#parked
    if (question?.kind === 'links') {
      const over = question === this.dialog ? null : this.dialog
      this.#parked = null
      question.resolve(false)
      this.dialog = over
    }
  }

  // ── Live updates ────────────────────────────────────────────────────────────────────────

  /**
   * Re-reads the lists (after a mutation, or when the vault changed on disk). Lists that return once another vault
   * shows are dropped: they are the vault left's; so are lists that return once the lists of a request started
   * after this one showed (a later refresh, a reader import, a vault closed or forgotten: `#snapshot`): they may be
   * older than those. A later refresh that fails drops nothing, so this one's lists still show.
   */
  async refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer)
    const sameVault = this.navigation.vaultToken()
    const at = ++this.#refreshes
    const data = await this.#api.workspace()
    if (!sameVault() || at < this.#listsShown) return
    this.#listsShown = at
    this.#showData(data)
  }

  /**
   * Runs `request`, which returns lists the caller shows at once: refreshes started before it are dropped when they
   * return after it (`refresh`). Its own lists show even when a refresh started after it showed first: that refresh
   * may have been answered before the vault did this request's work (an import's note would then be missing, and
   * its tab closed), while these lists were made once that work was done.
   */
  async #snapshot<T>(request: () => Promise<T>): Promise<T> {
    const at = ++this.#refreshes
    const result = await request()
    this.#listsShown = Math.max(this.#listsShown, at)
    return result
  }

  /** Shows the open vault's lists as `data` has them (same vault): selection and tabs follow. */
  #showData(data: WorkspaceData): void {
    this.data = data
    const selection = this.selection
    const folderGone =
      selection.kind === 'folder' && selection.id !== '' && !this.folderOptions.some((o) => o.value === selection.id)
    const tagGone = selection.kind === 'tag' && !data.notes.some((note) => note.tags.includes(selection.tag))
    if (folderGone || tagGone) this.selection = { kind: 'all' }
    this.navigation.dropMissing()
    if (this.query.trim() !== '') void this.#search()
    this.changed()
  }

  /** SSE `vault` event: an external change. Changes in the other open vaults don't concern this page. */
  onVaultChange(change: VaultChangeEvent): void {
    if (change.root !== this.data.vault?.root) return
    if (change.id === this.openId) {
      if (change.change === 'note-removed') this.session.externalRemoval()
      else void this.session.externalChange()
    }
    clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => void this.refresh().catch((error) => this.fail(error)), REFRESH_DELAY_MS)
  }

  /** SSE `update` event: a newer release; shown unless the user dismissed that version. */
  onUpdate(update: UpdateInfo): void {
    if (update.version === this.preferences.dismissedUpdate) return
    this.update = update
    this.changed()
  }

  /** Hides the notice for this version for good (a newer version shows again). */
  dismissUpdate(): void {
    const update = this.update
    if (!update) return
    this.update = null
    this.changed()
    void this.savePreferences({ dismissedUpdate: update.version }).then((error) => {
      if (error) this.notify('error', error)
    })
  }

  /** Opens the release page in the browser. */
  downloadUpdate(): void {
    const url = this.update?.url
    if (url) void this.attempt(() => this.#api.openExternal(url))
  }

  setConnection(connection: Connection): void {
    const reconnected = connection === 'connected' && this.connection === 'disconnected'
    this.connection = connection
    // Events may have been missed while disconnected.
    if (reconnected && this.data.vault) void this.refresh().catch((error) => this.fail(error))
    this.changed()
  }

  #putSummary(note: NoteSummary): void {
    const summary = toMeta(note)
    const index = this.data.notes.findIndex((item) => item.id === note.id)
    if (index === -1) this.data.notes.push(summary)
    else this.data.notes[index] = summary
    this.changed()
  }

  // ── Menus, dialogs, notices ─────────────────────────────────────────────────────────────

  openMenu(x: number, y: number, entries: MenuEntry[]): void {
    this.menu = { x, y, entries }
    this.changed()
  }

  closeMenu(): void {
    if (!this.menu) return
    this.menu = null
    this.changed()
  }

  prompt(options: { title: string; label: string; value: string; confirm: string }): Promise<string | null> {
    const { promise, resolve } = Promise.withResolvers<string | null>()
    this.#showDialog({ kind: 'prompt', ...options, resolve: this.#closing(resolve) })
    return promise
  }

  confirm(options: { title: string; message: string; confirm: string; danger: boolean }): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    this.#showDialog({ kind: 'confirm', ...options, resolve: this.#closing(resolve) })
    return promise
  }

  choose(options: {
    title: string
    label: string
    options: Array<{ value: string; label: string }>
    value: string
    confirm: string
  }): Promise<string | null> {
    const { promise, resolve } = Promise.withResolvers<string | null>()
    this.#showDialog({ kind: 'choose', ...options, resolve: this.#closing(resolve) })
    return promise
  }

  /**
   * Shows `dialog`, cancelling the one already open. An "Update links?" question is never cancelled: a dialog
   * opened over it parks it, and one that comes while another dialog is open waits parked; it shows once that
   * dialog closes (`Relocation` asks one question at a time, so at most one is parked).
   */
  #showDialog(dialog: Dialog): void {
    this.closeMenu()
    const previous = this.dialog
    if (previous && dialog.kind === 'links') {
      this.#parked = dialog
      return
    }
    if (previous?.kind === 'links') this.#parked = previous
    else if (previous) {
      // Closing the cancelled dialog must not bring the parked question back under `dialog`.
      const parked = this.#parked
      this.#parked = null
      if (previous.kind === 'confirm') previous.resolve(false)
      else previous.resolve(null)
      this.#parked = parked
    }
    this.dialog = dialog
    this.changed()
  }

  /** Wraps a dialog's resolver so answering it also closes it (a parked question then shows again). */
  #closing<T>(resolve: (value: T) => void): (value: T) => void {
    return (value) => {
      this.dialog = this.#parked
      this.#parked = null
      this.changed()
      resolve(value)
    }
  }

  setImportOpen(open: boolean): void {
    this.importOpen = open
    this.closeMenu()
    this.changed()
  }

  notify(kind: Notice['kind'], text: string, details: string[] = [], sticky = false): void {
    clearTimeout(this.#noticeTimer)
    this.notice = details.length > 0 ? { kind, text, details } : { kind, text }
    // A notice with details, or a sticky one, stays until dismissed: it is read, not glanced at.
    if (details.length === 0 && !sticky) {
      this.#noticeTimer = setTimeout(() => this.dismissNotice(), kind === 'error' ? 8000 : 3000)
    }
    this.changed()
  }

  dismissNotice(): void {
    this.notice = null
    this.changed()
  }

  fail(error: unknown): void {
    this.notify('error', error instanceof Error ? error.message : String(error))
  }

  /** Runs a mutation; failures become an error notice. */
  async attempt(task: () => Promise<unknown>): Promise<void> {
    try {
      await task()
    } catch (error) {
      this.fail(error)
    }
  }
}
