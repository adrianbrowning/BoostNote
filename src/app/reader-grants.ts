import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'

/** The file a ticket was granted for: its real path and, so a later swap is caught, its identity. */
interface Grant {
  readonly file: string
  readonly dev: bigint
  readonly ino: bigint
}

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
 * `file` opened for reading, with its identity, when it is a regular file whose real path is `file`
 * (no symlink anywhere on the way) and the path still names the opened file once checked; `undefined`
 * when it is gone or anything else (a symlink, folder, FIFO or device). The caller closes the handle.
 */
async function openRegular(file: string): Promise<{ handle: FileHandle; dev: bigint; ino: bigint } | undefined> {
  const handle = await open(file, OPEN_FLAGS).catch(refused)
  if (handle === undefined) return undefined
  let kept = false
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || (await realpath(file).catch(refused)) !== file) return undefined
    // Nothing was renamed over the path between `open` and `realpath`.
    const named = await lstat(file, { bigint: true }).catch(refused)
    if (!named?.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return undefined
    kept = true
    return { handle, dev: opened.dev, ino: opened.ino }
  } finally {
    if (!kept) await handle.close()
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
 * A ticket reads only the file the OS gave the app: the regular file at its real path with the
 * device and inode recorded at grant time. Once anything else sits at that path (a symlink, another
 * file renamed over it as editors save, a FIFO or device), reads are refused; opening the path from
 * the OS again grants the new file a new ticket and revokes the old one.
 */
export class ReaderGrants {
  readonly #grants = new Map<string, Grant>()
  readonly #tickets = new Map<string, string>()

  /**
   * The live ticket of the regular file at real path `file`, granted now if it has none (or its
   * ticket was for a file that has since been replaced); `undefined` when `file` is gone, is not
   * its own real path, or is not a regular file.
   */
  async grant(file: string): Promise<string | undefined> {
    const opened = await openRegular(file)
    if (opened === undefined) return undefined
    await opened.handle.close()
    const { dev, ino } = opened
    const live = this.#tickets.get(file)
    if (live !== undefined) {
      const granted = this.#grants.get(live)
      if (granted?.dev === dev && granted.ino === ino) return live
      this.revoke(live)
    }
    const ticket = randomBytes(24).toString('hex')
    this.#grants.set(ticket, { file, dev, ino })
    this.#tickets.set(file, ticket)
    return ticket
  }

  /** The real path behind `ticket`; `undefined` when unknown or revoked. */
  path(ticket: string): string | undefined {
    return this.#grants.get(ticket)?.file
  }

  /**
   * The text of the file behind `ticket`, read now; `undefined` when the ticket is unknown or
   * revoked, or its path no longer holds the granted file (gone, replaced, swapped for a symlink).
   */
  async read(ticket: string): Promise<string | undefined> {
    const grant = this.#grants.get(ticket)
    if (grant === undefined) return undefined
    const opened = await openRegular(grant.file)
    if (opened === undefined) return undefined
    try {
      if (opened.dev !== grant.dev || opened.ino !== grant.ino) return undefined
      return await opened.handle.readFile('utf8')
    } finally {
      await opened.handle.close()
    }
  }

  /** Ends `ticket` (its reader tab closed); `false` when it was unknown or already revoked. */
  revoke(ticket: string): boolean {
    const grant = this.#grants.get(ticket)
    if (grant === undefined) return false
    this.#grants.delete(ticket)
    this.#tickets.delete(grant.file)
    return true
  }
}
