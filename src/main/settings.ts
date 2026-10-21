import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

/** App-level settings stored in `userData/settings.json`. Phase 5 adds UI preferences. */
export interface Settings {
  windowBounds?: WindowBounds
  /** Vault folders the user opened, most recent first. */
  vaults?: string[]
  /** The vault reopened on start; absent after "Close Vault". */
  lastVault?: string
}

/**
 * Reads and writes the settings file. Plain Node (the main process passes the `userData` path) so it
 * can be unit tested. Unreadable or malformed files count as empty settings.
 */
export class SettingsStore {
  readonly file: string
  #cache: Settings | undefined

  constructor(file: string) {
    this.file = file
  }

  read(): Settings {
    if (this.#cache) return this.#cache
    try {
      this.#cache = sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      this.#cache = {}
    }
    return this.#cache
  }

  /** Merges `patch` into the settings (an `undefined` value removes the key) and writes them atomically. */
  update(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.read(), ...patch }
    for (const key of Object.keys(next) as Array<keyof Settings>) if (next[key] === undefined) delete next[key]
    this.#cache = next
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, this.file)
    return next
  }
}

function sanitize(value: unknown): Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const settings = { ...value } as Record<string, unknown>
  if (!Array.isArray(settings.vaults) || !settings.vaults.every((item) => typeof item === 'string')) {
    delete settings.vaults
  }
  if (typeof settings.lastVault !== 'string') delete settings.lastVault
  return settings as Settings
}
