import { TypedEventTarget } from 'remix/component'

import { client } from './api.ts'
import { NoteSession } from './note-session.ts'
import { folderChain, parentOf } from './paths.ts'
import type { FolderSummary, NoteSummary, VaultChangeEvent, WorkspaceData } from './types.ts'

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

/**
 * State and operations of the workspace: the vault's lists (from `GET /api/workspace`), the sidebar
 * selection, sorting and search, menus and dialogs, and the open note (`session`). Components render
 * it and call its methods; it emits `change` whenever something visible changed.
 */
export class WorkspaceModel extends TypedEventTarget<{ change: Event; 'focus-editor': FocusEditorEvent }> {
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
  importOpen = false
  notice: Notice | null = null
  connection: Connection = 'connecting'
  readonly session = new NoteSession()

  #searchTimer: ReturnType<typeof setTimeout> | undefined
  #searchAbort: AbortController | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #noticeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(initial: WorkspaceData) {
    super()
    this.data = initial
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

  // ── Notes ──────────────────────────────────────────────────────────────────────────────

  /** Opens a note in the editor after saving the current one; refuses while the current one has an unresolved conflict. */
  async openNote(id: string): Promise<void> {
    if (this.openId === id) return
    if (!(await this.leaveNote())) return
    try {
      this.session.open(await client.readNote(id))
    } catch (error) {
      this.fail(error)
    }
  }

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
    if (this.openId === id && !(await this.leaveNote())) return
    await this.attempt(async () => {
      const renamed = await client.renameNote(id, name.trim())
      if (this.openId === id) this.session.relocated(renamed)
      await this.refresh()
    })
  }

  async moveNote(id: string, folder: string): Promise<void> {
    if (parentOf(id) === folder) return
    if (this.openId === id && !(await this.leaveNote())) return
    await this.attempt(async () => {
      const moved = await client.moveNote(id, folder)
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

  /** Moves a note to the trash (its latest edits included). */
  async deleteNote(id: string): Promise<void> {
    const open = this.openId === id
    if (open) await this.session.flush()
    await this.attempt(async () => {
      await client.deleteNote(id)
      if (open) this.session.close()
      await this.refresh()
      this.notify('info', 'Moved to Trash')
    })
  }

  /** Actions of a note's context menu (note list and editor header). */
  noteMenu(id: string): MenuEntry[] {
    const reveal = /Mac/.test(navigator.platform) ? 'Reveal in Finder' : 'Show in Folder'
    return [
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

  async toggleStar(): Promise<void> {
    const note = this.session.note
    if (!note) return
    const { starred: _starred, ...rest } = note.frontmatter
    if (!(await this.session.setFrontmatter(note.starred ? rest : { ...note.frontmatter, starred: true }))) {
      this.notify('error', 'Could not update the note')
    }
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
      const openId = this.openId
      if (affectsOpen && openId) this.session.relocated(await client.readNote(rebase(openId)))
      await this.refresh()
    })
  }

  async deleteFolder(id: string): Promise<void> {
    const ok = await this.confirm({
      title: 'Delete folder',
      message: `Move “${this.folderName(id)}” and everything in it to the Trash?`,
      confirm: 'Move to Trash',
      danger: true,
    })
    if (!ok) return
    const affectsOpen = this.openId?.startsWith(`${id}/`) ?? false
    if (affectsOpen) await this.session.flush()
    await this.attempt(async () => {
      await client.deleteFolder(id)
      if (affectsOpen) this.session.close()
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

  #switched(data: WorkspaceData): void {
    this.session.close()
    this.data = data
    this.selection = { kind: 'all' }
    this.expanded.clear()
    this.importOpen = false
    this.setQuery('')
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
