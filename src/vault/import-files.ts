import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'

import { isNodeError, VaultError } from './errors.ts'
import { parseNoteText } from './frontmatter.ts'
import { rewriteRelativeLinks } from './links.ts'
import {
  ASSETS_SUFFIX,
  assetFileName,
  folderSegments,
  isHiddenName,
  isInside,
  joinId,
  noteFileName,
  noteFolder,
  noteSegments,
  sanitizeFileName,
  uniqueName,
} from './paths.ts'

/** Caps on what one `importFiles` call copies (notes plus linked files). */
export interface ImportLimits {
  maxFiles: number
  maxBytes: number
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = { maxFiles: 2000, maxBytes: 512 * 1024 * 1024 }

/** A file an import copies, as `ImportOptions.read` read it. */
export interface ImportRead {
  data: Buffer
  atime: Date
  mtime: Date
}

export interface ImportOptions {
  limits?: Partial<ImportLimits>
  /**
   * Reads each file the import copies (a `note` or a linked `asset`) from its real path, instead of
   * reading it by path; `undefined` refuses that file and the whole import fails with
   * `VaultError('NOT_FOUND')`, naming its base name. The bytes it returns are the ones written, so
   * the file cannot change between the check and the copy (a reader tab's identity-checked reads).
   */
  read?: (real: string, kind: 'note' | 'asset') => Promise<ImportRead | undefined>
  /**
   * Why a linked file that would be copied is left alone instead, or `undefined` to copy it.
   * `link` is the link's path as written (decoded, relative to the note's folder, not normalized),
   * `real` the real path it resolves to. A refused link stays as it is and is listed in
   * `unresolved` with the reason; the import goes on. Without it every linked file is copied.
   */
  refuseAsset?: (link: string, real: string) => string | undefined
}

/** What `Vault.importFiles` did. Paths in `source` are absolute paths as given (or found in a dropped folder). */
export interface ImportFilesReport {
  /** Target folder id. */
  folder: string
  /** The new notes, in import order. */
  notes: Array<{ source: string; id: string }>
  /** Linked files copied into the notes' `.assets` folders. */
  assets: number
  /** Links rewritten to the copied files or to other notes of the import. */
  links: number
  /** Dropped entries not imported (not Markdown, already in the folder, …). */
  skipped: Array<{ source: string; reason: string }>
  /** Links left as they were (web links, missing files, files outside what was dropped). */
  unresolved: Array<{ id: string; link: string; reason: string }>
}

interface PlannedAsset {
  source: string
  /** `<sha256-12>.<ext>` in the note's `.assets` folder. */
  name: string
  /** The bytes to write when `ImportOptions.read` read them; else the source is copied. */
  data?: Uint8Array
}

export interface PlannedNote {
  id: string
  /** Bytes to write: the source's, or its text with rewritten links. */
  data: Uint8Array
  /** `data` as UTF-8 text (what the index and watcher see). */
  text: string
  atime: Date
  mtime: Date
  assets: PlannedAsset[]
}

export interface ImportPlan {
  notes: PlannedNote[]
  report: ImportFilesReport
}

interface Source {
  /** As given / found (for the report). */
  path: string
  /** Real path. */
  real: string
  id: string
  /** Real path of what was dropped (the file's folder for a dropped file); links may not leave it. */
  root: string
}

const MARKDOWN = /\.(?:md|markdown)$/i

/**
 * Plans copying `sources` (absolute paths of `.md`/`.markdown` files and folders) into the vault
 * folder `folder` (real path `dir`). Nothing is written.
 *
 * - A file becomes `<noteFileName(stem)>.md`, unique (ignoring case) in the target folder.
 * - A folder becomes a new folder of the same name (unique) holding its Markdown files with their
 *   sub-folder structure; other files, dot-entries and symlinks in it are skipped.
 * - A source already directly in the target folder is skipped ("already in …"), as is a folder
 *   that contains the target.
 * - Relative links (outside code) to files under what was dropped are rewritten: to another note
 *   of the import → its new path; to any other existing file → a copy in `<stem>.assets/`
 *   (`<sha256-12>.<ext>`, like `saveAsset`). Other links stay as they are and are reported.
 */
export async function planImport(options: {
  sources: readonly string[]
  folder: string
  dir: string
  limits?: Partial<ImportLimits>
  read?: ImportOptions['read']
  refuseAsset?: ImportOptions['refuseAsset']
}): Promise<ImportPlan> {
  const { folder, dir } = options
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits }
  const readSource = async (real: string, kind: 'note' | 'asset'): Promise<ImportRead> => {
    if (!options.read) {
      const data = await readFile(real)
      const { atime, mtime } = await stat(real)
      return { data, atime, mtime }
    }
    const read = await options.read(real, kind)
    if (read === undefined) {
      throw new VaultError('NOT_FOUND', `${path.basename(real)} changed while it was imported; try again`)
    }
    return read
  }
  const report: ImportFilesReport = { folder, notes: [], assets: 0, links: 0, skipped: [], unresolved: [] }
  const where = folder === '' ? 'the vault root' : `“${folder}”`
  // Lower-cased names taken per folder id (existing entries and names picked by this import).
  const taken = new Map<string, Set<string>>()
  taken.set(folder, await lowerCaseEntries(dir))
  const takenIn = (id: string) => {
    let names = taken.get(id)
    if (!names) {
      names = new Set()
      taken.set(id, names)
    }
    return names
  }
  const pickNoteId = (parent: string, stem: string) => {
    const names = takenIn(parent)
    const picked = uniqueName(noteFileName(stem), (candidate) => {
      const lower = candidate.toLowerCase()
      return names.has(`${lower}.md`) || names.has(`${lower}${ASSETS_SUFFIX}`)
    })
    names.add(`${picked.toLowerCase()}.md`)
    names.add(`${picked.toLowerCase()}${ASSETS_SUFFIX}`)
    const id = joinId(parent, `${picked}.md`)
    noteSegments(id)
    return id
  }
  const pickFolderId = (parent: string, name: string) => {
    const names = takenIn(parent)
    const picked = uniqueName(sanitizeFileName(name) || 'Untitled', (candidate) => names.has(candidate.toLowerCase()))
    names.add(picked.toLowerCase())
    const id = joinId(parent, picked)
    folderSegments(id)
    return id
  }

  const notes: Source[] = []
  const seen = new Set<string>()
  /** Non-Markdown files met in dropped folders; reported unless a note links to them. */
  const others = new Map<string, string>()
  const tooMany = () => {
    if (notes.length > limits.maxFiles) {
      throw new VaultError('TOO_LARGE', `Too many files to import (more than ${limits.maxFiles})`)
    }
  }

  for (const source of options.sources) {
    let real: string
    try {
      real = await realpath(source)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) throw error
      report.skipped.push({ source, reason: 'not found' })
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    const stats = await stat(real)
    const parentDir = path.dirname(real)
    if (stats.isFile()) {
      if (!MARKDOWN.test(real) || path.basename(real).replace(MARKDOWN, '') === '') {
        report.skipped.push({ source, reason: 'not a Markdown file' })
      } else if (parentDir === dir) {
        report.skipped.push({ source, reason: `already in ${where}` })
      } else {
        notes.push({
          path: source,
          real,
          id: pickNoteId(folder, path.basename(real).replace(MARKDOWN, '')),
          root: parentDir,
        })
        tooMany()
      }
      continue
    }
    if (!stats.isDirectory()) {
      report.skipped.push({ source, reason: 'not a file or folder' })
      continue
    }
    if (isInside(real, dir)) {
      report.skipped.push({ source, reason: 'cannot import a folder into itself' })
      continue
    }
    if (parentDir === dir) {
      report.skipped.push({ source, reason: `already in ${where}` })
      continue
    }
    // Walk first, then name the new folders: folders without Markdown files are not created, and
    // a dropped folder without any is reported once rather than file by file.
    const found: Array<{ path: string; real: string; segments: string[] }> = []
    const skippedInside: ImportFilesReport['skipped'] = []
    const othersInside = new Map<string, string>()
    const walk = async (abs: string, display: string, segments: string[]): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch (error) {
        if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
          skippedInside.push({ source: display, reason: 'not readable' })
          return
        }
        throw error
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (isHiddenName(entry.name)) continue
        const child = path.join(abs, entry.name)
        const childDisplay = path.join(display, entry.name)
        if (entry.isDirectory()) await walk(child, childDisplay, [...segments, entry.name])
        else if (entry.isFile() && MARKDOWN.test(entry.name) && entry.name.replace(MARKDOWN, '') !== '') {
          found.push({ path: childDisplay, real: child, segments: [...segments, entry.name] })
          if (notes.length + found.length > limits.maxFiles) {
            throw new VaultError('TOO_LARGE', `Too many files to import (more than ${limits.maxFiles})`)
          }
        } else if (entry.isFile()) othersInside.set(child, childDisplay)
        else
          skippedInside.push({ source: childDisplay, reason: entry.isSymbolicLink() ? 'symbolic link' : 'not a file' })
      }
    }
    await walk(real, source, [])
    if (found.length === 0) {
      report.skipped.push({ source, reason: 'no Markdown files in this folder' })
      continue
    }
    report.skipped.push(...skippedInside)
    for (const [child, display] of othersInside) others.set(child, display)
    const top = pickFolderId(folder, path.basename(real))
    const folderIds = new Map<string, string>([['', top]])
    const folderOf = (segments: readonly string[]): string => {
      const key = segments.join('/')
      const known = folderIds.get(key)
      if (known !== undefined) return known
      const id = pickFolderId(folderOf(segments.slice(0, -1)), segments.at(-1) ?? '')
      folderIds.set(key, id)
      return id
    }
    for (const file of found) {
      const name = file.segments.at(-1) ?? ''
      const id = pickNoteId(folderOf(file.segments.slice(0, -1)), name.replace(MARKDOWN, ''))
      notes.push({ path: file.path, real: file.real, id, root: real })
    }
  }

  const noteIds = new Map(notes.map((note) => [note.real, note.id]))
  const usedOthers = new Set<string>()
  const planned: PlannedNote[] = []
  let files = notes.length
  let bytes = 0
  for (const note of notes) {
    const { data, atime, mtime } = await readSource(note.real, 'note')
    bytes += data.byteLength
    const raw = data.toString('utf8')
    const body = parseNoteText(raw).body
    const header = raw.slice(0, raw.length - body.length)
    const sourceDir = path.dirname(note.real)
    const unresolved = new Map<string, string>()
    // Pass 1: where each relative link points (async); pass 2 (below) rewrites with the answers.
    const targets = new Map<string, { note: string } | { asset: string } | null>()
    const wanted = new Set<string>()
    rewriteRelativeLinks(
      body,
      (relPath) => {
        wanted.add(relPath)
        return undefined
      },
      (destination) => {
        unresolved.set(destination, /^https?:/i.test(destination) ? 'web link' : 'not a relative link')
      },
    )
    for (const relPath of wanted) {
      const resolved = await resolveLink(path.resolve(sourceDir, relPath), note.root)
      if (typeof resolved === 'string') {
        unresolved.set(relPath, resolved)
        targets.set(relPath, null)
      } else if (noteIds.has(resolved.real)) {
        targets.set(relPath, { note: noteIds.get(resolved.real) ?? '' })
      } else if (MARKDOWN.test(resolved.real)) {
        unresolved.set(relPath, 'note not part of this import')
        targets.set(relPath, null)
      } else {
        const refusal = options.refuseAsset?.(relPath, resolved.real)
        if (refusal === undefined) targets.set(relPath, { asset: resolved.real })
        else {
          unresolved.set(relPath, refusal)
          targets.set(relPath, null)
        }
      }
    }
    const assets = new Map<string, PlannedAsset>()
    for (const [relPath, target] of targets) {
      if (!target || !('asset' in target)) continue
      const { data: content } = await readSource(target.asset, 'asset')
      bytes += content.byteLength
      const name = assetFileName(content, path.extname(target.asset))
      if (!assets.has(name)) {
        assets.set(name, { source: target.asset, name, ...(options.read ? { data: content } : {}) })
        files++
      }
      usedOthers.add(target.asset)
      targets.set(relPath, { asset: name })
    }
    if (files > limits.maxFiles) {
      throw new VaultError('TOO_LARGE', `Too many files to import (more than ${limits.maxFiles})`)
    }
    if (bytes > limits.maxBytes) {
      throw new VaultError(
        'TOO_LARGE',
        `Too much to import (more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB)`,
      )
    }
    const stem = path.posix.basename(note.id, '.md')
    const dirId = noteFolder(note.id)
    let links = 0
    const nextBody = rewriteRelativeLinks(body, (relPath) => {
      const target = targets.get(relPath)
      if (!target) return undefined
      let next: string
      if ('asset' in target) next = `./${stem}${ASSETS_SUFFIX}/${target.asset}`
      else {
        const relative = path.posix.relative(dirId, target.note)
        next = relative.startsWith('../') || !relPath.startsWith('./') ? relative : `./${relative}`
      }
      if (next === relPath) return undefined
      links++
      return next
    })
    report.links += links
    report.assets += assets.size
    for (const [link, reason] of unresolved) report.unresolved.push({ id: note.id, link, reason })
    const text = nextBody === body ? raw : header + nextBody
    planned.push({
      id: note.id,
      data: nextBody === body ? data : Buffer.from(text, 'utf8'),
      text,
      atime,
      mtime,
      assets: [...assets.values()],
    })
    report.notes.push({ source: note.path, id: note.id })
  }
  for (const [real, display] of others) {
    if (!usedOthers.has(real)) report.skipped.push({ source: display, reason: 'not a Markdown file' })
  }
  return { notes: planned, report }
}

/** The real path of an existing file under `root`, or why the link is left alone. */
async function resolveLink(target: string, root: string): Promise<{ real: string } | string> {
  let real: string
  try {
    real = await realpath(target)
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return 'file not found'
    throw error
  }
  if (!isInside(root, real)) return 'outside the dropped files'
  if (!(await stat(real)).isFile()) return 'not a file'
  return { real }
}

async function lowerCaseEntries(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).map((name) => name.toLowerCase()))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set()
    throw error
  }
}
