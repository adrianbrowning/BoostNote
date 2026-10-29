import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import * as path from 'node:path'

import type { ImportOptions } from '../vault/index.ts'
import { isInside, safeDecode } from '../vault/paths.ts'

type ImportReader = NonNullable<ImportOptions['read']>

/** Never follows a symlink at the file itself and never blocks on a FIFO (Windows has neither flag). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Codes of a path that no longer leads to a file the app may read (gone, a symlink, not allowed). */
const REFUSED: Record<string, true> = {
  ENOENT: true,
  ENOTDIR: true,
  ELOOP: true,
  EMLINK: true,
  EACCES: true,
  EPERM: true,
}

function refused(error: unknown): undefined {
  if (REFUSED[(error as NodeJS.ErrnoException).code ?? ''] === true) return undefined
  throw error
}

/**
 * Opens `file` without following a symlink and, when it is a regular file, runs `use` on the open
 * handle. `use`'s result counts only if, after it ran, the path still leads without any symlink to
 * the very file it used: `realpath(file)` is `file` and `lstat(file)` is a regular file with the
 * handle's device and inode. `O_NOFOLLOW` guards only the last component; comparing the handle with
 * what the path names after the read anchors the read beneath the real parent folders, so a handle
 * opened through a parent swapped for a symlink (even one restored before the check) is refused.
 * Not detected: a process running as the same user that flips a parent folder to a symlink again
 * between the after-read `realpath` and `lstat` checks. This race is accepted (there is no native
 * `openat` helper).
 * `undefined` when `file` is gone or anything else (a symlink, folder, FIFO or device).
 */
async function useRegular<T>(file: string, use: (handle: FileHandle) => Promise<T>): Promise<T | undefined> {
  const handle = await open(file, OPEN_FLAGS).catch(refused)
  if (handle === undefined) return undefined
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) return undefined
    const value = await use(handle)
    if ((await realpath(file).catch(refused)) !== file) return undefined
    const named = await lstat(file, { bigint: true }).catch(refused)
    if (!named?.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return undefined
    return value
  } finally {
    await handle.close()
  }
}

/**
 * Tickets for `.md` files outside every known vault, opened read-only in reader tabs. Main grants
 * one when such a file is opened from the OS (`VaultSession.takeOpenRequest`). The page gets the
 * ticket and the file's base name, never its path, and reads the file through
 * `GET /api/reader/:ticket` as often as it likes. A ticket is exactly 48 lowercase hex characters
 * (`randomBytes(24)`) and carries no information about the file. Unlike `DropGrants` a ticket does
 * not expire: it lives until the reader tab closes (`revoke`) or the app quits. One file has at
 * most one live ticket, so opening it again finds its existing tab.
 *
 * A ticket reads only the path the OS gave the app. Each read opens it without following a symlink,
 * refuses anything but a regular file (a symlink, folder, FIFO or device), and after reading requires
 * the path to still be its own real path and to name the file it read; see `useRegular` for the one
 * accepted race (a parent folder flipped to a symlink between those checks). Another regular file
 * renamed over it (an editor's atomic save) is that path's file now and reads under the same ticket.
 * Files the document links to (`asset`) are read with the same checks, inside the file's folder.
 */
export class ReaderGrants {
  readonly #paths = new Map<string, string>()
  readonly #tickets = new Map<string, string>()
  /** Tickets whose `importOnce` runs. */
  readonly #importing = new Set<string>()

  /**
   * The live ticket of the regular file at real path `file`, granted now if it has none;
   * `undefined` when `file` is gone, is not its own real path, or is not a regular file.
   */
  async grant(file: string): Promise<string | undefined> {
    if ((await useRegular(file, async () => true)) === undefined) return undefined
    const live = this.#tickets.get(file)
    if (live !== undefined) return live
    const ticket = randomBytes(24).toString('hex')
    this.#paths.set(ticket, file)
    this.#tickets.set(file, ticket)
    return ticket
  }

  /** The real path behind `ticket`; `undefined` when unknown or revoked. */
  path(ticket: string): string | undefined {
    return this.#paths.get(ticket)
  }

  /**
   * The real path behind `ticket` when it still is a regular file at that real path (checked as
   * `read` checks, without reading it); `undefined` when unknown, revoked, gone or anything else.
   */
  async regularPath(ticket: string): Promise<string | undefined> {
    const file = this.#paths.get(ticket)
    return file !== undefined && (await useRegular(file, async () => true)) ? file : undefined
  }

  /**
   * The text of the file behind `ticket`, read now; `undefined` when the ticket is unknown or
   * revoked, or its path no longer is a regular file at that real path (gone, a symlink, a FIFO).
   */
  async read(ticket: string): Promise<string | undefined> {
    const file = this.#paths.get(ticket)
    return file === undefined ? undefined : useRegular(file, (handle) => handle.readFile('utf8'))
  }

  /**
   * The bytes and base name of the file `src` (a relative link as written in the document,
   * `img/a%20b.png`) names next to the file behind `ticket`. Follows the import's `resolveLink`
   * rules: the real path must be a regular file inside the document's folder, so `../` and symlinks
   * that leave it are refused; the read itself has `useRegular`'s guarantees. `undefined` when
   * refused or gone.
   */
  async asset(ticket: string, src: string): Promise<{ bytes: Buffer; name: string } | undefined> {
    const file = this.#paths.get(ticket)
    if (file === undefined) return undefined
    const link = safeDecode(src.replace(/[?#].*$/, ''))
    if (link === '' || link.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(link)) return undefined
    const folder = path.dirname(file)
    const real = await realpath(path.resolve(folder, link)).catch(refused)
    if (real === undefined || !isInside(folder, real)) return undefined
    const bytes = await useRegular(real, (handle) => handle.readFile())
    return bytes === undefined ? undefined : { bytes, name: path.basename(real) }
  }

  /**
   * A reader tab's "Add to vault…": runs `run` (the import) on the real path behind `ticket`, at
   * most once per ticket. The ticket is claimed before anything is awaited, so a second call while
   * one runs gets `undefined`; it ends (`revoke`) when `run` resolves and stays live when `run`
   * throws, so a failed import can be retried. `undefined` without calling `run` when the ticket is
   * unknown, revoked or claimed, or its path no longer is a regular file at that real path.
   *
   * `run` gets `read` for `Vault.importFiles` (`ImportOptions.read`): the note may only be the
   * granted file and a linked `asset` must lie inside its folder, and each is read with `read`'s
   * checks (`useRegular`), so a file swapped for a symlink after the check above is refused rather
   * than copied into the vault.
   */
  async importOnce<T>(ticket: string, run: (file: string, read: ImportReader) => Promise<T>): Promise<T | undefined> {
    if (!this.#paths.has(ticket) || this.#importing.has(ticket)) return undefined
    this.#importing.add(ticket)
    try {
      const file = await this.regularPath(ticket)
      if (file === undefined) return undefined
      const folder = path.dirname(file)
      const read: ImportReader = async (real, kind) => {
        if (kind === 'note' ? real !== file : !isInside(folder, real)) return undefined
        return useRegular(real, async (handle) => {
          const data = await handle.readFile()
          const { atime, mtime } = await handle.stat()
          return { data, atime, mtime }
        })
      }
      const result = await run(file, read)
      this.revoke(ticket)
      return result
    } finally {
      this.#importing.delete(ticket)
    }
  }

  /** Ends `ticket` (its reader tab closed); `false` when it was unknown or already revoked. */
  revoke(ticket: string): boolean {
    const file = this.#paths.get(ticket)
    if (file === undefined) return false
    this.#paths.delete(ticket)
    this.#tickets.delete(file)
    return true
  }
}
