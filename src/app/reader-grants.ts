import { randomBytes } from 'node:crypto'

/**
 * Tickets for `.md` files outside every known vault, opened read-only in reader tabs. Main grants
 * one when such a file is opened from the OS (`VaultSession.takeOpenRequest`). The page gets the
 * ticket and the file's base name, never its path, and reads the file through
 * `GET /api/reader/:ticket` as often as it likes. Unlike `DropGrants` a ticket does not expire: it
 * lives until the reader tab closes (`revoke`) or the app quits. One file has at most one live ticket,
 * so opening it again finds its existing tab.
 */
export class ReaderGrants {
  readonly #paths = new Map<string, string>()
  readonly #tickets = new Map<string, string>()

  /** The live ticket of the file at real path `file`, granted now if it has none. */
  grant(file: string): string {
    const live = this.#tickets.get(file)
    if (live !== undefined) return live
    const ticket = randomBytes(24).toString('hex')
    this.#paths.set(ticket, file)
    this.#tickets.set(file, ticket)
    return ticket
  }

  /** The file behind `ticket`; `undefined` when unknown or revoked. */
  path(ticket: string): string | undefined {
    return this.#paths.get(ticket)
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
