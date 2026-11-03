import { readdir } from 'node:fs/promises'

import { isNodeError } from './errors.ts'
import { ASSETS_SUFFIX, uniqueName } from './paths.ts'

/** The lower-cased entry names of `dir`; empty when it does not exist. */
export async function lowerCaseEntries(dir: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(dir)).map((name) => name.toLowerCase()))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set()
    throw error
  }
}

/** First free stem in `dir` (checked case-insensitively against both `<stem>.md` and `<stem>.assets`). */
export async function uniqueStem(dir: string, base: string): Promise<string> {
  const names = await lowerCaseEntries(dir)
  return uniqueName(base, (candidate) => {
    const lower = candidate.toLowerCase()
    return names.has(`${lower}.md`) || names.has(`${lower}${ASSETS_SUFFIX}`)
  })
}
