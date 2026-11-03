import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import { isNodeError } from './errors.ts'

/**
 * Writes `data` to a hidden temp file next to `file`, then renames it over `file`, so readers (and
 * the watcher) never see a half-written file. The temp name starts with `.`, which the vault ignores.
 * `beforeReplace` runs after the temp file is complete and just before the rename; when it resolves
 * `false` (or throws) the temp file is removed and `file` is left untouched. Resolves `true` when
 * `file` was replaced, `false` when `beforeReplace` declined. Not a compare-and-swap: a write to
 * `file` that lands after `beforeReplace` resolves and before the rename is overwritten undetected
 * (POSIX rename cannot check the target); this is an accepted limitation.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  beforeReplace?: () => Promise<boolean>,
): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, data)
    if (beforeReplace && !(await beforeReplace())) {
      await rm(temp, { force: true })
      return false
    }
    await rename(temp, file)
    return true
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Copies `source` to `file` through a hidden temp file next to `file` (see `writeFileAtomic`). */
export async function copyFileAtomic(source: string, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await copyFile(source, temp)
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

/** True when a regular file (not a symlink or directory) exists at `file`. */
export async function isFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile()
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}
