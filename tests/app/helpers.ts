import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { type AppRouter, createAppRouter } from '../../src/app/router.ts'
import type { FolderPickerOptions } from '../../src/app/services.ts'
import { createEventHub, type EventHub } from '../../src/main/events.ts'
import { SettingsStore } from '../../src/main/settings.ts'
import { VaultSession } from '../../src/main/vault-session.ts'
import type { LegacyStorageLocation } from '../../src/migrate/index.ts'
import type { Vault } from '../../src/vault/index.ts'

export const origin = 'http://app'

/** A router wired to fake Electron services, a temp settings file and a temp folder for vaults. */
export class TestApp {
  readonly dir: string
  readonly events: EventHub = createEventHub()
  readonly settings: SettingsStore
  readonly vaults: VaultSession
  readonly router: AppRouter
  /** Answers of the next folder pickers (`undefined` = cancelled). */
  readonly picks: Array<string | undefined> = []
  readonly pickerCalls: FolderPickerOptions[] = []
  readonly opened: string[] = []
  readonly revealed: string[] = []
  readonly legacyStorages: LegacyStorageLocation[] = []

  static async create(): Promise<TestApp> {
    return new TestApp(await mkdtemp(path.join(os.tmpdir(), 'boostnote-app-')))
  }

  private constructor(dir: string) {
    this.dir = dir
    this.settings = new SettingsStore(path.join(dir, 'userData', 'settings.json'))
    this.vaults = new VaultSession({ settings: this.settings, events: this.events, debounceMs: 20 })
    this.router = createAppRouter({
      events: this.events,
      vaults: this.vaults,
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
    })
  }

  get(href: string): Promise<Response> {
    return this.router.fetch(new URL(href, origin))
  }

  post(href: string, body: unknown = {}): Promise<Response> {
    return this.router.fetch(
      new Request(new URL(href, origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
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
