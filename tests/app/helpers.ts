import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { type Client, createClient } from '../../src/app/actions/public/workspace/api.ts'
import type { TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import { DropGrants } from '../../src/app/drop-grants.ts'
import { type AppRouter, createAppRouter } from '../../src/app/router.ts'
import { ScratchStore } from '../../src/app/scratch-store.ts'
import type { FolderPickerOptions, PreferenceServices, SaveFileOptions } from '../../src/app/services.ts'
import { createEventHub, type EventHub } from '../../src/main/events.ts'
import { SettingsStore, type UiPreferences } from '../../src/main/settings.ts'
import type { UpdateInfo } from '../../src/main/updates.ts'
import { VaultSession } from '../../src/main/vault-session.ts'
import type { LegacyStorageLocation } from '../../src/migrate/index.ts'
import type { Vault } from '../../src/vault/index.ts'

export const origin = 'http://app'

/** A tab store that keeps nothing: every vault and the scratch tabs restore no tabs. */
export const noTabStore: TabStore = {
  load: () => null,
  save: () => {},
  loadScratch: () => null,
  saveScratch: () => {},
}

/** A router wired to fake Electron services, a temp settings file and a temp folder for vaults. */
export class TestApp {
  readonly dir: string
  readonly events: EventHub = createEventHub()
  readonly settings: SettingsStore
  readonly vaults: VaultSession
  /** `<dir>/userData/scratch`: the scratch notes' folder. */
  readonly scratchDir: string
  readonly router: AppRouter
  /** Answers of the next folder pickers (`undefined` = cancelled). */
  readonly picks: Array<string | undefined> = []
  readonly pickerCalls: FolderPickerOptions[] = []
  readonly opened: string[] = []
  readonly revealed: string[] = []
  readonly legacyStorages: LegacyStorageLocation[] = []
  /** Stands in for main's drop tickets: `drops.grant(paths)` is what the preload's IPC does. */
  readonly drops = new DropGrants()
  /** Preferences passed to `preferences.apply`, oldest first. */
  readonly applied: UiPreferences[] = []
  /** Accelerators the fake OS refuses to register. */
  readonly takenHotkeys: string[] = []
  /** Answers of the next save dialogs (`undefined` = cancelled). */
  readonly saves: Array<string | undefined> = []
  readonly saveCalls: SaveFileOptions[] = []
  /** Documents sent to the fake printer / PDF writer. */
  readonly printed: string[] = []
  readonly pdfs: string[] = []
  /** The fake `PreferenceServices` (`registeredHotkey` is what the fake OS has registered). */
  readonly preferences: { registeredHotkey: string | undefined } & PreferenceServices
  /** The fake `UpdateServices`: set `available` to simulate a found release; `automatic` records `setAutomatic` calls. */
  readonly updates = {
    available: undefined as UpdateInfo | undefined,
    automatic: [] as boolean[],
    setAutomatic(enabled: boolean) {
      this.automatic.push(enabled)
    },
  }

  static async create(): Promise<TestApp> {
    return new TestApp(await mkdtemp(path.join(os.tmpdir(), 'boostnote-app-')))
  }

  private constructor(dir: string) {
    this.dir = dir
    this.settings = new SettingsStore(path.join(dir, 'userData', 'settings.json'))
    this.vaults = new VaultSession({ settings: this.settings, events: this.events, debounceMs: 20 })
    this.scratchDir = path.join(dir, 'userData', 'scratch')
    const preferences = {
      registeredHotkey: undefined as string | undefined,
      apply: (ui: UiPreferences) => {
        this.applied.push(ui)
      },
      setHotkey: (accelerator: string) => {
        if (this.takenHotkeys.includes(accelerator)) return false
        preferences.registeredHotkey = accelerator === '' ? undefined : accelerator
        return true
      },
    }
    this.preferences = preferences
    this.router = createAppRouter({
      events: this.events,
      vaults: this.vaults,
      settings: this.settings,
      preferences,
      pickFolder: async (options) => {
        this.pickerCalls.push(options)
        return this.picks.shift()
      },
      openExternal: async (url) => {
        this.opened.push(url)
      },
      showItemInFolder: (fullPath) => {
        this.revealed.push(fullPath)
      },
      findLegacyStorages: async () => this.legacyStorages,
      drops: this.drops,
      scratch: new ScratchStore(this.scratchDir),
      updates: this.updates,
      exports: {
        saveFile: async (options) => {
          this.saveCalls.push(options)
          return this.saves.shift()
        },
        renderMermaid: async (source) => `<svg data-fake-mermaid="${source.length}"></svg>`,
        printToPdf: async (html) => {
          this.pdfs.push(html)
          return new TextEncoder().encode('%PDF-fake')
        },
        print: async (html) => {
          this.printed.push(html)
        },
      },
    })
  }

  /**
   * Like the page, requests name a vault (`?vault=`): the active one, unless `href` names one
   * itself. Pass `{ vault: null }` to send none.
   */
  get(href: string, options: { vault?: string | null } = {}): Promise<Response> {
    return this.router.fetch(this.#url(href, options.vault))
  }

  post(href: string, body: unknown = {}, options: { vault?: string | null } = {}): Promise<Response> {
    return this.router.fetch(
      new Request(this.#url(href, options.vault), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  /** A `fetch` for the page's API client (`createClient`): relative hrefs, the active vault added like `get`/`post`. */
  readonly fetch = (href: string, init?: RequestInit): Promise<Response> =>
    this.router.fetch(new Request(this.#url(href, undefined), init))

  #url(href: string, vault: string | null | undefined): URL {
    const url = new URL(href, origin)
    const root = vault === undefined ? this.vaults.current?.root : vault
    if (root && !url.searchParams.has('vault')) url.searchParams.set('vault', root)
    return url
  }

  /** Creates `<dir>/<name>` and opens it as the vault. */
  async openVault(name = 'vault'): Promise<Vault> {
    const root = path.join(this.dir, name)
    await mkdir(root, { recursive: true })
    return this.vaults.open(root)
  }

  async close(): Promise<void> {
    await this.vaults.dispose()
    this.events.close()
    await rm(this.dir, { recursive: true, force: true })
  }
}

/** Writes `files` into a new folder `name` of the test app's temp dir. */
export async function folderWith(app: TestApp, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(app.dir, name)
  for (const [id, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, id)), { recursive: true })
    await writeFile(path.join(dir, id), body)
  }
  return dir
}

/** Whether note `id`'s file is on disk under vault folder `root`. */
export const exists = (root: string, id: string): Promise<boolean> =>
  access(path.join(root, id)).then(
    () => true,
    () => false,
  )

/** A request `HeldClient.hold` keeps waiting. */
export interface HeldRequest {
  /** What the hold's `match` named it. */
  id: string
  /** Lets the request go on, or fails it with `failure` as its error message. */
  release(failure?: string): void
}

/**
 * An API client over `app`'s router whose requests the test can hold, fail or answer as gone. Like the page's
 * client, a request names the vault active when it is sent, even when it is held past a vault switch.
 */
export interface HeldClient {
  client: Client
  /**
   * Requests that `match` names (by the id it returns; `undefined`: not held) wait in `held` until released.
   * With `answered`, the router answers them at once and the response is held until released, so it returns late with
   * the vault as it was when the request came.
   * With `once`, only the first request `match` names is held; later ones go on as if `hold(null)` had been called.
   * `null` holds none from now on; requests already held stay in `held`.
   */
  hold(match: ((url: URL) => string | undefined) | null, options?: { answered?: boolean; once?: boolean }): void
  /** Held requests, oldest first (emptied by each `hold` with a match). */
  readonly held: HeldRequest[]
  /** Requests it matches fail at once with "Disk full" (`null`: none). */
  fail: ((url: URL) => boolean) | null
  /** Note ids whose reads answer `404 NOT_FOUND`, as if deleted on disk after the vault listed them. */
  readonly gone: Set<string>
}

export function heldClient(app: TestApp): HeldClient {
  let match: ((url: URL) => string | undefined) | null = null
  let answered = false
  let once = false
  const held: HeldRequest[] = []
  const gone = new Set<string>()
  const controls: HeldClient = {
    client: createClient(async (href, init) => {
      const url = new URL(href, origin)
      const root = app.vaults.current?.root
      if (root && !url.searchParams.has('vault')) url.searchParams.set('vault', root)
      if (controls.fail?.(url)) throw new Error('Disk full')
      const id = match?.(url)
      if (id !== undefined && once) match = null
      const wait = async () => {
        if (id === undefined) return
        const { promise, resolve, reject } = Promise.withResolvers<void>()
        held.push({ id, release: (failure) => (failure === undefined ? resolve() : reject(new Error(failure))) })
        await promise
      }
      const late = answered
      if (!late) await wait()
      if (url.pathname === '/api/notes/read' && gone.has(url.searchParams.get('id') ?? '')) {
        return Response.json({ error: 'NOT_FOUND', message: 'Note not found' }, { status: 404 })
      }
      const response = await app.fetch(`${url.pathname}${url.search}`, init)
      if (late) await wait()
      return response
    }),
    hold(next, options = {}) {
      match = next
      answered = options.answered ?? false
      once = options.once ?? false
      if (next) held.length = 0
    },
    held,
    fail: null,
    gone,
  }
  return controls
}
