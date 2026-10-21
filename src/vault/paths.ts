import { realpath } from 'node:fs/promises'
import * as path from 'node:path'

import { isNodeError, VaultError } from './errors.ts'

/** Directory (relative to the vault root) that holds deleted notes and folders. */
export const TRASH_DIR = '.trash'
/** Directory (relative to the vault root) that holds vault config and reports. */
export const CONFIG_DIR = '.boostnote'
export const ASSETS_SUFFIX = '.assets'

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

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const MAX_NAME_LENGTH = 100

/**
 * Turns a free-form name into a safe file/directory name while keeping its case and spaces
 * (used for folders and explicit renames). Returns `''` when nothing usable is left.
 */
export function sanitizeName(name: string): string {
  let result = name
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are invalid in file names
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (result.endsWith(ASSETS_SUFFIX)) result = result.slice(0, -ASSETS_SUFFIX.length)
  result = result.slice(0, MAX_NAME_LENGTH).trim()
  if (WINDOWS_RESERVED.test(result)) result = `${result}-`
  return result
}

/** File-name slug for a note title: lower-case, hyphen-separated, punctuation removed; `untitled` if empty. */
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
  return WINDOWS_RESERVED.test(slug) ? `${slug}-note` : slug
}

/**
 * Returns `base`, or `base-2`, `base-3`, … — the first candidate for which `taken(candidate)` is false.
 * Comparison is the caller's business (pass a lower-cased set for case-insensitive file systems).
 */
export function uniqueName(base: string, taken: (candidate: string) => boolean, separator = '-'): string {
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${separator}${n}`
    if (!taken(candidate)) return candidate
  }
}

/** Percent-encodes the characters that would break a CommonMark link destination. */
export function encodeLinkPath(relPath: string): string {
  return relPath.replace(/[ %()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
