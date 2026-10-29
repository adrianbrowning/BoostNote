import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'

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
 * A ticket reads only the path the OS gave the app, and only while it is a regular file at that
 * same real path: once a symlink sits there or in a parent folder, or a FIFO or device, reads are
 * refused. Another regular file renamed over it (an editor's atomic save) is that path's file now
 * and reads under the same ticket.
 */
export class ReaderGrants {
  readonly #paths = new Map<string, string>()
  readonly #tickets = new Map<string, string>()

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
   * The text of the file behind `ticket`, read now; `undefined` when the ticket is unknown or
   * revoked, or its path no longer is a regular file at that real path (gone, a symlink, a FIFO).
   */
  async read(ticket: string): Promise<string | undefined> {
    const file = this.#paths.get(ticket)
    return file === undefined ? undefined : useRegular(file, (handle) => handle.readFile('utf8'))
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
