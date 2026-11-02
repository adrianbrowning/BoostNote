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
 * folder) a read-only reader: a `ReaderGrants` ticket and the file's base name, never its path. With
 * the preference `outsideFile: 'vault'` such a file is a note of its own folder as the vault instead,
 * unless its name can be no note there (a dot-name or upper-case `.MD`), which still opens read-only.
 * An upper-case `.MD` file inside a known vault is no note of it either and opens read-only too.
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
 * The open vaults of the app and the vault lists in `settings.json`. Several vaults can be open at
 * once (each watched, its external changes forwarded to the SSE hub as `vault` events naming its
 * root); one of them is active: the one the window shows. `openVaults` is reopened on the next
 * start with `lastVault` active again, and opening a vault moves it to the front of `vaults`
 * (Recent). Plain Node, no Electron.
 */
export class VaultSession {
  readonly #settings: SettingsStore
  readonly #events: EventHub
  readonly #debounceMs: number | undefined
  /** Open vaults by root, in the order they were opened. */
  readonly #vaults = new Map<string, Vault>()
  #active: Vault | undefined
  #queue: Promise<unknown> = Promise.resolve()
  readonly #openRequests: string[] = []
  /** Tickets of the outside files opened in reader tabs (`GET /api/reader/:ticket`). */
  readonly readers = new ReaderGrants()

  constructor(options: VaultSessionOptions) {
    this.#settings = options.settings
    this.#events = options.events
    this.#debounceMs = options.debounceMs
  }

  /** The active vault, if any vault is open. */
  get current(): Vault | undefined {
    return this.#active
  }

  /** Every open vault, in the order they were opened. */
  get all(): Vault[] {
    return [...this.#vaults.values()]
  }

  /** The open vault whose (real) root is `root`. */
  get(root: string): Vault | undefined {
    return this.#vaults.get(root)
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
   * not `.md` (any case) are dropped, as are outside files that are not regular files
   * (`ReaderGrants.grant`). The real path is matched against the open vaults, then the recent vaults,
   * whatever the `outsideFile` preference.
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
   * `*.assets` folder of that vault is no note of it and counts as an outside file (a reader, or its
   * folder as the vault with `outsideFile: 'vault'`, as before reader tabs existed).
   */
  async #requestFor(real: string): Promise<OpenRequest | undefined> {
    const known = [...this.#vaults.keys(), ...this.recent]
    for (const root of known) {
      const realRoot = await realpath(root).catch(() => undefined)
      if (realRoot === undefined || !isInside(realRoot, real)) continue
      const id = path.relative(realRoot, real).split(path.sep).join('/')
      if (isNoteId(id)) return { kind: 'note', vault: realRoot, id }
      break
    }
    const name = path.basename(real)
    if (this.#settings.ui.outsideFile === 'vault' && isNoteId(name)) {
      return { kind: 'note', vault: path.dirname(real), id: name }
    }
    const ticket = await this.readers.grant(real)
    return ticket === undefined ? undefined : { kind: 'external', ticket, name }
  }

  /**
   * A reader tab's "Open folder as vault": makes the folder of the file behind `ticket` (the path
   * main granted; the page sends only the ticket) the active vault, opening it unless it is open
   * already, and revokes the ticket. Answers the
   * file's note id there. Throws `VaultError('NOT_FOUND')` when the ticket is unknown or revoked
   * (also while this waited its turn behind another vault switch), its file is no longer a regular
   * file at its real path, or the folder resolved to another folder while it loaded (a parent swapped
   * for a symlink), and `VaultError('INVALID_PATH')` when its name can be no note (a
   * dot-name, upper-case `.MD`); the vault and the ticket then stay as they were. Runs in the vault
   * queue, as `closeReader` does, so a close either comes first (and this opens nothing) or finds
   * the ticket revoked. Messages name the file's base name at most.
   */
  openReaderFolder(ticket: string): Promise<string> {
    return this.#exclusive(async () => {
      const granted = this.readers.path(ticket)
      if (granted === undefined) throw new VaultError('NOT_FOUND', 'This file is no longer open; open it again')
      const id = path.basename(granted)
      if (!isNoteId(id)) {
        throw new VaultError(
          'INVALID_PATH',
          `${id} cannot be a note: notes end in .md (lower case) and do not start with a dot`,
        )
      }
      const gone = () => new VaultError('NOT_FOUND', `${id} is gone; open it again`)
      if ((await this.readers.regularPath(ticket)) === undefined) throw gone()
      const root = path.dirname(granted)
      let vault = this.#vaults.get(root)
      if (!vault) {
        const loaded = await this.#load(root).catch((error: unknown) => {
          // The folder went away meanwhile (`openVault`'s message would name its path).
          throw error instanceof VaultError && error.code === 'NOT_A_VAULT' ? gone() : error
        })
        // A parent folder swapped for a symlink while it loaded: that is another folder, not the granted one.
        if (loaded.root !== root) {
          await loaded.close()
          throw gone()
        }
        vault = this.#register(loaded)
      }
      this.#activate(vault, root)
      this.readers.revoke(ticket)
      return id
    })
  }

  /**
   * A reader tab closed: revokes its ticket (`false` when unknown or already revoked). Queued with
   * the vault switches, so it never lands in the middle of `openReaderFolder`.
   */
  closeReader(ticket: string): Promise<boolean> {
    return this.#exclusive(async () => this.readers.revoke(ticket))
  }

  /**
   * Makes the vault at `root` active, opening (and starting to watch) it unless it is open already;
   * other open vaults stay open. Throws `VaultError('NOT_A_VAULT')` when the folder is missing; the
   * active vault then stays as it was.
   */
  open(root: string): Promise<Vault> {
    return this.#exclusive(async () => {
      const vault = this.#vaults.get(await realpath(root).catch(() => root)) ?? this.#register(await this.#load(root))
      return this.#activate(vault, root)
    })
  }

  /** Makes the open `vault` (opened from `root`) active and first in Recent. */
  #activate(vault: Vault, root: string): Vault {
    this.#active = vault
    const others = this.recent.filter((item) => item !== vault.root && item !== root)
    this.#settings.update({ vaults: [vault.root, ...others].slice(0, MAX_RECENT_VAULTS) })
    this.#saveOpen()
    return vault
  }

  /**
   * Closes the open vault at `root` (nothing when it is not open). Closing the active vault makes
   * the most recently used of the others active; closing the last one leaves none.
   */
  close(root: string): Promise<void> {
    return this.#exclusive(async () => {
      const vault = this.#vaults.get(await realpath(root).catch(() => root))
      if (!vault) return
      this.#vaults.delete(vault.root)
      await vault.close()
      if (this.#active === vault) {
        const next = this.recent.find((item) => this.#vaults.has(item))
        this.#active = next === undefined ? this.all.at(-1) : this.#vaults.get(next)
      }
      this.#saveOpen()
    })
  }

  /**
   * Reopens the vaults that were open (app start), `lastVault` active. Settings from before
   * multi-vault have only `lastVault`. Folders that no longer exist are dropped from the lists, and
   * Recent entries written as another spelling of an open vault (a symlinked path) become its root,
   * so the vault menu never lists one vault twice.
   */
  restore(): Promise<Vault | undefined> {
    return this.#exclusive(async () => {
      const { openVaults, lastVault } = this.#settings.read()
      const renamed = new Map<string, string>()
      for (const root of openVaults ?? (lastVault ? [lastVault] : [])) {
        try {
          const vault = this.#vaults.get(root) ?? this.#register(await this.#load(root))
          if (vault.root !== root) renamed.set(root, vault.root)
        } catch (error) {
          if (!(error instanceof VaultError)) throw error
        }
      }
      if (renamed.size > 0) {
        this.#settings.update({ vaults: [...new Set(this.recent.map((item) => renamed.get(item) ?? item))] })
      }
      const last = lastVault && (await realpath(lastVault).catch(() => lastVault))
      this.#active = (last && this.#vaults.get(last)) || this.all[0]
      this.#saveOpen()
      return this.#active
    })
  }

  /** Removes `root` from the recent list. */
  forget(root: string): void {
    this.#settings.update({ vaults: this.recent.filter((item) => item !== root) })
  }

  /** Stops watching every vault without touching the settings (app quit). */
  dispose(): Promise<void> {
    return this.#exclusive(async () => {
      const vaults = this.all
      this.#vaults.clear()
      this.#active = undefined
      await Promise.all(vaults.map((vault) => vault.close()))
    })
  }

  #load(root: string): Promise<Vault> {
    return openVault(root, {
      watch: true,
      ...(this.#debounceMs === undefined ? {} : { debounceMs: this.#debounceMs }),
    })
  }

  /** Adds the loaded `vault` to the open vaults and forwards its changes to the SSE hub. */
  #register(vault: Vault): Vault {
    this.#vaults.set(vault.root, vault)
    vault.subscribe((event) =>
      this.#events.broadcast({ type: 'vault', root: vault.root, change: event.type, id: event.id }),
    )
    return vault
  }

  /** `openVaults` and `lastVault` follow the open vaults and the active one. */
  #saveOpen(): void {
    this.#settings.update({ openVaults: [...this.#vaults.keys()], lastVault: this.#active?.root })
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
