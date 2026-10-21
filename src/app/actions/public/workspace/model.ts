import { TypedEventTarget } from 'remix/component'

import { ApiError, client } from './api.ts'
import { NoteSession } from './note-session.ts'
import { folderChain, parentOf } from './paths.ts'
import { type Tab, Tabs } from './tabs.ts'
import type {
  FolderSummary,
  JsonValue,
  NoteSummary,
  PaneLayout,
  PreferencesState,
  TitleRename,
  TitleRenameReport,
  UiPatch,
  UiPreferences,
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
}

export interface MenuColors {
  kind: 'colors'
  current: string | undefined
  pick(color: string | null): void
}

export type MenuEntry = MenuAction | MenuColors | { kind: 'separator' }

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

export interface Notice {
  kind: 'error' | 'info'
  text: string
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

/** `localStorage` key of a vault's tabs (`TabsSnapshot`). */
const tabsStorageKey = (root: string) => `boostnote.tabs:${root}`

/**
 * State and operations of the workspace: the vault's lists (from `GET /api/workspace`), the sidebar
 * selection, sorting and search, menus and dialogs, the tabs and the open note (`session`, always
 * the active tab's note), and the preferences. Components render it and call its methods; it emits
 * `change` whenever something visible changed.
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
  readonly session = new NoteSession()
  tabs = new Tabs()
  preferences: UiPreferences
  hotkeyRegistered: boolean

  #searchTimer: ReturnType<typeof setTimeout> | undefined
  #searchAbort: AbortController | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #noticeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(initial: WorkspaceData, preferences: PreferencesState) {
    super()
    this.data = initial
    this.preferences = preferences.ui
    this.hotkeyRegistered = preferences.hotkeyRegistered
    this.session.addEventListener('saved', (event) => this.#putSummary(event.note))
    this.session.addEventListener('change', () => this.changed())
  }

  changed(): void {
    this.dispatchEvent(new Event('change'))
  }

  // ── Derived lists ────────────────────────────────────────────────────────────────────────

  get openId(): string | null {
    return this.session.note?.id ?? null
  }

  /** The note list for the current selection, search and sort. */
  get visibleNotes(): NoteSummary[] {
    const selection = this.selection
    let notes = this.data.notes.filter((note) => {
      if (selection.kind === 'starred') return note.starred
      if (selection.kind === 'tag') return note.tags.includes(selection.tag)
      if (selection.kind === 'folder') return note.folder === selection.id
      return selection.kind === 'all'
    })
    if (this.hits) {
      const rank = new Map(this.hits.map((id, index) => [id, index]))
      notes = notes.filter((note) => rank.has(note.id))
      return notes.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    }
    const sort = this.sort
    return notes.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        : b[sort].localeCompare(a[sort]),
    )
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
    return id.slice(id.lastIndexOf('/') + 1)
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
      const { ids } = await client.search(this.query, abort.signal)
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

  /** Restores the open vault's tabs from `localStorage` (after hydration, after switching vaults). */
  async restoreTabs(): Promise<void> {
    const root = this.data.vault?.root
    let snapshot: unknown = null
    try {
      snapshot = root ? JSON.parse(localStorage.getItem(tabsStorageKey(root)) ?? 'null') : null
    } catch {
      // A corrupt entry restores no tabs.
    }
    this.tabs = Tabs.restore(snapshot, this.hasNote)
    await this.#loadActiveTab()
  }

  #saveTabs(): void {
    const root = this.data.vault?.root
    if (root) localStorage.setItem(tabsStorageKey(root), JSON.stringify(this.tabs))
  }

  /** Saves the open note, applies `change` to the tabs and loads the (new) active tab's note. */
  async #switchTabs(change: () => unknown): Promise<void> {
    if (!(await this.leaveNote())) return
    change()
    this.#saveTabs()
    await this.#loadActiveTab()
  }

  /** Makes the session show the active tab's note (or nothing without tabs). */
  async #loadActiveTab(): Promise<void> {
    const id = this.tabs.active?.path
    if (id === undefined) {
      if (this.session.note) this.session.close()
      this.changed()
      return
    }
    if (id === this.openId) {
      this.changed()
      return
    }
    try {
      this.session.open(await client.readNote(id))
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        this.fail(error)
        return
      }
      this.notify('error', `Note not found: ${id}`)
      this.tabs.forget((path) => path === id)
      this.#saveTabs()
      await this.#loadActiveTab()
    }
  }

  /**
   * Opens a note after saving the current one (refused while that has an unresolved conflict): in
   * the active tab, pushing onto its back trail, or with `newTab` in a new tab after it.
   */
  async openNote(id: string, options: { newTab?: boolean } = {}): Promise<void> {
    if (!options.newTab && this.openId === id) return
    await this.#switchTabs(() => (options.newTab ? this.tabs.openNew(id) : this.tabs.navigate(id)))
  }

  async activateTab(key: number): Promise<void> {
    if (key !== this.tabs.activeKey) await this.#switchTabs(() => this.tabs.activate(key))
  }

  /**
   * Closes a tab (the active one by default). Closing the active tab saves its note first; `discard`
   * drops unsaved edits instead (the "Close" of a note removed on disk).
   */
  async closeTab(key = this.tabs.activeKey, options: { discard?: boolean } = {}): Promise<void> {
    if (key === null) return
    if (key !== this.tabs.activeKey) {
      this.tabs.close(key)
      this.#saveTabs()
      this.changed()
      return
    }
    if (options.discard) this.session.close()
    await this.#switchTabs(() => this.tabs.close(key))
  }

  async reopenTab(): Promise<void> {
    if (this.tabs.closed.length > 0) await this.#switchTabs(() => this.tabs.reopen(this.hasNote))
  }

  async cycleTab(delta: 1 | -1): Promise<void> {
    if (this.tabs.tabs.length > 1) await this.#switchTabs(() => this.tabs.cycle(delta))
  }

  async selectTab(index: number): Promise<void> {
    const target: Tab | undefined = this.tabs.tabs[index === -1 ? this.tabs.tabs.length - 1 : index]
    if (target) await this.activateTab(target.key)
  }

  moveTab(key: number, index: number): void {
    this.tabs.move(key, index)
    this.#saveTabs()
    this.changed()
  }

  async goBack(): Promise<void> {
    if (this.tabs.canGoBack()) await this.#switchTabs(() => this.tabs.back(this.hasNote))
  }

  async goForward(): Promise<void> {
    if (this.tabs.canGoForward()) await this.#switchTabs(() => this.tabs.forward(this.hasNote))
  }

  /** Notes were renamed/moved by the app: tabs follow. */
  #rebaseTabs(map: (path: string) => string): void {
    this.tabs.rebase(map)
    this.#saveTabs()
  }

  /** Notes were deleted by the app: their tabs close; the session follows the active tab. */
  async #forgetTabs(gone: (path: string) => boolean): Promise<void> {
    const openGone = this.openId !== null && gone(this.openId)
    this.tabs.forget(gone)
    this.#saveTabs()
    if (openGone) this.session.close()
    await this.#loadActiveTab()
  }

  // ── Notes ──────────────────────────────────────────────────────────────────────────────

  /** Saves the open note; `false` (with a notice) when unsaved work would be lost by leaving it. */
  async leaveNote(): Promise<boolean> {
    if (await this.session.flush()) return true
    this.notify('error', 'This note has unsaved changes that could not be saved. Resolve them first.')
    return false
  }

  /** Arrow keys in the note list. */
  moveSelection(delta: 1 | -1): void {
    const notes = this.visibleNotes
    const index = notes.findIndex((note) => note.id === this.openId)
    const next = notes[index === -1 ? (delta > 0 ? 0 : notes.length - 1) : index + delta]
    if (next) void this.openNote(next.id)
  }

  async newNote(folder = this.selection.kind === 'folder' ? this.selection.id : ''): Promise<void> {
    if (!this.data.vault || !(await this.leaveNote())) return
    await this.attempt(async () => {
      const note = await client.createNote(folder)
      if (this.selection.kind !== 'folder' || this.selection.id !== folder) {
        this.selection = folder === '' ? { kind: 'all' } : { kind: 'folder', id: folder }
      }
      this.setQuery('')
      this.#putSummary(note)
      this.tabs.navigate(note.id)
      this.#saveTabs()
      this.session.open(note)
      this.dispatchEvent(new FocusEditorEvent(true))
      await this.refresh()
    })
  }

  async renameNote(id: string): Promise<void> {
    const note = this.data.notes.find((item) => item.id === id)
    if (!note) return
    const stem = id.slice(id.lastIndexOf('/') + 1).replace(/\.md$/, '')
    const name = await this.prompt({ title: 'Rename note', label: 'File name', value: stem, confirm: 'Rename' })
    if (name === null || name.trim() === '' || name.trim() === stem) return
    await this.attempt(() => this.#renameFile(id, name.trim()))
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
      if (next === note.id.slice(note.id.lastIndexOf('/') + 1).replace(/\.md$/, '')) return null
      await this.#renameFile(note.id, next)
      return null
    } catch (error) {
      if (error instanceof ApiError && error.code === 'EXISTS') return `A note named “${next}” already exists here`
      if (error instanceof ApiError && error.code === 'INVALID_PATH') return `“${next}” is not a valid note name`
      return error instanceof Error ? error.message : String(error)
    }
  }

  async #renameFile(id: string, name: string): Promise<void> {
    if (this.openId === id && !(await this.leaveNote())) return
    const renamed = await client.renameNote(id, name)
    this.#rebaseTabs((path) => (path === id ? renamed.id : path))
    if (this.openId === id) this.session.relocated(renamed)
    await this.refresh()
  }

  setTitleRenamesOpen(open: boolean): void {
    this.titleRenamesOpen = open
    this.closeMenu()
    this.changed()
  }

  /**
   * File › Rename Files From Titles…, after the user confirmed the plan: saves the open note, runs
   * the renames, then tabs follow their notes and the open note is reloaded (its links may have
   * been rewritten). `null` when the open note could not be saved first.
   */
  async applyTitleRenames(renames: TitleRename[]): Promise<TitleRenameReport | null> {
    if (!(await this.leaveNote())) return null
    const report = await client.applyTitleRenames(renames)
    const moved = new Map(report.renamed.map((rename) => [rename.from, rename.to]))
    const openId = this.openId
    this.#rebaseTabs((path) => moved.get(path) ?? path)
    if (openId !== null) this.session.open(await client.readNote(moved.get(openId) ?? openId))
    await this.refresh()
    return report
  }

  async moveNote(id: string, folder: string): Promise<void> {
    if (parentOf(id) === folder) return
    if (this.openId === id && !(await this.leaveNote())) return
    await this.attempt(async () => {
      const moved = await client.moveNote(id, folder)
      this.#rebaseTabs((path) => (path === id ? moved.id : path))
      if (this.openId === id) this.session.relocated(moved)
      await this.refresh()
      this.notify('info', `Moved to ${this.folderName(folder)}`)
    })
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

  /** Moves a note to the trash (its latest edits included); its tabs close. */
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
    if (this.openId === id) await this.session.flush()
    await this.attempt(async () => {
      await client.deleteNote(id)
      await this.#forgetTabs((path) => path === id)
      await this.refresh()
      this.notify('info', 'Moved to Trash')
    })
  }

  /** Actions of a note's context menu (note list and editor header). */
  noteMenu(id: string): MenuEntry[] {
    const reveal = /Mac/.test(navigator.platform) ? 'Reveal in Finder' : 'Show in Folder'
    return [
      { kind: 'action', label: 'Open in New Tab', run: () => void this.openNote(id, { newTab: true }) },
      { kind: 'separator' },
      { kind: 'action', label: 'Rename…', run: () => void this.renameNote(id) },
      { kind: 'action', label: 'Move to…', run: () => void this.chooseMoveTarget(id) },
      { kind: 'action', label: reveal, run: () => void this.revealNote(id) },
      { kind: 'separator' },
      { kind: 'action', label: 'Move to Trash', danger: true, run: () => void this.deleteNote(id) },
    ]
  }

  async revealNote(id = this.openId): Promise<void> {
    if (id) await this.attempt(() => client.revealNote(id))
  }

  /** File > Export / Print for the open note; its latest edits are saved first. */
  async exportNote(format: 'html' | 'pdf' | 'markdown' | 'print'): Promise<void> {
    const id = this.openId
    if (!id) {
      this.notify('error', 'Open a note to export it')
      return
    }
    if (!(await this.leaveNote())) return
    await this.attempt(async () => {
      const { path } = await client.exportNote(id, format)
      if (path) this.notify('info', `Exported to ${path}`)
    })
  }

  /** Exports a folder (`''`: the whole vault) as HTML pages with an index. */
  async exportFolder(folder: string): Promise<void> {
    if (!(await this.leaveNote())) return
    await this.attempt(async () => {
      const { path } = await client.exportFolder(folder)
      if (path) this.notify('info', `Exported to ${path}`)
    })
  }

  /**
   * A `.md` file opened from Finder/Explorer: switches to its folder as the vault (unless that is
   * already open) and opens the note in a new tab. Called after hydration and on SSE `open-request`.
   */
  async takeOpenRequest(): Promise<void> {
    await this.attempt(async () => {
      const request = await client.takeOpenRequest()
      if (!request) return
      if (this.data.vault?.root !== request.vault) {
        if (!(await this.leaveNote())) return
        const result = await client.openVault(request.vault)
        if (result.workspace) await this.#switched(result.workspace)
      }
      const tab = this.tabs.tabs.find((item) => item.path === request.id)
      if (tab) await this.activateTab(tab.key)
      else await this.openNote(request.id, { newTab: true })
    })
  }

  async toggleStar(): Promise<void> {
    const note = this.session.note
    if (!note) return
    const { starred: _starred, ...rest } = note.frontmatter
    if (!(await this.session.setFrontmatter(note.starred ? rest : { ...note.frontmatter, starred: true }))) {
      this.notify('error', 'Could not update the note')
    }
  }

  /** Properties panel: writes the open note's frontmatter (keys sent back unchanged keep their YAML bytes). */
  async setFrontmatter(frontmatter: Record<string, JsonValue>): Promise<void> {
    if (!this.session.note) return
    if (!(await this.session.setFrontmatter(frontmatter))) this.notify('error', 'Could not update the note')
  }

  // ── Preferences and layout ──────────────────────────────────────────────────────────────

  /** Stores and applies preferences; the error message when they were refused (a taken hotkey), else `null`. */
  async savePreferences(patch: UiPatch): Promise<string | null> {
    try {
      const state = await client.savePreferences(patch)
      this.preferences = state.ui
      this.hotkeyRegistered = state.hotkeyRegistered
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
      const { id } = await client.createFolder(parent, name.trim())
      await this.refresh()
      this.select({ kind: 'folder', id })
    })
  }

  async renameFolder(id: string): Promise<void> {
    const current = this.folderName(id)
    const name = await this.prompt({ title: 'Rename folder', label: 'Folder name', value: current, confirm: 'Rename' })
    if (name === null || name.trim() === '' || name.trim() === current) return
    await this.#relocateFolder(id, () => client.renameFolder(id, name.trim()))
  }

  async moveFolder(id: string, parent: string): Promise<void> {
    if (parentOf(id) === parent || id === parent || parent.startsWith(`${id}/`)) return
    await this.#relocateFolder(id, () => client.moveFolder(id, parent))
  }

  async #relocateFolder(id: string, relocate: () => Promise<{ id: string }>): Promise<void> {
    const affectsOpen = this.openId?.startsWith(`${id}/`) ?? false
    if (affectsOpen && !(await this.leaveNote())) return
    await this.attempt(async () => {
      const { id: next } = await relocate()
      const rebase = (value: string) =>
        value === id || value.startsWith(`${id}/`) ? next + value.slice(id.length) : value
      if (this.selection.kind === 'folder') this.selection = { kind: 'folder', id: rebase(this.selection.id) }
      for (const folder of [...this.expanded]) {
        this.expanded.delete(folder)
        this.expanded.add(rebase(folder))
      }
      this.#rebaseTabs(rebase)
      const openId = this.openId
      if (affectsOpen && openId) this.session.relocated(await client.readNote(rebase(openId)))
      await this.refresh()
    })
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
    const affectsOpen = this.openId?.startsWith(`${id}/`) ?? false
    if (affectsOpen) await this.session.flush()
    await this.attempt(async () => {
      await client.deleteFolder(id)
      await this.#forgetTabs((path) => path.startsWith(`${id}/`))
      if (this.selection.kind === 'folder' && (this.selection.id === id || this.selection.id.startsWith(`${id}/`))) {
        this.selection = { kind: 'all' }
      }
      await this.refresh()
    })
  }

  async setFolderColor(id: string, color: string | null): Promise<void> {
    await this.attempt(async () => {
      await client.setFolderColor(id, color)
      await this.refresh()
    })
  }

  // ── Trash ──────────────────────────────────────────────────────────────────────────────

  async restore(trashId: string): Promise<void> {
    await this.attempt(async () => {
      const { id } = await client.restore(trashId)
      this.selectedTrashId = null
      await this.refresh()
      this.notify('info', `Restored ${id}`)
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
        await client.emptyTrash()
        await this.refresh()
      })
    }
  }

  // ── Vaults ─────────────────────────────────────────────────────────────────────────────

  async pickVault(): Promise<void> {
    if (!(await this.leaveNote())) return
    await this.attempt(async () => {
      const result = await client.pickVault()
      if (result.workspace) this.#switched(result.workspace)
    })
  }

  async openVault(path: string): Promise<void> {
    if (!(await this.leaveNote())) return
    await this.attempt(async () => {
      const result = await client.openVault(path)
      if (result.workspace) this.#switched(result.workspace)
    })
  }

  async closeVault(): Promise<void> {
    if (!(await this.leaveNote())) return
    await this.attempt(async () => this.#switched(await client.closeVault()))
  }

  async forgetVault(path: string): Promise<void> {
    await this.attempt(async () => {
      this.data = await client.forgetVault(path)
      this.changed()
    })
  }

  #switched(data: WorkspaceData): Promise<void> {
    this.session.close()
    this.data = data
    this.selection = { kind: 'all' }
    this.expanded.clear()
    this.importOpen = false
    this.setQuery('')
    return this.restoreTabs()
  }

  // ── Live updates ────────────────────────────────────────────────────────────────────────

  /** Re-reads the lists (after a mutation, or when the vault changed on disk). */
  async refresh(): Promise<void> {
    clearTimeout(this.#refreshTimer)
    const data = await client.workspace()
    this.data = data
    const selection = this.selection
    const folderGone =
      selection.kind === 'folder' && selection.id !== '' && !this.folderOptions.some((o) => o.value === selection.id)
    const tagGone = selection.kind === 'tag' && !data.notes.some((note) => note.tags.includes(selection.tag))
    if (folderGone || tagGone) this.selection = { kind: 'all' }
    // Background tabs (and trail entries) of notes that are gone; the active tab keeps its note
    // until the user resolves the removal (conflict bar).
    const active = this.tabs.active?.path
    this.tabs.forget((path) => path !== active && !this.hasNote(path))
    this.#saveTabs()
    if (this.query.trim() !== '') void this.#search()
    this.changed()
  }

  /** SSE `vault` event: an external change. */
  onVaultChange(change: VaultChangeEvent): void {
    if (change.id === this.openId) {
      if (change.change === 'note-removed') this.session.externalRemoval()
      else void this.session.externalChange()
    }
    clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => void this.refresh().catch((error) => this.fail(error)), REFRESH_DELAY_MS)
  }

  setConnection(connection: Connection): void {
    const reconnected = connection === 'connected' && this.connection === 'disconnected'
    this.connection = connection
    // Events may have been missed while disconnected.
    if (reconnected && this.data.vault) void this.refresh().catch((error) => this.fail(error))
    this.changed()
  }

  #putSummary(note: NoteSummary): void {
    const summary: NoteSummary = {
      id: note.id,
      folder: note.folder,
      title: note.title,
      tags: note.tags,
      starred: note.starred,
      created: note.created,
      updated: note.updated,
      excerpt: note.excerpt,
    }
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

  /** Shows `dialog`, cancelling the one already open. */
  #showDialog(dialog: Dialog): void {
    this.closeMenu()
    const previous = this.dialog
    if (previous?.kind === 'confirm') previous.resolve(false)
    else previous?.resolve(null)
    this.dialog = dialog
    this.changed()
  }

  /** Wraps a dialog's resolver so answering it also closes it. */
  #closing<T>(resolve: (value: T) => void): (value: T) => void {
    return (value) => {
      this.dialog = null
      this.changed()
      resolve(value)
    }
  }

  setImportOpen(open: boolean): void {
    this.importOpen = open
    this.closeMenu()
    this.changed()
  }

  notify(kind: Notice['kind'], text: string): void {
    clearTimeout(this.#noticeTimer)
    this.notice = { kind, text }
    this.#noticeTimer = setTimeout(() => this.dismissNotice(), kind === 'error' ? 8000 : 3000)
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
