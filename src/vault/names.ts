import { readdir } from 'node:fs/promises'

import { isNoteFileName, noteStem } from '../shared/vault-ids.ts'
import { isNodeError } from './errors.ts'
import { ASSETS_SUFFIX, uniqueName } from './paths.ts'

/** The key two entry names in one folder clash under: NFC-normalized and lower-cased. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Whether note file names `a` and `b` are stem twins: both are note file names and their stems are
 * equal by `nameKey` (NFC, lower case), whatever their note extensions (`a.md` and `a.MD`, `a.md`
 * and `A.mdx`, NFD `Cafe\u0301.md` and `Caf\u00e9.MD`). Twins can share `<stem>.assets/`; callers check
 * that their assets folders resolve to one directory (on a case-sensitive disk `A.md` and `a.md` keep
 * separate ones).
 */
export function isExtensionCaseTwin(a: string, b: string): boolean {
  return isNoteFileName(a) && isNoteFileName(b) && nameKey(noteStem(a)) === nameKey(noteStem(b))
}

/**
 * A folder's names as the taken-stem checks read them: its entries from one `readdir`, plus the names
 * a planner picked since (`takeStem`, `addName`).
 */
export interface FolderNames {
  /** How many entries have each `nameKey`. */
  readonly entries: Map<string, number>
  /**
   * How many note files (`isNoteFileName`) have each stem `nameKey`: `a.md`, `A.MD` and `a.mdx` count
   * for `a`; a non-note `a.MDX` or `a.txt` counts for none.
   */
  readonly stems: Map<string, number>
}

/** The `FolderNames` of a folder holding the entries `names` (none by default). */
export function folderNames(names: Iterable<string> = []): FolderNames {
  const result: FolderNames = { entries: new Map(), stems: new Map() }
  for (const name of names) addName(result, name)
  return result
}

/** Counts the entry `name` in `names`: by its `nameKey`, and by its stem when it is a note file name. */
export function addName(names: FolderNames, name: string): void {
  increment(names.entries, nameKey(name))
  if (isNoteFileName(name)) increment(names.stems, nameKey(noteStem(name)))
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** The `FolderNames` of the entries of `dir`; empty when it does not exist. */
export async function readFolderNames(dir: string): Promise<FolderNames> {
  try {
    return folderNames(await readdir(dir))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return folderNames()
    throw error
  }
}

/**
 * Whether a note `<stem><extension>` would clash in a folder with `names`: a note file of that stem
 * (`.md` in any case or `.mdx`) or its `.assets` folder is there, or any entry named
 * `<stem><extension>` (so an `.mdx` note never lands on a non-note `a.MDX`, the same file on a
 * case-insensitive disk), all by `nameKey`. A non-note `a.MDX` takes no `.md` stem. The one
 * taken-stem check of `uniqueStem`, the title-rename planner and the import planner.
 */
export function stemTaken(names: FolderNames, stem: string, extension: string): boolean {
  const key = nameKey(stem)
  return (
    names.stems.has(key) ||
    names.entries.has(`${key}${ASSETS_SUFFIX}`) ||
    names.entries.has(nameKey(`${stem}${extension}`))
  )
}

/** Marks the note `<stem><extension>` and its assets folder taken in `names`, as `stemTaken` checks them. */
export function takeStem(names: FolderNames, stem: string, extension: string): void {
  addName(names, `${stem}${extension}`)
  addName(names, `${stem}${ASSETS_SUFFIX}`)
}

/**
 * Whether the note file `name` in a folder with `names` shares its stem with another entry: another
 * note file of its stem (a stem twin: `a.MD` or `a.mdx` beside `a.md`) or another entry of its
 * `nameKey` (a non-note `a.MDX` beside `a.mdx` on a case-sensitive disk). A non-note `a.MDX` beside
 * `a.md` is no such entry.
 */
export function stemShared(names: FolderNames, name: string): boolean {
  return (names.stems.get(nameKey(noteStem(name))) ?? 0) > 1 || (names.entries.get(nameKey(name)) ?? 0) > 1
}

/** The `nameKey`s of the entries of `dir`; empty when it does not exist. */
export async function lowerCaseEntries(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).map(nameKey))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set()
    throw error
  }
}

/**
 * First free stem in `dir` for a note with `extension` (`stemTaken`: no note or `.assets` folder of
 * that stem, nor any entry named `<stem><extension>`).
 */
export async function uniqueStem(dir: string, base: string, extension: string): Promise<string> {
  const names = await readFolderNames(dir)
  return uniqueName(base, (candidate) => stemTaken(names, candidate, extension))
}
