import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import * as path from 'node:path'

import { isNodeError, VaultError } from './errors.ts'

/** Directory (relative to the vault root) that holds deleted notes and folders. */
export const TRASH_DIR = '.trash'
/** Directory (relative to the vault root) that holds vault config and reports. */
export const CONFIG_DIR = '.boostnote'
export const ASSETS_SUFFIX = '.assets'

const ASSET_EXTENSION = /^[a-z0-9]{1,10}$/

/** Name of an asset file: `<sha256-12>.<ext>` (`ext` lower-cased; `bin` when it is not a plain extension). */
export function assetFileName(bytes: Uint8Array, ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase()
  const extension = ASSET_EXTENSION.test(normalized) ? normalized : 'bin'
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${extension}`
}

/** True for entries the vault never treats as notes or folders: dot-entries and `*.assets` dirs. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name.endsWith(ASSETS_SUFFIX)
}

function splitRelative(rel: string, what: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) {
    throw new VaultError('INVALID_PATH', `Invalid ${what}: ${JSON.stringify(rel)}`)
  }
  if (rel === '') return []
  const segments = rel.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || isHiddenName(segment)) {
      throw new VaultError('INVALID_PATH', `Invalid ${what}: ${JSON.stringify(rel)}`)
    }
  }
  return segments
}

/** Validates a folder id (`''` is the vault root, otherwise a POSIX path like `work/projects`). */
export function folderSegments(folder: string): string[] {
  return splitRelative(folder, 'folder')
}

/** Validates a note id (`work/todo.md`) and returns its path segments. */
export function noteSegments(id: string): string[] {
  const segments = splitRelative(id, 'note id')
  const last = segments.at(-1)
  if (!last?.endsWith('.md') || last.length === 3) {
    throw new VaultError('INVALID_PATH', `Invalid note id: ${JSON.stringify(id)}`)
  }
  return segments
}

/** Folder id of a note id (`work/todo.md` → `work`, `todo.md` → `''`). */
export function noteFolder(id: string): string {
  const index = id.lastIndexOf('/')
  return index === -1 ? '' : id.slice(0, index)
}

/** File name without `.md` (`work/todo.md` → `todo`). */
export function noteStem(id: string): string {
  return path.posix.basename(id, '.md')
}

export function joinId(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Joins `segments` onto the (already real-pathed) vault root and verifies that the deepest existing
 * ancestor of the result does not resolve, through symlinks, outside the root.
 */
export async function resolveInside(root: string, segments: readonly string[]): Promise<string> {
  const absolute = path.join(root, ...segments)
  if (!isInside(root, absolute)) throw new VaultError('INVALID_PATH', `Path escapes the vault: ${absolute}`)
  let probe = absolute
  for (;;) {
    try {
      const real = await realpath(probe)
      if (!isInside(root, real)) throw new VaultError('INVALID_PATH', `Path escapes the vault via a symlink: ${probe}`)
      return absolute
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') || probe === root) throw error
      probe = path.dirname(probe)
    }
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i
/** Longest name (in characters, and in UTF-8 bytes so `.md`, ` 99` and `.assets` still fit in 255). */
const MAX_NAME_LENGTH = 120
const MAX_NAME_BYTES = 200
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const utf8 = new TextEncoder()

/**
 * Turns a free-form name into a safe file/directory name while keeping its case and spaces:
 * `/ \ : * ? " < > |` and control characters become `-`, whitespace collapses, leading dots and
 * trailing dots/spaces go, the length is capped on a character boundary, and Windows device names
 * (`CON`, `LPT1`, …) get a `-` suffix. Returns `''` when nothing usable is left.
 */
export function sanitizeFileName(name: string): string {
  let result = name
    .normalize('NFC')
    // Tabs and line breaks are whitespace (collapsed to a space), other control characters invalid.
    .replace(/\s+/g, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in file names
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, '-')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (result.endsWith(ASSETS_SUFFIX)) result = result.slice(0, -ASSETS_SUFFIX.length).replace(/[.\s]+$/, '')
  let capped = ''
  let count = 0
  for (const { segment } of graphemes.segment(result)) {
    if (count === MAX_NAME_LENGTH || utf8.encode(capped + segment).length > MAX_NAME_BYTES) break
    capped += segment
    count++
  }
  return capped.replace(/[.\s]+$/, '').replace(WINDOWS_RESERVED, '$1-')
}

/** File name (without `.md`) for a note called `name`: `sanitizeFileName(name)`, or `Untitled`. */
export function noteFileName(name: string): string {
  return sanitizeFileName(name) || 'Untitled'
}

/**
 * The file-name slug the importer gave notes before file names became note names (phase 7):
 * lower-case, hyphen-separated, punctuation removed; `untitled` if empty. Only the bulk
 * "rename files from titles" uses it, to recognise those files.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}_]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  if (slug === '') return 'untitled'
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(slug) ? `${slug}-note` : slug
}

/**
 * Returns `base`, or `base 2`, `base 3`, … (`separator` between) — the first candidate for which
 * `taken(candidate)` is false.
 * Comparison is the caller's business (pass a lower-cased set for case-insensitive file systems).
 */
export function uniqueName(base: string, taken: (candidate: string) => boolean, separator = ' '): string {
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${separator}${n}`
    if (!taken(candidate)) return candidate
  }
}

/** Percent-encodes the characters that would break a CommonMark link destination (or start its fragment). */
export function encodeLinkPath(relPath: string): string {
  return relPath.replace(/[ #%()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
