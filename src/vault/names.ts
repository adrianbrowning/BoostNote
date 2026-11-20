import { readdir } from 'node:fs/promises'

import { isNoteFileName, noteStem } from '../shared/vault-ids.ts'
import { isNodeError } from './errors.ts'
import { ASSETS_SUFFIX, uniqueName } from './paths.ts'

/** The key two entry names in one folder clash under: NFC-normalized and lower-cased. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Whether note file names `a` and `b` are extension-case twins: both are note file names and their
 * stems are equal after NFC normalization (`a.md` and `a.MD`, NFD `Cafe\u0301.md` and `Caf\u00e9.MD`).
 */
export function isExtensionCaseTwin(a: string, b: string): boolean {
  return isNoteFileName(a) && isNoteFileName(b) && noteStem(a).normalize('NFC') === noteStem(b).normalize('NFC')
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

/** First free stem in `dir` (checked by `nameKey` against both `<stem>.md` and `<stem>.assets`). */
export async function uniqueStem(dir: string, base: string): Promise<string> {
  const names = await lowerCaseEntries(dir)
  return uniqueName(base, (candidate) => {
    const key = nameKey(candidate)
    return names.has(`${key}.md`) || names.has(`${key}${ASSETS_SUFFIX}`)
  })
}
