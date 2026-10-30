import { realpath } from 'node:fs/promises'
import * as path from 'node:path'

import { HttpError } from '../app/http.ts'
import { ReaderGrants } from '../app/reader-grants.ts'
import { type ImportFilesReport, openVault, type Vault, VaultError } from '../vault/index.ts'
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
   * not `.md` (any case) are dropped, as are outside files that are not regular files
   * (`ReaderGrants.grant`). The real path is matched against the open vault, then the recent vaults,
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
    const open = this.#vault?.root
    const known = open === undefined ? this.recent : [open, ...this.recent]
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
   * A reader tab's "Open folder as vault": opens the folder of the file behind `ticket` (the path
   * main granted; the page sends only the ticket) as the vault and revokes the ticket. Answers the
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
      const vault = await this.#load(root).catch((error: unknown) => {
        // The folder went away meanwhile (`openVault`'s message would name its path).
        throw error instanceof VaultError && error.code === 'NOT_A_VAULT' ? gone() : error
      })
      // A parent folder swapped for a symlink while it loaded: that is another folder, not the granted one.
      if (vault.root !== root) {
        await vault.close()
        throw gone()
      }
      await this.#switchTo(vault, root)
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
   * A reader tab's "Add to vault…": imports the file behind `ticket` (the path main granted; the
   * page sends only the ticket) and its linked images into `folder` of the open vault, once per
   * ticket (`ReaderGrants.importOnce`, which ends the ticket when the import returns, also when it
   * skipped the file). `answer` runs on the import's report before the queue moves on, so what it
   * reads (the workspace) is the vault the file went into. Report sources are base names. Runs in
   * the vault queue, so a vault switch or a reader close never lands in the middle. Throws
   * `VaultError('NOT_FOUND')` when the ticket is unknown or revoked or its file is no longer a
   * regular file at its real path, and `HttpError(409, 'NO_VAULT')` without an open vault; the
   * ticket then stays as it was, as it does when the import throws (a bad or missing folder).
   */
  importReader<T>(ticket: string, folder: string, answer: (report: ImportFilesReport) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      const granted = this.readers.path(ticket)
      if (granted === undefined) throw new VaultError('NOT_FOUND', 'This file is no longer open; open it again')
      const vault = this.#vault
      if (!vault) throw new HttpError(409, 'NO_VAULT', 'Open a vault first, then add the file to it')
      const report = await this.readers.importOnce(ticket, (file, options) =>
        vault.importFiles([file], folder, options),
      )
      if (report === undefined) throw new VaultError('NOT_FOUND', `${path.basename(granted)} is gone; open it again`)
      return answer({
        ...report,
        notes: report.notes.map((note) => ({ ...note, source: path.basename(note.source) })),
        skipped: report.skipped.map((skip) => ({ ...skip, source: path.basename(skip.source) })),
      })
    })
  }

  /**
   * Opens (and starts watching) the folder at `root`, closing the previous vault. Throws
   * `VaultError('NOT_A_VAULT')` when the folder is missing; the previous vault then stays open.
   */
  open(root: string): Promise<Vault> {
    return this.#exclusive(async () => this.#switchTo(await this.#load(root), root))
  }

  #load(root: string): Promise<Vault> {
    return openVault(root, {
      watch: true,
      ...(this.#debounceMs === undefined ? {} : { debounceMs: this.#debounceMs }),
    })
  }

  /** Makes the loaded `vault` (opened from `root`) the open vault: first in Recent, and `lastVault`. */
  async #switchTo(vault: Vault, root: string): Promise<Vault> {
    await this.#closeCurrent()
    this.#vault = vault
    vault.subscribe((event) => this.#events.broadcast({ type: 'vault', change: event.type, id: event.id }))
    const others = this.recent.filter((item) => item !== vault.root && item !== root)
    this.#settings.update({ vaults: [vault.root, ...others].slice(0, MAX_RECENT_VAULTS), lastVault: vault.root })
    return vault
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
