import { realpath } from 'node:fs/promises'
import * as path from 'node:path'

import { openVault, type Vault, VaultError } from '../vault/index.ts'
import { isInside } from '../vault/paths.ts'
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
 * A markdown file opened from the OS (Finder, Explorer, argv), as a note to open: in the open vault
 * or a recent vault when the file lies inside one, else in the file's own folder as the vault.
 */
export interface OpenRequest {
  kind: 'note'
  /** Real path of the vault root. */
  vault: string
  /** Note id inside that vault (`work/plan.md`). */
  id: string
}

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
   * event, saves the open note, switches vaults and opens the note, so a request made before the
   * window exists is not lost and a second quick request does not replace the first.
   */
  requestOpen(file: string): void {
    this.#openRequests.push(path.resolve(file))
    this.#events.broadcast({ type: 'open-request' })
  }

  /**
   * The oldest queued request, removed; `undefined` when the queue is empty. Files that are gone or
   * not `.md` are dropped. The real path is matched against the open vault, then the recent vaults.
   */
  async takeOpenRequest(): Promise<OpenRequest | undefined> {
    for (let file = this.#openRequests.shift(); file !== undefined; file = this.#openRequests.shift()) {
      const real = await realpath(file).catch(() => undefined)
      if (real !== undefined && /\.md$/i.test(real)) return this.#noteFor(real)
    }
    return undefined
  }

  async #noteFor(real: string): Promise<OpenRequest> {
    const open = this.#vault?.root
    const known = open === undefined ? this.recent : [open, ...this.recent]
    let vault = path.dirname(real)
    for (const root of known) {
      const realRoot = await realpath(root).catch(() => undefined)
      if (realRoot !== undefined && isInside(realRoot, real)) {
        vault = realRoot
        break
      }
    }
    return { kind: 'note', vault, id: path.relative(vault, real).split(path.sep).join('/') }
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
