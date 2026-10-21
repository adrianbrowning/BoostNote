import { openVault, type Vault, VaultError } from '../vault/index.ts'
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
