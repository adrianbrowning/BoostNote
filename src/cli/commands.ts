/**
 * The operations behind both the `boostnote` command line and its MCP server, over one open
 * `Vault`. Every write goes through the vault (atomic, traversal-safe); results are plain JSON
 * data so the CLI (`--json`) and the MCP tools return the same shapes.
 */
import * as path from 'node:path'

import { type TaskProgress, taskProgress } from '../app/actions/public/workspace/tasks.ts'
import {
  type FolderNode,
  type Frontmatter,
  type LinkMove,
  type LinkUpdateReport,
  type Note,
  type NoteMeta,
  type Vault,
  VaultError,
} from '../vault/index.ts'

export type CommandErrorCode = 'USAGE' | 'NOT_FOUND' | 'CONFLICT' | 'AMBIGUOUS' | 'INVALID' | 'EXISTS' | 'ERROR'

/** A failed operation; `code` decides the CLI exit code and is shown to MCP clients. */
export class CommandError extends Error {
  readonly code: CommandErrorCode
  /** Extra facts for the caller (the current hash on a conflict, the matches of an ambiguous name). */
  readonly details: Record<string, unknown> | undefined

  constructor(code: CommandErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.details = details
  }
}

/** CLI exit codes. */
export const EXIT_CODES = { ok: 0, error: 1, usage: 2, conflict: 3, notFound: 4 } as const

export function exitCodeOf(error: CommandError): number {
  if (error.code === 'USAGE') return EXIT_CODES.usage
  if (error.code === 'CONFLICT') return EXIT_CODES.conflict
  if (error.code === 'NOT_FOUND') return EXIT_CODES.notFound
  return EXIT_CODES.error
}

/** Turns vault errors into command errors; anything else (a bug, an I/O failure) is rethrown. */
export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error
  if (error instanceof VaultError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return new CommandError('NOT_FOUND', error.message)
      case 'CHANGED':
        return new CommandError('CONFLICT', error.message)
      case 'EXISTS':
        return new CommandError('EXISTS', error.message)
      default:
        return new CommandError('INVALID', error.message)
    }
  }
  throw error
}

// ── Result shapes ────────────────────────────────────────────────────────────────────────────

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A note as `read` returns it. `hash` is what `write`/`append`/`set-props` take as `baseHash`. */
export interface NoteDocument extends NoteMeta {
  frontmatter: Record<string, JsonValue>
  body: string
  hash: string
}

/** What a write returns: enough to chain the next write (`hash`). */
export interface WriteResult {
  id: string
  title: string
  hash: string
}

export interface SearchResult {
  id: string
  title: string
  excerpt: string
  score: number
}

export interface RelocateResult extends WriteResult {
  previousId: string
  /** Links in other notes rewritten to follow the note (0 with `updateLinks: false`). */
  linksUpdated: number
  notesUpdated: number
  /** With `updateLinks: false`: links left pointing at the old place. */
  linksNotUpdated?: number
}

export interface TrashResult {
  /** Pass to `restore`. */
  trashId: string
  originalPath: string
  deletedAt: string
}

export interface TagCount {
  tag: string
  count: number
}

export interface RestoreResult {
  /** Where the note or folder now is (its original place, suffixed when that is taken). */
  id: string
  kind: 'note' | 'folder'
}

export interface FolderTree {
  /** `''` for the vault root. */
  id: string
  name: string
  color?: string
  /** Notes directly in this folder. */
  notes: number
  folders: FolderTree[]
}

export interface TaskResult extends TaskProgress {
  id: string
  title: string
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

export const SORT_KEYS = ['updated', 'created', 'title', 'id'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export interface ListOptions {
  /** Folder id (`''` = root); notes directly inside it, or anywhere under it with `recursive`. */
  folder?: string
  recursive?: boolean
  tag?: string
  starred?: boolean
  /** `updated`/`created` newest first, `title`/`id` A→Z. Default `updated`. */
  sort?: SortKey
  limit?: number
}

export interface CreateOptions {
  /** File name (the note's name); default `Untitled`, suffixed when taken. */
  name?: string
  body?: string
  tags?: string[]
}

export interface PropertyChanges {
  /** Keys to set; `tags` must be a list of strings, `starred` a boolean, `title` a string. */
  set?: Record<string, unknown>
  remove?: string[]
}

export interface RelocateOptions {
  /** Rewrite links in other notes that point at the note (default `true`). */
  updateLinks?: boolean
}

// ── Ids ──────────────────────────────────────────────────────────────────────────────────────

/** `''`, `.` and `/` are the root; surrounding slashes and backslashes are dropped. */
export function normalizeFolder(folder: string): string {
  const id = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return id === '.' ? '' : id
}

/**
 * The note id `input` names: an exact id (with or without `.md`), else a bare name matching one
 * note's file name or title (exactly, then ignoring case). Several matches is an error listing them.
 */
export function resolveNoteId(vault: Vault, input: string): string {
  const id = input.replace(/\\/g, '/').replace(/^\/+/, '')
  if (id === '') throw new CommandError('USAGE', 'Missing note id')
  if (vault.index.has(id)) return id
  if (!id.endsWith('.md') && vault.index.has(`${id}.md`)) return `${id}.md`
  const name = id.replace(/\.md$/i, '')
  const named = vault.index
    .all()
    .map((meta) => ({ id: meta.id, stem: path.posix.basename(meta.id, '.md'), title: meta.title }))
  const exact = named.filter((note) => note.stem === name || note.title === name)
  const lower = name.toLowerCase()
  const matches =
    exact.length > 0
      ? exact
      : named.filter((note) => note.stem.toLowerCase() === lower || note.title.toLowerCase() === lower)
  const [first, ...rest] = matches
  if (!first) throw new CommandError('NOT_FOUND', `Note not found: ${input}`)
  if (rest.length > 0) {
    const ids = matches.map((meta) => meta.id)
    throw new CommandError('AMBIGUOUS', `"${input}" matches ${ids.length} notes: ${ids.join(', ')}`, { matches: ids })
  }
  return first.id
}

// ── Operations ───────────────────────────────────────────────────────────────────────────────

export function listNotes(vault: Vault, options: ListOptions = {}): NoteMeta[] {
  const folder = options.folder === undefined ? undefined : normalizeFolder(options.folder)
  if (folder !== undefined && folder !== '' && !vault.folders.includes(folder)) {
    throw new CommandError('NOT_FOUND', `Folder not found: ${folder}`)
  }
  const sort = options.sort ?? 'updated'
  const notes = vault.index.all().filter((meta) => {
    if (folder !== undefined) {
      const inside = options.recursive
        ? folder === '' || meta.folder === folder || meta.folder.startsWith(`${folder}/`)
        : meta.folder === folder
      if (!inside) return false
    }
    if (options.tag !== undefined && !meta.tags.includes(options.tag)) return false
    if (options.starred && !meta.starred) return false
    return true
  })
  notes.sort((a, b) =>
    sort === 'title'
      ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
      : sort === 'id'
        ? a.id.localeCompare(b.id)
        : b[sort].localeCompare(a[sort]),
  )
  return options.limit === undefined ? notes : notes.slice(0, positive(options.limit, 'limit'))
}

export function searchNotes(vault: Vault, query: string, limit = 20): SearchResult[] {
  if (query.trim() === '') throw new CommandError('USAGE', 'Missing search query')
  return vault.index
    .search(query, positive(limit, 'limit'))
    .map((hit) => ({ id: hit.id, title: hit.title, excerpt: hit.excerpt, score: hit.score }))
}

export async function readNote(vault: Vault, input: string): Promise<NoteDocument> {
  return toDocument(await vault.readNote(resolveNoteId(vault, input)))
}

/** The file exactly as stored (frontmatter included). */
export async function readRaw(vault: Vault, input: string): Promise<string> {
  return (await vault.readNote(resolveNoteId(vault, input))).raw
}

export async function createNote(vault: Vault, folder: string, options: CreateOptions = {}): Promise<WriteResult> {
  const tags = options.tags?.map((tag) => tag.trim()).filter(Boolean)
  const note = await vault.createNote(normalizeFolder(folder), options.name?.trim() || 'Untitled', {
    body: options.body ?? '',
    ...(tags && tags.length > 0 ? { frontmatter: { tags: [...new Set(tags)] } } : {}),
  })
  return written(note)
}

/** Replaces the body, keeping the frontmatter. With `baseHash`, fails with `CONFLICT` if the file changed since. */
export async function writeNote(vault: Vault, input: string, body: string, baseHash?: string): Promise<WriteResult> {
  const id = resolveNoteId(vault, input)
  return written(await conflictChecked(vault, id, () => vault.writeNote(id, { body, baseHash })))
}

/** Adds `text` at the end of the body, on a line of its own. */
export async function appendToNote(vault: Vault, input: string, text: string, baseHash?: string): Promise<WriteResult> {
  const id = resolveNoteId(vault, input)
  const note = await vault.readNote(id)
  if (baseHash !== undefined && note.hash !== baseHash) throw conflict(id, note.hash)
  const separator = note.body === '' || note.body.endsWith('\n') ? '' : '\n'
  const ending = text.endsWith('\n') ? '' : '\n'
  const body = `${note.body}${separator}${text}${ending}`
  return written(await conflictChecked(vault, id, () => vault.writeNote(id, { body, baseHash: note.hash })))
}

/** Sets/removes frontmatter keys; the YAML of keys not named is left byte for byte. */
export async function updateProperties(
  vault: Vault,
  input: string,
  changes: PropertyChanges,
  baseHash?: string,
): Promise<NoteDocument> {
  const set = changes.set ?? {}
  const remove = changes.remove ?? []
  if (Object.keys(set).length === 0 && remove.length === 0) throw new CommandError('USAGE', 'No properties to change')
  for (const key of remove) if (key in set) throw new CommandError('USAGE', `"${key}" is both set and removed`)
  checkProperties(set)
  const id = resolveNoteId(vault, input)
  const note = await vault.readNote(id)
  if (baseHash !== undefined && note.hash !== baseHash) throw conflict(id, note.hash)
  const frontmatter: Frontmatter = { ...note.frontmatter, ...set }
  for (const key of remove) delete frontmatter[key]
  return toDocument(
    await conflictChecked(vault, id, () => vault.writeNote(id, { body: note.body, frontmatter, baseHash: note.hash })),
  )
}

/** Renames the file (the note's name); other notes' links follow unless `updateLinks: false`. */
export async function renameNote(
  vault: Vault,
  input: string,
  name: string,
  options: RelocateOptions = {},
): Promise<RelocateResult> {
  if (name.trim() === '') throw new CommandError('USAGE', 'Missing new name')
  const id = resolveNoteId(vault, input)
  return relocated(vault, id, await vault.renameNote(id, name.trim()), options)
}

/** Moves the note into `folder` (an existing folder id); other notes' links follow unless `updateLinks: false`. */
export async function moveNote(
  vault: Vault,
  input: string,
  folder: string,
  options: RelocateOptions = {},
): Promise<RelocateResult> {
  const id = resolveNoteId(vault, input)
  return relocated(vault, id, await vault.moveNote(id, normalizeFolder(folder)), options)
}

/** Moves the note (and its assets) to the vault's `.trash/`; nothing is deleted. */
export async function trashNote(vault: Vault, input: string): Promise<TrashResult> {
  const entry = await vault.deleteNote(resolveNoteId(vault, input))
  return { trashId: entry.id, originalPath: entry.originalPath, deletedAt: entry.deletedAt }
}

/** Puts a trashed note (or a folder the app trashed) back; returns where it now is. */
export async function restoreFromTrash(vault: Vault, trashId: string): Promise<RestoreResult> {
  if (trashId.trim() === '') throw new CommandError('USAGE', 'Missing trash id')
  const id = await vault.restore(trashId.trim())
  return { id, kind: vault.index.has(id) ? 'note' : 'folder' }
}

export function listTags(vault: Vault): TagCount[] {
  return [...vault.index.tags()].map(([tag, ids]) => ({ tag, count: ids.length }))
}

export function folderTree(vault: Vault): FolderTree {
  const convert = (node: FolderNode): FolderTree => ({
    id: node.id,
    name: node.name,
    ...(node.color ? { color: node.color } : {}),
    notes: node.notes.length,
    folders: node.folders.map(convert),
  })
  return convert(vault.tree())
}

/** Task list progress of the note body (as the app's progress bar counts it). */
export async function noteTasks(vault: Vault, input: string): Promise<TaskResult> {
  const note = await vault.readNote(resolveNoteId(vault, input))
  return { id: note.id, title: note.title, ...taskProgress(note.body) }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function toDocument(note: Note): NoteDocument {
  const { raw: _raw, frontmatter, ...rest } = note
  return { ...rest, frontmatter: JSON.parse(JSON.stringify(frontmatter) ?? '{}') }
}

function written(note: Note): WriteResult {
  return { id: note.id, title: note.title, hash: note.hash }
}

function conflict(id: string, currentHash: string | null): CommandError {
  return new CommandError('CONFLICT', `Note changed since it was read: ${id}. Read it again and reapply the change.`, {
    id,
    currentHash,
  })
}

/** Runs a vault write; a `CHANGED` failure becomes a conflict carrying the hash now on disk. */
async function conflictChecked(vault: Vault, id: string, write: () => Promise<Note>): Promise<Note> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof VaultError && error.code === 'CHANGED')) throw error
    const current = await vault.readNote(id).catch(() => undefined)
    throw conflict(id, current?.hash ?? null)
  }
}

async function relocated(vault: Vault, fromId: string, note: Note, options: RelocateOptions): Promise<RelocateResult> {
  const result: RelocateResult = { ...written(note), previousId: fromId, linksUpdated: 0, notesUpdated: 0 }
  if (note.id === fromId) return result
  const moves: LinkMove[] = [{ from: fromId, to: note.id, kind: 'note' }]
  if (options.updateLinks === false) {
    result.linksNotUpdated = (await vault.planLinkUpdates(moves)).total
    return result
  }
  const report: LinkUpdateReport = await vault.applyLinkUpdates(moves)
  result.linksUpdated = report.total
  result.notesUpdated = report.notes.length
  return result
}

function checkProperties(set: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(set)) {
    if (key.trim() === '') throw new CommandError('USAGE', 'Property names must not be empty')
    if (value === undefined) throw new CommandError('USAGE', `Missing value for "${key}"`)
  }
  if ('tags' in set && !(Array.isArray(set.tags) && set.tags.every((tag) => typeof tag === 'string'))) {
    throw new CommandError('USAGE', '"tags" must be a list of strings')
  }
  if ('starred' in set && typeof set.starred !== 'boolean')
    throw new CommandError('USAGE', '"starred" must be true or false')
  if ('title' in set && typeof set.title !== 'string') throw new CommandError('USAGE', '"title" must be a string')
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new CommandError('USAGE', `"${name}" must be a positive whole number`)
  return value
}
