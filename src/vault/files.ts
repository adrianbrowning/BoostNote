import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import { isNodeError } from './errors.ts'

/**
 * Writes `data` to a hidden temp file next to `file`, then renames it over `file`, so readers (and
 * the watcher) never see a half-written file. The temp name starts with `.`, which the vault ignores.
 * `beforeReplace` runs after the temp file is complete and just before the rename; throwing from it
 * aborts the write and leaves `file` untouched.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data)
    await beforeReplace?.()
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Parses a JSON file; `undefined` when it does not exist or is not valid JSON. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** True when something (file, directory or symlink) exists at `file`. */
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) return false
    throw error
  }
}
