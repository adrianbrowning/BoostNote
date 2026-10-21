import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { type AppRouter, createAppRouter } from '../../src/app/router.ts'
import type { FolderPickerOptions, PreferenceServices, SaveFileOptions } from '../../src/app/services.ts'
import { createEventHub, type EventHub } from '../../src/main/events.ts'
import { SettingsStore, type UiPreferences } from '../../src/main/settings.ts'
import type { UpdateInfo } from '../../src/main/updates.ts'
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
