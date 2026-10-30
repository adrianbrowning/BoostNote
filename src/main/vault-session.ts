import { realpath } from 'node:fs/promises'
import * as path from 'node:path'

import { ReaderGrants } from '../app/reader-grants.ts'
import { openVault, type Vault, VaultError } from '../vault/index.ts'
import { isInside, noteSegments } from '../vault/paths.ts'
import type { EventHub } from './events.ts'
import type { SettingsStore } from './settings.ts'

/** How many vaults "Recent" remembers. */
export const MAX_RECENT_VAULTS = 10

export interface VaultSessionOptions {
  settings: SettingsStore
  events: EventHub
  /** Watcher debounce passed to `openVault` (default: the vault's own default). */
  debounceMs?: number
}

/**
 * A markdown file opened from the OS (Finder, Explorer, argv): a note of the open vault or a recent
 * vault when the file is a note of it, else (outside every known vault, or in a hidden or `*.assets`
 * folder) a read-only reader: a `ReaderGrants` ticket and the file's base name, never its path.
 */
export type OpenRequest =
  | {
      kind: 'note'
      /** Real path of the vault root. */
      vault: string
      /** Note id inside that vault (`work/plan.md`). */
      id: string
    }
  | { kind: 'external'; ticket: string; name: string }

/**
 * The open vault of the app (at most one) and the vault list in `settings.json`. Opening a vault
 * makes it `lastVault` (reopened on the next start) and moves it to the front of `vaults`; its
 * external changes are forwarded to the SSE hub as `vault` events. Plain Node, no Electron.
 */
export class VaultSession {
  readonly #settings: SettingsStore
  readonly #events: EventHub
  readonly #debounceMs: number | undefined
  #vault: Vault | undefined
  #queue: Promise<unknown> = Promise.resolve()
  readonly #openRequests: string[] = []
  /** Tickets of the outside files opened in reader tabs (`GET /api/reader/:ticket`). */
  readonly readers = new ReaderGrants()

  constructor(options: VaultSessionOptions) {
    this.#settings = options.settings
    this.#events = options.events
    this.#debounceMs = options.debounceMs
  }

  /** The open vault, if any. */
  get current(): Vault | undefined {
    return this.#vault
  }

  /** Vault folders the user opened, most recent first. */
  get recent(): string[] {
    return this.#settings.read().vaults ?? []
  }

  /**
   * Queues a `.md` file the OS asked the app to open and tells the workspace (SSE `open-request`).
   * The workspace takes the queue (`takeOpenRequest` until `undefined`) after hydrating or on the
   * event: a note switches vaults when needed and opens in a tab, an outside file opens in a reader
   * tab. A request made before the window exists is not lost and a second quick request does not
   * replace the first.
   */
  requestOpen(file: string): void {
    this.#openRequests.push(path.resolve(file))
    this.#events.broadcast({ type: 'open-request' })
  }

  /**
   * The oldest queued request, removed; `undefined` when the queue is empty. Files that are gone or
   * not `.md` are dropped, as are outside files that are not regular files (`ReaderGrants.grant`).
   * The real path is matched against the open vault, then the recent vaults.
   */
  async takeOpenRequest(): Promise<OpenRequest | undefined> {
    for (let file = this.#openRequests.shift(); file !== undefined; file = this.#openRequests.shift()) {
      const real = await realpath(file).catch(() => undefined)
      if (real === undefined || !/\.md$/i.test(real)) continue
      const request = await this.#requestFor(real)
      if (request !== undefined) return request
    }
    return undefined
  }

  /**
   * The first known vault (open, then recent) whose real root holds `real`. A file in a hidden or
   * `*.assets` folder of that vault is no note of it and opens like an outside file, in a reader.
   */
  async #requestFor(real: string): Promise<OpenRequest | undefined> {
    const open = this.#vault?.root
    const known = open === undefined ? this.recent : [open, ...this.recent]
    for (const root of known) {
      const realRoot = await realpath(root).catch(() => undefined)
      if (realRoot === undefined || !isInside(realRoot, real)) continue
      const id = path.relative(realRoot, real).split(path.sep).join('/')
      if (isNoteId(id)) return { kind: 'note', vault: realRoot, id }
      break
    }
    const ticket = await this.readers.grant(real)
    return ticket === undefined ? undefined : { kind: 'external', ticket, name: path.basename(real) }
  }

  /**
   * Opens (and starts watching) the folder at `root`, closing the previous vault. Throws
   * `VaultError('NOT_A_VAULT')` when the folder is missing; the previous vault then stays open.
   */
  open(root: string): Promise<Vault> {
    return this.#exclusive(async () => {
      const vault = await openVault(root, {
        watch: true,
        ...(this.#debounceMs === undefined ? {} : { debounceMs: this.#debounceMs }),
      })
      await this.#closeCurrent()
      this.#vault = vault
      vault.subscribe((event) => this.#events.broadcast({ type: 'vault', change: event.type, id: event.id }))
      const others = this.recent.filter((item) => item !== vault.root && item !== root)
      this.#settings.update({ vaults: [vault.root, ...others].slice(0, MAX_RECENT_VAULTS), lastVault: vault.root })
      return vault
    })
  }

  /** Closes the open vault; nothing is reopened on the next start. */
  close(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#closeCurrent()
      this.#settings.update({ lastVault: undefined })
    })
  }

  /** Reopens `lastVault` (app start). A vault folder that no longer exists is forgotten as `lastVault`. */
  async restore(): Promise<Vault | undefined> {
    const last = this.#settings.read().lastVault
    if (!last) return undefined
    try {
      return await this.open(last)
    } catch (error) {
      if (error instanceof VaultError) {
        this.#settings.update({ lastVault: undefined })
        return undefined
      }
      throw error
    }
  }

  /** Removes `root` from the recent list. */
  forget(root: string): void {
    const settings = this.#settings.read()
    this.#settings.update({
      vaults: this.recent.filter((item) => item !== root),
      ...(settings.lastVault === root && this.#vault?.root !== root ? { lastVault: undefined } : {}),
    })
  }

  /** Stops watching without touching the settings (app quit). */
  dispose(): Promise<void> {
    return this.#exclusive(() => this.#closeCurrent())
  }

  async #closeCurrent(): Promise<void> {
    const vault = this.#vault
    this.#vault = undefined
    await vault?.close()
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

function isNoteId(id: string): boolean {
  try {
    noteSegments(id)
    return true
  } catch (error) {
    if (error instanceof VaultError) return false
    throw error
  }
}
