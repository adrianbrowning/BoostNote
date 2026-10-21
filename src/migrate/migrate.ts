import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  readConfig,
  readTrashIndex,
  type TrashIndex,
  type VaultConfig,
  writeConfig,
  writeTrashIndex,
} from '../vault/config.ts'
import { isNodeError } from '../vault/errors.ts'
import { writeJsonFile } from '../vault/files.ts'
import { type Frontmatter, parseNoteText, serializeNoteText } from '../vault/frontmatter.ts'
import { fallbackTitle } from '../vault/note.ts'
import {
  ASSETS_SUFFIX,
  CONFIG_DIR,
  encodeLinkPath,
  isInside,
  sanitizeName,
  slugify,
  TRASH_DIR,
  uniqueName,
} from '../vault/paths.ts'
import {
  legacyContentTitle,
  NOTE_LINK,
  STORAGE_REFERENCE,
  snippetToMarkdown,
  storageReferenceSegments,
} from './convert.ts'
import { type LegacyNote, MigrationError, readLegacyStorage } from './legacy.ts'

export interface MigrateOptions {
  /** Write into a target folder that already has files (existing files are never overwritten). */
  force?: boolean
  /** Plan everything and return the report without writing anything. */
  dryRun?: boolean
}

export interface MigratedNote {
  key: string
  type: LegacyNote['type']
  title: string
  /** Vault note id; for trashed notes, the path it is restored to (the file lives under `.trash/`). */
  path: string
  trashed: boolean
  attachments: number
}

export interface MigrationReport {
  source: string
  target: string
  dryRun: boolean
  startedAt: string
  finishedAt: string
  counts: {
    folders: number
    notes: number
    markdownNotes: number
    snippetNotes: number
    trashedNotes: number
    attachments: number
    noteLinks: number
    skippedNotes: number
  }
  notes: MigratedNote[]
  /** Folders/notes whose file name is not simply derived from their name/title (duplicates, invalid characters). */
  renamed: Array<{ kind: 'folder' | 'note'; key: string; name: string; path: string; reason: string }>
  unresolvedAttachments: Array<{ note: string; reference: string }>
  unresolvedLinks: Array<{ note: string; reference: string }>
  skipped: Array<{ file: string; reason: string }>
  warnings: string[]
}

/** Files that do not make a target folder "non-empty". */
const IGNORABLE_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

function toIso(value: string | number | null | undefined, fallback: Date): string {
  if (value !== null && value !== undefined && value !== '') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallback.toISOString()
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return []
    throw error
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return false
    throw error
  }
}

/** Real path of `target`, resolving the deepest existing ancestor (the target may not exist yet). */
async function realTarget(target: string): Promise<string> {
  const missing: string[] = []
  let probe = target
  for (;;) {
    try {
      return path.join(await realpath(probe), ...missing.reverse())
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') || path.dirname(probe) === probe) throw error
      missing.push(path.basename(probe))
      probe = path.dirname(probe)
    }
  }
}

function relativeLink(fromId: string, toId: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromId), toId)
  return encodeLinkPath(relative.startsWith('../') ? relative : `./${relative}`)
}

interface PlannedNote {
  note: LegacyNote
  id: string
  stem: string
  folderKey: string
  title: string
  trashed: boolean
}

/**
 * Converts a legacy Boostnote storage (`boostnote.json`, `notes/*.cson`, `attachments/`) into a vault
 * at `target`. The source is only read. Unless `dryRun`, the report is also written to
 * `<target>/.boostnote/migration-report.json`.
 */
export async function migrateStorage(
  source: string,
  target: string,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const startedAt = new Date().toISOString()
  let src: string
  try {
    src = await realpath(path.resolve(source))
  } catch {
    throw new MigrationError('NOT_A_LEGACY_STORAGE', `Storage folder does not exist: ${source}`)
  }
  const dest = await realTarget(path.resolve(target))
  if (isInside(src, dest)) {
    throw new MigrationError('INVALID_TARGET', 'The target folder must not be the legacy storage or inside it')
  }
  let existingEntries: string[] = []
  try {
    if (!(await stat(dest)).isDirectory()) throw new MigrationError('INVALID_TARGET', `Not a directory: ${target}`)
    existingEntries = (await readdir(dest)).filter((name) => !IGNORABLE_ENTRIES.has(name))
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  if (existingEntries.length > 0 && !options.force) {
    throw new MigrationError('TARGET_NOT_EMPTY', `Target folder is not empty: ${target} (use --force to merge into it)`)
  }

  const storage = await readLegacyStorage(src)
  const report: MigrationReport = {
    source: src,
    target: dest,
    dryRun: options.dryRun === true,
    startedAt,
    finishedAt: startedAt,
    counts: {
      folders: 0,
      notes: 0,
      markdownNotes: 0,
      snippetNotes: 0,
      trashedNotes: 0,
      attachments: 0,
      noteLinks: 0,
      skippedNotes: storage.skipped.length,
    },
    notes: [],
    renamed: [],
    unresolvedAttachments: [],
    unresolvedLinks: [],
    skipped: storage.skipped,
    warnings: [],
  }

  // Folders → top-level directories (sanitised, deduplicated case-insensitively).
  const usedRootNames = new Set(existingEntries.map((name) => name.toLowerCase()))
  const folderDirs = new Map<string, string>()
  const colors = new Map<string, string>()
  const addFolder = (key: string, name: string, color?: string) => {
    const base = sanitizeName(name) || 'Untitled folder'
    const dir = uniqueName(base, (candidate) => usedRootNames.has(candidate.toLowerCase()), ' ')
    usedRootNames.add(dir.toLowerCase())
    folderDirs.set(key, dir)
    if (color) colors.set(dir, color)
    if (dir === name) return
    const reason =
      name.trim() === '' ? 'empty name' : base !== name ? 'not a valid file name' : 'name already taken, ignoring case'
    report.renamed.push({ kind: 'folder', key, name, path: dir, reason })
  }
  for (const folder of storage.folders) {
    if (folderDirs.has(folder.key)) {
      report.warnings.push(`Folder key ${folder.key} appears twice in boostnote.json; the second entry was ignored`)
      continue
    }
    addFolder(folder.key, folder.name, folder.color)
  }
  let unknownFolders = 0
  for (const note of storage.notes) {
    if (folderDirs.has(note.folder)) continue
    unknownFolders++
    addFolder(note.folder, `Unknown ${unknownFolders}`)
    report.warnings.push(
      `Notes reference folder key "${note.folder}", which boostnote.json does not list; created "${folderDirs.get(note.folder)}"`,
    )
  }
  report.counts.folders = folderDirs.size

  // Notes → `<folder>/<slug(title)>.md`, oldest first so the original keeps the plain name.
  const ordered = [...storage.notes].sort(
    (a, b) =>
      toIso(a.createdAt, a.fileTime).localeCompare(toIso(b.createdAt, b.fileTime)) || a.key.localeCompare(b.key),
  )
  const stemsByFolder = new Map<string, Set<string>>()
  const planned = new Map<string, PlannedNote>()
  for (const note of ordered) {
    const dir = folderDirs.get(note.folder) ?? ''
    const title =
      (note.title ?? '').trim() ||
      (note.type === 'MARKDOWN_NOTE'
        ? legacyContentTitle(note.content ?? '')
        : ((note.description ?? '')
            .split('\n')
            .find((line) => line.trim() !== '')
            ?.trim() ?? ''))
    const base = slugify(title)
    const stems = stemsByFolder.get(dir) ?? new Set<string>()
    stemsByFolder.set(dir, stems)
    const stem = uniqueName(base, (candidate) => stems.has(candidate.toLowerCase()))
    stems.add(stem.toLowerCase())
    const id = `${dir}/${stem}.md`
    if (stem !== base) {
      report.renamed.push({ kind: 'note', key: note.key, name: title, path: id, reason: 'duplicate file name' })
    }
    planned.set(note.key, { note, id, stem, folderKey: note.folder, title, trashed: note.isTrashed === true })
  }

  const attachmentsDir = path.join(src, 'attachments')
  const imagesDir = path.join(src, 'images')
  const trashIndex: TrashIndex['entries'] = {}
  const writes: Array<() => Promise<void>> = []

  for (const plan of planned.values()) {
    const { note, id, stem, trashed } = plan
    const isMarkdown = note.type === 'MARKDOWN_NOTE'
    const displayTitle = plan.title || 'Untitled'
    let body = isMarkdown ? (note.content ?? '') : snippetToMarkdown(displayTitle, note)

    // Attachments: everything in attachments/<key>/ plus whatever the note references elsewhere.
    const assets = new Map<string, string>() // source file → name inside <stem>.assets/
    const assetNames = new Set<string>()
    const addAsset = (file: string) => {
      const existing = assets.get(file)
      if (existing) return existing
      const ext = path.extname(file)
      const name = uniqueName(path.basename(file, ext), (candidate) =>
        assetNames.has(`${candidate}${ext}`.toLowerCase()),
      )
      assets.set(file, `${name}${ext}`)
      assetNames.add(`${name}${ext}`.toLowerCase())
      return `${name}${ext}`
    }
    const ownDir = path.join(attachmentsDir, note.key)
    for (const name of await listFiles(ownDir)) addAsset(path.join(ownDir, name))
    const replacements = new Map<string, string>()
    for (const reference of new Set(body.match(STORAGE_REFERENCE) ?? [])) {
      const segments = storageReferenceSegments(reference)
      const file = segments.at(-1) ?? ''
      const candidates =
        segments.length >= 2
          ? [path.join(attachmentsDir, ...segments)]
          : [path.join(ownDir, file), path.join(imagesDir, file), path.join(attachmentsDir, file)]
      let found: string | undefined
      for (const candidate of candidates) {
        const allowed = isInside(attachmentsDir, candidate) || isInside(imagesDir, candidate)
        if (allowed && (await isRegularFile(candidate))) {
          found = candidate
          break
        }
      }
      if (found) {
        replacements.set(reference, `./${encodeLinkPath(stem)}${ASSETS_SUFFIX}/${encodeLinkPath(addAsset(found))}`)
      } else {
        report.unresolvedAttachments.push({ note: id, reference })
      }
    }
    body = body.replace(STORAGE_REFERENCE, (match) => replacements.get(match) ?? match)

    // Inter-note links: `:note:<key>` → relative path to the converted note.
    body = body.replace(NOTE_LINK, (match, key: string) => {
      const linked = planned.get(key)
      if (!linked) {
        report.unresolvedLinks.push({ note: id, reference: match })
        return match
      }
      if (linked.trashed && !trashed) {
        report.warnings.push(`${id} links to trashed note ${linked.id} (it resolves once that note is restored)`)
      }
      report.counts.noteLinks++
      return relativeLink(id, linked.id)
    })

    // Frontmatter: legacy metadata first, then any frontmatter the content already had.
    let contentFrontmatter: Frontmatter = {}
    if (isMarkdown) {
      const text = parseNoteText(body)
      if (text.yaml !== null) {
        contentFrontmatter = text.frontmatter
        body = text.body
      }
    }
    const created = toIso(note.createdAt, note.fileTime)
    const updated = toIso(note.updatedAt, note.fileTime)
    const frontmatter: Frontmatter = {}
    const contentTitle = typeof contentFrontmatter.title === 'string' ? contentFrontmatter.title.trim() : ''
    if (plan.title !== '' && plan.title !== (contentTitle || fallbackTitle(id, body))) frontmatter.title = plan.title
    const tags = [
      ...new Set((note.tags ?? []).filter((tag) => typeof tag === 'string').map((tag) => tag.trim())),
    ].filter(Boolean)
    if (tags.length > 0) frontmatter.tags = tags
    if (note.isStarred) frontmatter.starred = true
    if (note.isPinned) frontmatter.pinned = true
    frontmatter.created = created
    frontmatter.updated = updated
    frontmatter.boostnote = { key: note.key, folder: plan.folderKey }
    for (const [key, value] of Object.entries(contentFrontmatter)) {
      if (!(key in frontmatter)) {
        frontmatter[key] = value
      } else if (!isDeepStrictEqual(frontmatter[key], value)) {
        report.warnings.push(`${id}: frontmatter "${key}" in the note content was replaced by the legacy value`)
      }
    }
    const raw = serializeNoteText(frontmatter, body)

    report.counts.notes++
    if (isMarkdown) report.counts.markdownNotes++
    else report.counts.snippetNotes++
    if (trashed) {
      report.counts.trashedNotes++
      trashIndex[id] = { kind: 'note', originalPath: id, deletedAt: updated }
    }
    report.counts.attachments += assets.size
    report.notes.push({
      key: note.key,
      type: note.type,
      title: displayTitle,
      path: id,
      trashed,
      attachments: assets.size,
    })

    const file = trashed ? path.join(dest, TRASH_DIR, ...id.split('/')) : path.join(dest, ...id.split('/'))
    writes.push(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, raw, { flag: 'wx' })
      if (assets.size > 0) {
        const assetsDir = file.replace(/\.md$/, ASSETS_SUFFIX)
        await mkdir(assetsDir, { recursive: true })
        for (const [from, name] of assets) await copyFile(from, path.join(assetsDir, name), constants.COPYFILE_EXCL)
      }
      const time = new Date(updated)
      await utimes(file, time, time)
    })
  }

  if (!report.dryRun) {
    await mkdir(dest, { recursive: true })
    for (const dir of folderDirs.values()) await mkdir(path.join(dest, dir), { recursive: true })
    for (const write of writes) await write()

    const config: VaultConfig = options.force ? await readConfig(dest) : { version: 1, folders: {} }
    for (const [dir, color] of colors) config.folders[dir] = { ...config.folders[dir], color }
    config.folderOrder = [...(config.folderOrder ?? []), ...folderDirs.values()]
    await writeConfig(dest, config)

    if (Object.keys(trashIndex).length > 0) {
      const index = await readTrashIndex(dest)
      Object.assign(index.entries, trashIndex)
      await writeTrashIndex(dest, index)
    }
  }
  report.finishedAt = new Date().toISOString()
  if (!report.dryRun) await writeJsonFile(path.join(dest, CONFIG_DIR, 'migration-report.json'), report)
  return report
}
