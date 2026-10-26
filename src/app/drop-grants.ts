import { randomBytes } from 'node:crypto'

/** How long a drop stays redeemable: the renderer redeems it right after the drop. */
const DROP_TTL_MS = 60_000

/**
 * One-time tickets for dragged-in files. Only the preload can turn a `File` into its path
 * (`webUtils.getPathForFile`), and it hands those paths to main over IPC, not to the page. The page
 * gets back a ticket it can redeem once at `POST /api/import-files`, so script in the page can import
 * only files the user gave the app (dropped, picked in a file dialog or pasted; a `new File(...)` has
 * no path), never an arbitrary path it makes up.
 */
export class DropGrants {
  readonly #grants = new Map<string, { paths: string[]; expires: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  grant(paths: readonly string[]): string {
    this.#prune()
    const ticket = randomBytes(24).toString('hex')
    this.#grants.set(ticket, { paths: [...paths], expires: this.#now() + DROP_TTL_MS })
    return ticket
  }

  /** The paths of `ticket`, once; `undefined` when unknown, already used or expired. */
  take(ticket: string): string[] | undefined {
    const grant = this.#grants.get(ticket)
    this.#grants.delete(ticket)
    return grant && grant.expires > this.#now() ? grant.paths : undefined
  }

  #prune(): void {
    const now = this.#now()
    for (const [ticket, grant] of this.#grants) if (grant.expires <= now) this.#grants.delete(ticket)
  }
}
