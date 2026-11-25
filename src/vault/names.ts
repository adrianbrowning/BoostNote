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

/** The `nameKey`s of the note files a stem can have in a folder: `<stem>.md` (any case) and `<stem>.mdx`. */
function noteKeys(stem: string): [string, string] {
  const key = nameKey(stem)
  return [`${key}.md`, `${key}.mdx`]
}

/**
 * Whether `stem` is taken in a folder whose entry `nameKey`s are `names`: a `.md` (any case) or
 * `.mdx` note of that stem, or its `.assets` folder, exists there (all by `nameKey`). The one
 * taken-stem check of `uniqueStem`, the title-rename planner and the import planner.
 */
export function stemTaken(names: ReadonlySet<string>, stem: string): boolean {
  return [...noteKeys(stem), `${nameKey(stem)}${ASSETS_SUFFIX}`].some((key) => names.has(key))
}

/** Marks `stem` taken in `names` (the `nameKey`s of a folder's entries plus earlier picks), as `stemTaken` checks it. */
export function takeStem(names: Set<string>, stem: string): void {
  names.add(noteKeys(stem)[0])
  names.add(`${nameKey(stem)}${ASSETS_SUFFIX}`)
}

/**
 * Whether more than one note file of `stem` is in a folder whose entries per `nameKey` are counted
 * in `counts` (`entryKeyCounts`): stem twins such as `a.md` beside `a.MD` or `a.mdx`.
 */
export function hasStemTwin(counts: ReadonlyMap<string, number>, stem: string): boolean {
  return noteKeys(stem).reduce((sum, key) => sum + (counts.get(key) ?? 0), 0) > 1
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

/** How many entries of `dir` have each `nameKey`; empty when it does not exist. */
export async function entryKeyCounts(dir: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  try {
    for (const name of await readdir(dir)) counts.set(nameKey(name), (counts.get(nameKey(name)) ?? 0) + 1)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  return counts
}

/** First free stem in `dir` (one `stemTaken` checks against `<stem>.md`, `<stem>.mdx` and `<stem>.assets`). */
export async function uniqueStem(dir: string, base: string): Promise<string> {
  const names = await lowerCaseEntries(dir)
  return uniqueName(base, (candidate) => stemTaken(names, candidate))
}
