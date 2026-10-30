import { type Dirent, type FSWatcher, type Stats, watch } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import * as path from 'node:path'

import {
  type FolderConfig,
  readConfig,
  readTrashIndex,
  type TrashEntry,
  type TrashIndex,
  type VaultConfig,
  writeConfig,
  writeTrashIndex,
} from './config.ts'
import { isNodeError, VaultError } from './errors.ts'
import { copyFileAtomic, exists, writeFileAtomic } from './files.ts'
import { type Frontmatter, parseNoteText, serializeNoteText } from './frontmatter.ts'
import { type ImportFilesReport, type ImportOptions, planImport } from './import-files.ts'
import { type LinkMove, rebaseNoteLinks, rewriteMovedLinks } from './links.ts'
import { findH1, hashText, type Note, type NoteMeta, toNote } from './note.ts'
import {
  ASSETS_SUFFIX,
  assetFileName,
  encodeLinkPath,
  folderSegments,
  isHiddenName,
  joinId,
  noteFileName,
  noteFolder,
  noteSegments,
  noteStem,
  resolveInside,
  safeDecode,
  sanitizeFileName,
  slugify,
  TRASH_DIR,
  uniqueName,
} from './paths.ts'
import { NoteIndex } from './search.ts'

export type VaultEventType = 'note-changed' | 'note-added' | 'note-removed' | 'tree-changed'

/**
 * A change made outside this `Vault` instance (another app, git, a sync client). `id` is a note id
 * for note events and a folder id for `tree-changed`. The vault's own writes never produce events.
 */
export interface VaultEvent {
  type: VaultEventType
  id: string
}

export interface OpenVaultOptions {
  /** Watch the folder for external changes (default `false`). */
  watch?: boolean
  /** Quiet period before a burst of file-system events is processed (default 100 ms). */
  debounceMs?: number
}

export interface FolderNode {
  /** Folder id; `''` for the vault root. */
  id: string
  name: string
  color?: string
  folders: FolderNode[]
  notes: NoteMeta[]
}

export interface TrashItem extends TrashEntry {
  /** Note title (notes only). */
  title?: string
}

export interface WriteNoteInput {
  body: string
  /** Replaces the frontmatter; omit to keep the file's current frontmatter. */
  frontmatter?: Frontmatter
  /**
   * Hash the caller's copy was based on (`Note.hash`); `null` means the note must not exist. The
   * file is checked on entry and again just before it is replaced, and the write fails with
   * `CHANGED` if it differs. Omit to write unconditionally.
   */
  baseHash?: string | null
}

export interface CreateNoteOptions {
  /** Defaults to an empty body. */
  body?: string
  /** Extra frontmatter; `created`/`updated` are always set. */
  frontmatter?: Frontmatter
}

/** One file rename proposed by `planTitleRenames`: `from` → `to` in the same folder. */
export interface TitleRename {
  from: string
  to: string
  /** The title the new file name comes from (frontmatter `title`, else first H1). */
  title: string
}

export interface TitleRenameSkip {
  id: string
  reason: string
}

export interface TitleRenamePlan {
  renames: TitleRename[]
  /** Notes whose title would give a different file name but which are left alone. */
  skipped: TitleRenameSkip[]
}

export interface TitleRenameReport {
  renamed: TitleRename[]
  skipped: TitleRenameSkip[]
  /** Frontmatter `title` keys removed because they equal the new file name. */
  titlesRemoved: number
  /** Links (in any note) rewritten to follow a renamed note or its assets folder. */
  linksRewritten: number
  /** Notes whose links were rewritten. */
  notesUpdated: number
}

/** A note whose links to moved notes/folders are (or would be) rewritten. */
export interface LinkUpdate {
  id: string
  title: string
  /** Links in it that point at (or into) a moved note or folder. */
  links: number
}

/** Result of `planLinkUpdates` (what would change) and `applyLinkUpdates` (what changed). */
export interface LinkUpdateReport {
  /** Sorted by id. */
  notes: LinkUpdate[]
  /** Links in all `notes`. */
  total: number
}

interface KnownFile {
  hash: string
  mtimeMs: number
  size: number
}

/** Delay of the reconcile that follows starting the watcher (covers events lost during start-up). */
const WATCHER_SETTLE_MS = 1000

/** Opens the folder at `root` as a vault and indexes its notes. */
export async function openVault(root: string, options: OpenVaultOptions = {}): Promise<Vault> {
  let real: string
  try {
    real = await realpath(root)
    if (!(await stat(real)).isDirectory()) throw new VaultError('NOT_A_VAULT', `Not a directory: ${root}`)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw new VaultError('NOT_A_VAULT', `Vault folder does not exist: ${root}`)
    throw error
  }
  const vault = new Vault(real, await readConfig(real))
  await vault.refresh()
  if (options.watch) vault.startWatching(options.debounceMs ?? 100)
  return vault
}

/**
 * A folder of markdown notes. Every method that touches the disk validates its ids (no `..`, no
 * hidden or `*.assets` segments, no symlink escapes) and mutations run one at a time.
 */
export class Vault {
  /** Real (symlink-resolved) absolute path of the vault folder. */
  readonly root: string
  /** In-memory index of all notes; kept current by the vault's own operations and the watcher. */
  readonly index = new NoteIndex()

  #config: VaultConfig
  readonly #files = new Map<string, KnownFile>()
  #folders = new Set<string>()
  readonly #listeners = new Set<(event: VaultEvent) => void>()
  #watcher: FSWatcher | undefined
  #timer: NodeJS.Timeout | undefined
  #settleTimer: NodeJS.Timeout | undefined
  #queue: Promise<unknown> = Promise.resolve()

  /** Use `openVault`. */
  constructor(root: string, config: VaultConfig) {
    this.root = root
    this.#config = config
  }

  get config(): VaultConfig {
    return structuredClone(this.#config)
  }

  /** All folder ids (excluding the root), sorted. */
  get folders(): string[] {
    return [...this.#folders].sort()
  }

  /** Receives external changes; returns an unsubscribe function. */
  subscribe(listener: (event: VaultEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Re-reads the folder now and emits events for anything that changed on disk. */
  refresh(): Promise<VaultEvent[]> {
    return this.#exclusive(() => this.#scan(true))
  }

  /**
   * Starts watching the folder (recursively); bursts of events are coalesced for `debounceMs`, then
   * the whole folder is reconciled. On macOS, FSEvents can miss changes made while its stream is
   * still starting, so one extra reconcile runs shortly after the watcher starts.
   */
  startWatching(debounceMs: number): void {
    if (this.#watcher) return
    const rescan = () => {
      this.refresh().catch((error: unknown) => console.warn('[vault] rescan failed', error))
    }
    this.#watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      // Dot-entries (.trash, .boostnote, our temp files) and assets never affect notes or folders.
      if (filename?.split(/[\\/]/).some(isHiddenName)) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(rescan, debounceMs)
    })
    this.#watcher.on('error', (error) => console.warn('[vault] watcher error', error))
    // Its own timer: events debounced meanwhile must not cancel it (they may be all that arrived).
    this.#settleTimer = setTimeout(rescan, Math.max(debounceMs, WATCHER_SETTLE_MS))
  }

  /** Stops watching and drops listeners. */
  async close(): Promise<void> {
    this.#watcher?.close()
    this.#watcher = undefined
    clearTimeout(this.#timer)
    clearTimeout(this.#settleTimer)
    this.#listeners.clear()
    await this.#queue
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────

  /** Folder tree with notes; folders follow `folderOrder`, then name. */
  tree(): FolderNode {
    const order = this.#config.folderOrder ?? []
    const children = new Map<string, string[]>()
    for (const id of this.#folders) {
      const parent = noteFolder(id)
      children.set(parent, [...(children.get(parent) ?? []), id])
    }
    const notes = new Map<string, NoteMeta[]>()
    for (const meta of this.index.all()) notes.set(meta.folder, [...(notes.get(meta.folder) ?? []), meta])
    const rank = (id: string) => {
      const index = order.indexOf(id)
      return index === -1 ? Number.POSITIVE_INFINITY : index
    }
    const build = (id: string): FolderNode => {
      const color = this.#config.folders[id]?.color
      const sorted = (children.get(id) ?? []).sort(
        (a, b) => rank(a) - rank(b) || path.posix.basename(a).localeCompare(path.posix.basename(b)),
      )
      return {
        id,
        name: id === '' ? path.basename(this.root) : path.posix.basename(id),
        ...(color ? { color } : {}),
        folders: sorted.map(build),
        notes: notes.get(id) ?? [],
      }
    }
    return build('')
  }

  async readNote(id: string): Promise<Note> {
    const file = await resolveInside(this.root, noteSegments(id))
    try {
      const raw = await readFile(file, 'utf8')
      return toNote(id, raw, parseNoteText(raw), await stat(file))
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'EISDIR')) {
        throw new VaultError('NOT_FOUND', `Note not found: ${id}`)
      }
      throw error
    }
  }

  // ── Notes ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Writes a note (creating it if needed). `updated` is set to now, `created` is kept or set on the
   * first write; the existing YAML text is edited in place so untouched keys keep their bytes.
   */
  writeNote(id: string, input: WriteNoteInput): Promise<Note> {
    return this.#exclusive(async () => {
      const file = await resolveInside(this.root, noteSegments(id))
      const assertBase = (raw: string | undefined) => {
        if (input.baseHash === undefined) return
        const hash = raw === undefined ? null : hashText(raw)
        if (hash !== input.baseHash) throw new VaultError('CHANGED', `Note changed on disk: ${id}`)
      }
      const previousRaw = await readOptional(file)
      assertBase(previousRaw)
      const previous = previousRaw === undefined ? undefined : parseNoteText(previousRaw)
      const frontmatter = { ...(input.frontmatter ?? previous?.frontmatter ?? {}) }
      const now = new Date().toISOString()
      if (frontmatter.created === undefined) {
        frontmatter.created =
          previous?.frontmatter.created ?? (previous ? (await stat(file)).birthtime.toISOString() : now)
      }
      frontmatter.updated = now
      const raw = serializeNoteText(frontmatter, input.body, previous)
      // An outside program may write between the read above and the rename; check again last.
      await writeFileAtomic(file, raw, async () => assertBase(await readOptional(file)))
      return this.#track(id, file, raw)
    })
  }

  /** Creates `<folder>/<noteFileName(title)>.md` (suffixed ` 2`, ` 3`… when taken, ignoring case). */
  createNote(folder: string, title = 'Untitled', options: CreateNoteOptions = {}): Promise<Note> {
    return this.#exclusive(async () => {
      const dir = await this.#existingFolder(folder)
      const stem = await uniqueStem(dir, noteFileName(title))
      const id = joinId(folder, `${stem}.md`)
      const now = new Date().toISOString()
      const frontmatter = { ...options.frontmatter, created: now, updated: now }
      const raw = serializeNoteText(frontmatter, options.body ?? '')
      const file = path.join(dir, `${stem}.md`)
      await writeFileAtomic(file, raw)
      return this.#track(id, file, raw)
    })
  }

  /** Renames the file — the note's name — to `<name>.md`; its assets folder follows and links are rewritten. */
  renameNote(id: string, name: string): Promise<Note> {
    return this.#exclusive(async () => {
      const stem = sanitizeFileName(name.replace(/\.md$/i, ''))
      if (stem === '') throw new VaultError('INVALID_PATH', `Invalid note name: ${JSON.stringify(name)}`)
      const toId = joinId(noteFolder(id), `${stem}.md`)
      return this.#relocateNote(id, toId)
    })
  }

  /**
   * Dry run of `applyTitleRenames`: finds notes whose file name is still the slug the importer gave
   * them before file names became note names (`slugify(title)`, maybe with a `-2` suffix), where
   * `title` is the frontmatter `title`, else the first H1. Each gets `noteFileName(title)`, made
   * unique (ignoring case) in its folder. Files named some other way (by the user) are skipped.
   * Nothing is written.
   */
  planTitleRenames(): Promise<TitleRenamePlan> {
    return this.#exclusive(async () => {
      const plan: TitleRenamePlan = { renames: [], skipped: [] }
      const taken = new Map<string, Set<string>>()
      // `x.md` before `x-2.md` before `x-10.md`, so the importer's original keeps the plain name.
      const order = (id: string) => id.replace(/-(\d+)\.md$/, (_match, n: string) => `\uffff${n.padStart(9, '0')}`)
      const ids = this.index
        .all()
        .map((meta) => meta.id)
        .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
      for (const id of ids) {
        const note = await this.readNote(id)
        const stem = noteStem(id)
        const frontmatterTitle = typeof note.frontmatter.title === 'string' ? note.frontmatter.title.trim() : ''
        const title = frontmatterTitle || findH1(note.body) || stem
        const target = noteFileName(title)
        if (target === stem) continue
        const slug = slugify(title)
        if (stem !== slug && !(stem.startsWith(`${slug}-`) && /^\d+$/.test(stem.slice(slug.length + 1)))) {
          plan.skipped.push({ id, reason: `file name was not made from the title “${title}”` })
          continue
        }
        const names =
          taken.get(note.folder) ??
          (await lowerCaseEntries(await resolveInside(this.root, folderSegments(note.folder))))
        taken.set(note.folder, names)
        // The note's own names are free (a case-only rename), the others' and earlier picks are not.
        const own = stem.toLowerCase()
        const toStem = uniqueName(target, (candidate) => {
          const lower = candidate.toLowerCase()
          return lower !== own && (names.has(`${lower}.md`) || names.has(`${lower}${ASSETS_SUFFIX}`))
        })
        names.add(`${toStem.toLowerCase()}.md`)
        names.add(`${toStem.toLowerCase()}${ASSETS_SUFFIX}`)
        plan.renames.push({ from: id, to: joinId(note.folder, `${toStem}.md`), title })
      }
      return plan
    })
  }

  /**
   * Applies (a possibly user-trimmed) `planTitleRenames` result: renames each file in place (its
   * assets folder and own links follow, as with `renameNote`), drops a frontmatter `title` that now
   * equals the file name, then rewrites the relative links of every note that pointed at a renamed
   * note or into its assets folder. Renames that no longer apply are skipped with the reason.
   */
  applyTitleRenames(plan: Pick<TitleRenamePlan, 'renames'>): Promise<TitleRenameReport> {
    return this.#exclusive(async () => {
      const report: TitleRenameReport = {
        renamed: [],
        skipped: [],
        titlesRemoved: 0,
        linksRewritten: 0,
        notesUpdated: 0,
      }
      const moved = new Map<string, string>()
      // An unexpected error stops further renames, but links to the files already renamed are
      // still rewritten below before it is rethrown, so the vault is never left with dangling links.
      let fatal: { error: unknown } | undefined
      for (const rename of plan.renames) {
        try {
          noteSegments(rename.from)
          noteSegments(rename.to)
          if (noteFolder(rename.from) !== noteFolder(rename.to)) {
            throw new VaultError('INVALID_PATH', `Not in the same folder: ${rename.from} → ${rename.to}`)
          }
          if (sanitizeFileName(noteStem(rename.to)) !== noteStem(rename.to)) {
            throw new VaultError('INVALID_PATH', `Invalid note name: ${JSON.stringify(noteStem(rename.to))}`)
          }
          const note = await this.#relocateNote(rename.from, rename.to)
          moved.set(rename.from, rename.to)
          report.renamed.push(rename)
          const { title: _title, ...rest } = note.frontmatter
          if (note.frontmatter.title === noteStem(rename.to)) {
            const text = parseNoteText(note.raw)
            const raw = serializeNoteText(rest, text.body, text)
            const file = await resolveInside(this.root, noteSegments(rename.to))
            await writeFileAtomic(file, raw)
            await this.#track(rename.to, file, raw)
            report.titlesRemoved++
          }
        } catch (error) {
          if (!(error instanceof VaultError)) {
            fatal = { error }
            break
          }
          report.skipped.push({ id: rename.from, reason: error.message })
        }
      }
      if (moved.size === 0) {
        if (fatal) throw fatal.error
        return report
      }
      const links = await this.#rewriteIncomingLinks(
        [...moved].map(([from, to]): LinkMove => ({ from, to, kind: 'note' })),
        true,
      )
      report.linksRewritten = links.total
      report.notesUpdated = links.notes.length
      if (fatal) throw fatal.error
      return report
    })
  }

  /**
   * Dry run of `applyLinkUpdates`: the notes with relative links that still point at the old
   * place of a note or folder the app just renamed/moved (`moves`, ids before → after), with the
   * number of such links in each. Nothing is written.
   */
  planLinkUpdates(moves: readonly LinkMove[]): Promise<LinkUpdateReport> {
    return this.#exclusive(() => this.#rewriteIncomingLinks(checkMoves(moves), false))
  }

  /**
   * Rewrites the links `planLinkUpdates` finds to point at the new places (`#fragment`/`?query`
   * and a leading `./` are kept; links in code are not touched). Returns what was written.
   */
  applyLinkUpdates(moves: readonly LinkMove[]): Promise<LinkUpdateReport> {
    return this.#exclusive(() => this.#rewriteIncomingLinks(checkMoves(moves), true))
  }

  /** Moves a note into `folder`, keeping its file name unless taken (then ` 2`, …). */
  moveNote(id: string, folder: string): Promise<Note> {
    return this.#exclusive(async () => {
      if (noteFolder(id) === folder) return this.readNote(id)
      const dir = await this.#existingFolder(folder)
      const toId = joinId(folder, `${await uniqueStem(dir, noteStem(id))}.md`)
      return this.#relocateNote(id, toId)
    })
  }

  /** Moves a note and its assets into `.trash/`. */
  deleteNote(id: string): Promise<TrashEntry> {
    return this.#exclusive(async () => {
      const file = await resolveInside(this.root, noteSegments(id))
      if (!(await isFile(file))) throw new VaultError('NOT_FOUND', `Note not found: ${id}`)
      const trashDir = await resolveInside(this.root, [TRASH_DIR, ...folderSegments(noteFolder(id))])
      await mkdir(trashDir, { recursive: true })
      const trashStem = await uniqueStem(trashDir, noteStem(id))
      const trashId = joinId(noteFolder(id), `${trashStem}.md`)
      await rename(file, path.join(trashDir, `${trashStem}.md`))
      await renameIfExists(assetsDirOf(file), path.join(trashDir, `${trashStem}${ASSETS_SUFFIX}`))
      this.#untrack(id)
      return this.#addTrashEntry(trashId, { kind: 'note', originalPath: id, deletedAt: new Date().toISOString() })
    })
  }

  // ── Trash ──────────────────────────────────────────────────────────────────────────────────

  /** Trash contents, most recently deleted first. */
  async listTrash(): Promise<TrashItem[]> {
    const index = await readTrashIndex(this.root)
    const items: TrashItem[] = []
    for (const [id, entry] of Object.entries(index.entries)) {
      const file = await this.#trashPath(id, entry.kind).catch(() => undefined)
      if (!file || !(await exists(file))) continue
      const item: TrashItem = { id, ...entry }
      if (entry.kind === 'note') {
        const raw = await readFile(file, 'utf8')
        item.title = toNote(entry.originalPath, raw, parseNoteText(raw), await stat(file)).title
      }
      items.push(item)
    }
    return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  /**
   * Puts a trashed note or folder back at its original path (recreating missing parent folders,
   * suffixing the name when the original is taken). Returns the restored note/folder id.
   */
  restore(trashId: string): Promise<string> {
    return this.#exclusive(async () => {
      const index = await readTrashIndex(this.root)
      const entry = index.entries[trashId]
      if (!entry) throw new VaultError('NOT_FOUND', `Not in trash: ${trashId}`)
      const source = await this.#trashPath(trashId, entry.kind)
      if (!(await exists(source))) throw new VaultError('NOT_FOUND', `Not in trash: ${trashId}`)
      const parent = noteFolder(entry.originalPath)
      const parentDir = await resolveInside(this.root, folderSegments(parent))
      await mkdir(parentDir, { recursive: true })
      let restoredId: string
      if (entry.kind === 'note') {
        noteSegments(entry.originalPath)
        restoredId = joinId(parent, `${await uniqueStem(parentDir, noteStem(entry.originalPath))}.md`)
        const target = path.join(this.root, ...restoredId.split('/'))
        await rename(source, target)
        await renameIfExists(assetsDirOf(source), assetsDirOf(target))
        const raw = await readFile(target, 'utf8')
        const text = parseNoteText(raw)
        const body = rebaseNoteLinks(text.body, entry.originalPath, restoredId)
        const next = body === text.body ? raw : raw.slice(0, raw.length - text.body.length) + body
        if (next !== raw) await writeFileAtomic(target, next)
        this.#addAncestors(restoredId)
        await this.#track(restoredId, target, next)
      } else {
        const names = await lowerCaseEntries(parentDir)
        const name = uniqueName(path.posix.basename(entry.originalPath), (c) => names.has(c.toLowerCase()), ' ')
        restoredId = joinId(parent, name)
        folderSegments(restoredId)
        await rename(source, path.join(parentDir, name))
        for (const [rel, folder] of Object.entries(entry.folders ?? {})) {
          this.#config.folders[rel === '' ? restoredId : `${restoredId}/${rel}`] = folder
        }
        await writeConfig(this.root, this.#config)
        await this.#scan(false)
      }
      delete index.entries[trashId]
      await writeTrashIndex(this.root, index)
      return restoredId
    })
  }

  /** Permanently deletes everything in the trash. */
  emptyTrash(): Promise<void> {
    return this.#exclusive(async () => {
      await rm(path.join(this.root, TRASH_DIR), { recursive: true, force: true })
    })
  }

  // ── Folders ────────────────────────────────────────────────────────────────────────────────

  /** Creates `<parent>/<name>` and returns its id. */
  createFolder(parent: string, name: string): Promise<string> {
    return this.#exclusive(async () => {
      const parentDir = await this.#existingFolder(parent)
      const id = joinId(parent, this.#folderName(name))
      folderSegments(id)
      try {
        await mkdir(path.join(parentDir, path.posix.basename(id)))
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) throw new VaultError('EXISTS', `Already exists: ${id}`)
        throw error
      }
      this.#folders.add(id)
      return id
    })
  }

  /** Renames a folder in place; returns the new id. Colours and order follow the folder. */
  renameFolder(id: string, name: string): Promise<string> {
    return this.#exclusive(() => this.#relocateFolder(id, joinId(noteFolder(id), this.#folderName(name))))
  }

  /** Moves a folder under `parent`; returns the new id. */
  moveFolder(id: string, parent: string): Promise<string> {
    return this.#exclusive(() => {
      if (parent === id || parent.startsWith(`${id}/`)) {
        throw new VaultError('INVALID_PATH', `Cannot move ${id} into itself`)
      }
      return this.#relocateFolder(id, joinId(parent, path.posix.basename(id)))
    })
  }

  /** Moves a folder (with its notes and subfolders) into `.trash/`. */
  deleteFolder(id: string): Promise<TrashEntry> {
    return this.#exclusive(async () => {
      if (id === '') throw new VaultError('INVALID_PATH', 'Cannot delete the vault root')
      const dir = await this.#existingFolder(id)
      const trashParent = await resolveInside(this.root, [TRASH_DIR, ...folderSegments(noteFolder(id))])
      await mkdir(trashParent, { recursive: true })
      const names = await lowerCaseEntries(trashParent)
      const name = uniqueName(path.posix.basename(id), (c) => names.has(c.toLowerCase()), ' ')
      await rename(dir, path.join(trashParent, name))
      const folders: Record<string, FolderConfig> = {}
      for (const [key, folder] of Object.entries(this.#config.folders)) {
        if (key === id || key.startsWith(`${id}/`)) {
          folders[key.slice(id.length + 1)] = folder
          delete this.#config.folders[key]
        }
      }
      this.#config.folderOrder = this.#config.folderOrder?.filter((key) => key !== id && !key.startsWith(`${id}/`))
      await writeConfig(this.root, this.#config)
      await this.#scan(false)
      return this.#addTrashEntry(joinId(noteFolder(id), name), {
        kind: 'folder',
        originalPath: id,
        deletedAt: new Date().toISOString(),
        ...(Object.keys(folders).length > 0 ? { folders } : {}),
      })
    })
  }

  /** Sets (or with `undefined`, clears) a folder's colour. */
  setFolderColor(id: string, color: string | undefined): Promise<void> {
    return this.#exclusive(async () => {
      await this.#existingFolder(id)
      const { color: _previous, ...rest } = this.#config.folders[id] ?? {}
      const next: FolderConfig = color === undefined ? rest : { ...rest, color }
      if (Object.keys(next).length === 0) delete this.#config.folders[id]
      else this.#config.folders[id] = next
      await writeConfig(this.root, this.#config)
    })
  }

  /** Replaces the folder display order (folder ids). */
  setFolderOrder(order: string[]): Promise<void> {
    return this.#exclusive(async () => {
      for (const id of order) folderSegments(id)
      this.#config.folderOrder = [...new Set(order)]
      await writeConfig(this.root, this.#config)
    })
  }

  // ── Assets ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Stores `bytes` as `<stem>.assets/<sha256-12>.<ext>` next to the note (identical content is
   * stored once) and returns the link to insert, relative to the note: `./<stem>.assets/<file>`.
   */
  saveAsset(noteId: string, bytes: Uint8Array, ext: string): Promise<string> {
    return this.#exclusive(async () => {
      const file = await resolveInside(this.root, noteSegments(noteId))
      const name = assetFileName(bytes, ext)
      const target = path.join(assetsDirOf(file), name)
      await resolveInside(this.root, path.relative(this.root, target).split(path.sep))
      if (!(await exists(target))) await writeFileAtomic(target, bytes)
      return `./${encodeLinkPath(noteStem(noteId))}${ASSETS_SUFFIX}/${name}`
    })
  }

  /**
   * Copies Markdown files and folders from outside (or inside) the vault into `folder` — the
   * sources are only read. See `planImport` for names, links and what is skipped. Each note keeps
   * its bytes (bar rewritten links) and its modification time; no frontmatter is added. With
   * `options.read` every copied file is read through it and written from the bytes it returned.
   */
  importFiles(sources: readonly string[], folder: string, options: ImportOptions = {}): Promise<ImportFilesReport> {
    return this.#exclusive(async () => {
      const dir = await this.#existingFolder(folder)
      const plan = await planImport({ sources, folder, dir, ...options })
      for (const note of plan.notes) {
        const file = await resolveInside(this.root, noteSegments(note.id))
        for (const asset of note.assets) {
          const target = path.join(assetsDirOf(file), asset.name)
          await resolveInside(this.root, path.relative(this.root, target).split(path.sep))
          if (await exists(target)) continue
          if (asset.data) await writeFileAtomic(target, asset.data)
          else await copyFileAtomic(asset.source, target)
        }
        await writeFileAtomic(file, note.data)
        await utimes(file, note.atime, note.mtime)
        await this.#track(note.id, file, note.text)
      }
      return plan.report
    })
  }

  /**
   * Absolute path of a file a note links to (`./todo.assets/abc.png`, `../img/x.png`). Rejects
   * links that leave the vault (also through symlinks) or point into dot-directories.
   */
  async assetPath(noteId: string, href: string): Promise<string> {
    noteSegments(noteId)
    const pathPart = safeDecode(href.replace(/[?#].*$/, ''))
    if (pathPart === '' || pathPart.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(pathPart)) {
      throw new VaultError('INVALID_PATH', `Not a relative link: ${href}`)
    }
    const target = path.posix.normalize(path.posix.join(noteFolder(noteId), pathPart.replace(/\\/g, '/')))
    const segments = target.split('/')
    if (target === '.' || segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
      throw new VaultError('INVALID_PATH', `Link leaves the vault: ${href}`)
    }
    return resolveInside(this.root, segments)
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  /** Runs `task` after every previously queued mutation/scan has settled. */
  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  #emit(events: VaultEvent[]): void {
    for (const event of events) for (const listener of this.#listeners) listener(event)
  }

  #folderName(name: string): string {
    const folder = sanitizeFileName(name)
    if (folder === '') throw new VaultError('INVALID_PATH', `Invalid folder name: ${JSON.stringify(name)}`)
    return folder
  }

  async #existingFolder(folder: string): Promise<string> {
    const dir = await resolveInside(this.root, folderSegments(folder))
    try {
      if ((await stat(dir)).isDirectory()) return dir
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) throw error
    }
    throw new VaultError('NOT_FOUND', `Folder not found: ${folder === '' ? '(root)' : folder}`)
  }

  async #trashPath(trashId: string, kind: TrashEntry['kind']): Promise<string> {
    return resolveInside(this.root, [TRASH_DIR, ...(kind === 'note' ? noteSegments(trashId) : folderSegments(trashId))])
  }

  async #addTrashEntry(id: string, entry: Omit<TrashEntry, 'id'>): Promise<TrashEntry> {
    const index: TrashIndex = await readTrashIndex(this.root)
    index.entries[id] = entry
    await writeTrashIndex(this.root, index)
    return { id, ...entry }
  }

  /** Records a file the vault itself just wrote so the watcher recognises it, and indexes it. */
  async #track(id: string, file: string, raw: string): Promise<Note> {
    const stats = await stat(file)
    this.#files.set(id, { hash: hashText(raw), mtimeMs: stats.mtimeMs, size: stats.size })
    this.#addAncestors(id)
    const note = toNote(id, raw, parseNoteText(raw), stats)
    this.index.put(note)
    return note
  }

  #untrack(id: string): void {
    this.#files.delete(id)
    this.index.delete(id)
  }

  #addAncestors(id: string): void {
    for (let folder = noteFolder(id); folder !== ''; folder = noteFolder(folder)) this.#folders.add(folder)
  }

  async #relocateNote(fromId: string, toId: string): Promise<Note> {
    const from = await resolveInside(this.root, noteSegments(fromId))
    const to = await resolveInside(this.root, noteSegments(toId))
    const raw = await readOptional(from)
    if (raw === undefined) throw new VaultError('NOT_FOUND', `Note not found: ${fromId}`)
    if (fromId === toId) return this.#track(fromId, from, raw)
    if (!(await sameOrMissing(from, to)) || !(await sameOrMissing(assetsDirOf(from), assetsDirOf(to)))) {
      throw new VaultError('EXISTS', `Already exists: ${toId}`)
    }
    // Rename first (also handles case-only renames on case-insensitive file systems), then fix links.
    await rename(from, to)
    await renameIfExists(assetsDirOf(from), assetsDirOf(to))
    const text = parseNoteText(raw)
    const body = rebaseNoteLinks(text.body, fromId, toId)
    const next = body === text.body ? raw : raw.slice(0, raw.length - text.body.length) + body
    if (next !== raw) await writeFileAtomic(to, next)
    this.#untrack(fromId)
    return this.#track(toId, to, next)
  }

  /**
   * Moves a folder; the relative links of the notes in it are re-based on their new place (links
   * between notes inside the folder, and into their assets, follow the move).
   */
  async #relocateFolder(id: string, toId: string): Promise<string> {
    if (id === '') throw new VaultError('INVALID_PATH', 'Cannot move the vault root')
    const from = await this.#existingFolder(id)
    const to = await resolveInside(this.root, folderSegments(toId))
    if (id === toId) return id
    await this.#existingFolder(noteFolder(toId))
    if (!(await sameOrMissing(from, to))) throw new VaultError('EXISTS', `Already exists: ${toId}`)
    const inside = this.index
      .all()
      .map((meta) => meta.id)
      .filter((noteId) => noteId.startsWith(`${id}/`))
    await rename(from, to)
    const moves: LinkMove[] = [{ from: id, to: toId, kind: 'folder' }]
    for (const fromId of inside) {
      const noteId = toId + fromId.slice(id.length)
      const file = await resolveInside(this.root, noteSegments(noteId))
      const raw = await readOptional(file)
      if (raw === undefined) continue
      const text = parseNoteText(raw)
      const body = rebaseNoteLinks(text.body, fromId, noteId, moves)
      if (body !== text.body) await writeFileAtomic(file, raw.slice(0, raw.length - text.body.length) + body)
    }
    const moveKey = (key: string) => (key === id || key.startsWith(`${id}/`) ? toId + key.slice(id.length) : key)
    this.#config.folders = Object.fromEntries(
      Object.entries(this.#config.folders).map(([key, folder]) => [moveKey(key), folder]),
    )
    if (this.#config.folderOrder) this.#config.folderOrder = this.#config.folderOrder.map(moveKey)
    await writeConfig(this.root, this.#config)
    await this.#scan(false)
    return toId
  }

  /**
   * The incoming-link pass shared by `applyTitleRenames` and `plan`/`applyLinkUpdates`: finds (and
   * with `write`, rewrites) relative links in every note that point at the old place of a moved
   * note, its assets or a moved folder's contents. A moved note's own move is skipped for its own
   * links — moving it already re-based them. Trashed notes are not in the index, so not touched.
   */
  async #rewriteIncomingLinks(moves: readonly LinkMove[], write: boolean): Promise<LinkUpdateReport> {
    const report: LinkUpdateReport = { notes: [], total: 0 }
    if (moves.length === 0) return report
    for (const meta of this.index.all()) {
      const applicable = moves.filter((move) =>
        move.kind === 'note' ? move.to !== meta.id : !meta.id.startsWith(`${move.to}/`),
      )
      if (applicable.length === 0) continue
      const file = await resolveInside(this.root, noteSegments(meta.id))
      const raw = await readOptional(file)
      if (raw === undefined) continue
      const text = parseNoteText(raw)
      const { body, links } = rewriteMovedLinks(text.body, meta.folder, applicable)
      if (links === 0 || body === text.body) continue
      if (write) {
        const next = raw.slice(0, raw.length - text.body.length) + body
        await writeFileAtomic(file, next)
        await this.#track(meta.id, file, next)
      }
      report.notes.push({ id: meta.id, title: meta.title, links })
      report.total += links
    }
    return report
  }

  /**
   * Walks the vault and reconciles the index with the disk. Files whose size and mtime match what
   * the vault last saw are skipped; others are re-read and compared by content hash, which is what
   * keeps the vault's own writes from being reported as external changes.
   */
  async #scan(emit: boolean): Promise<VaultEvent[]> {
    const found = new Map<string, string>()
    const folders = new Set<string>()
    const walk = async (dir: string, folder: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return
        throw error
      }
      for (const entry of entries) {
        if (isHiddenName(entry.name) || entry.name.includes('\\')) continue
        const id = joinId(folder, entry.name)
        if (entry.isDirectory()) {
          folders.add(id)
          await walk(path.join(dir, entry.name), id)
        } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.length > 3) {
          found.set(id, path.join(dir, entry.name))
        }
      }
    }
    await walk(this.root, '')

    const events: VaultEvent[] = []
    for (const [id, file] of found) {
      let stats: Stats
      let raw: string
      try {
        stats = await stat(file)
        const known = this.#files.get(id)
        if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) continue
        raw = await readFile(file, 'utf8')
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          found.delete(id)
          continue
        }
        throw error
      }
      const hash = hashText(raw)
      const known = this.#files.get(id)
      this.#files.set(id, { hash, mtimeMs: stats.mtimeMs, size: stats.size })
      if (known?.hash === hash) continue
      this.index.put(toNote(id, raw, parseNoteText(raw), stats))
      events.push({ type: known ? 'note-changed' : 'note-added', id })
    }
    for (const id of [...this.#files.keys()]) {
      if (found.has(id)) continue
      this.#untrack(id)
      events.push({ type: 'note-removed', id })
    }
    for (const id of folders) if (!this.#folders.has(id)) events.push({ type: 'tree-changed', id })
    for (const id of this.#folders) if (!folders.has(id)) events.push({ type: 'tree-changed', id })
    this.#folders = folders
    if (emit) this.#emit(events)
    return events
  }
}

function assetsDirOf(noteFile: string): string {
  return noteFile.replace(/\.md$/, ASSETS_SUFFIX)
}

/** Validates link-update moves (note or non-root folder ids) and drops the no-op ones. */
function checkMoves(moves: readonly LinkMove[]): LinkMove[] {
  for (const move of moves) {
    if (move.kind === 'note') {
      noteSegments(move.from)
      noteSegments(move.to)
    } else {
      if (move.from === '' || move.to === '') throw new VaultError('INVALID_PATH', 'Cannot move the vault root')
      folderSegments(move.from)
      folderSegments(move.to)
    }
  }
  return moves.filter((move) => move.from !== move.to)
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

/** True when `to` does not exist or is the same directory entry as `from` (case-only rename). */
async function sameOrMissing(from: string, to: string): Promise<boolean> {
  if (!(await exists(to))) return true
  if (!(await exists(from))) return false
  const [a, b] = await Promise.all([lstat(from), lstat(to)])
  return a.ino === b.ino && a.dev === b.dev
}

async function lowerCaseEntries(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).map((name) => name.toLowerCase()))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set()
    throw error
  }
}

/** First free stem in `dir` (checked case-insensitively against both `<stem>.md` and `<stem>.assets`). */
async function uniqueStem(dir: string, base: string): Promise<string> {
  const names = await lowerCaseEntries(dir)
  return uniqueName(base, (candidate) => {
    const lower = candidate.toLowerCase()
    return names.has(`${lower}.md`) || names.has(`${lower}${ASSETS_SUFFIX}`)
  })
}
