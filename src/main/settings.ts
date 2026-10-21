import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { PANE_LIMITS } from '../app/actions/public/workspace/layout.ts'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export type ThemePreference = 'system' | 'light' | 'dark'

/** Pane layout of the workspace window. */
export interface PaneLayout {
  sidebarWidth: number
  listWidth: number
  sidebarCollapsed: boolean
  listCollapsed: boolean
  propertiesOpen: boolean
}

/** The `ui` section of `settings.json`: preferences and window layout. */
export interface UiPreferences {
  theme: ThemePreference
  /** CSS `font-family` of the editor; `''` uses the UI font. */
  editorFont: string
  /** Editor font size in px. */
  fontSize: number
  /** Maximum width of the editor text column in px; `0` fills the pane. */
  lineWidth: number
  spellcheck: boolean
  /** Ask before moving notes and folders to the Trash. */
  confirmDelete: boolean
  /** Electron accelerator that shows/hides the window from anywhere; `''` disables it. */
  globalHotkey: string
  panes: PaneLayout
}

/** A `POST /api/preferences` body: any subset of the preferences (and of `panes`). */
export type UiPatch = Partial<Omit<UiPreferences, 'panes'>> & { panes?: Partial<PaneLayout> }

/** No conflict with the OS on macOS, Windows or GNOME/KDE, nor with any in-app shortcut. */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

export const DEFAULT_UI: UiPreferences = {
  theme: 'system',
  editorFont: '',
  fontSize: 16,
  lineWidth: 736,
  spellcheck: true,
  confirmDelete: true,
  globalHotkey: DEFAULT_HOTKEY,
  panes: { sidebarWidth: 220, listWidth: 300, sidebarCollapsed: false, listCollapsed: false, propertiesOpen: false },
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const intIn = (min: number, max: number) => (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const MODIFIERS: Record<string, true> = {
  Command: true,
  Cmd: true,
  Control: true,
  Ctrl: true,
  CommandOrControl: true,
  CmdOrCtrl: true,
  Alt: true,
  Option: true,
  AltGr: true,
  Shift: true,
  Super: true,
  Meta: true,
}
const NAMED_KEYS =
  /^(?:F(?:[1-9]|1\d|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|num[0-9]|numdec|numadd|numsub|nummult|numdiv)$/
const CHARACTER_KEY = /^[A-Z0-9)!@#$%^&*(:;<=,_\->.?/~`{}[\]|\\"']$/

/**
 * An Electron accelerator for a global hotkey: modifiers, then one key. At least one modifier other
 * than Shift is required (except for function keys), so typing can never trigger it.
 */
export function isAccelerator(value: string): boolean {
  const parts = value.split(/\+(?!$)/)
  const key = parts.pop()
  if (key === undefined || !(NAMED_KEYS.test(key) || CHARACTER_KEY.test(key.toUpperCase()))) return false
  if (new Set(parts).size !== parts.length || !parts.every((part) => MODIFIERS[part])) return false
  return /^F\d/.test(key) || parts.some((part) => part !== 'Shift')
}

/** Validity of each preference value (also used to validate `POST /api/preferences`). */
export const UI_FIELDS: { [K in keyof Omit<UiPreferences, 'panes'>]: (value: unknown) => boolean } = {
  theme: (value) => value === 'system' || value === 'light' || value === 'dark',
  editorFont: (value) => typeof value === 'string' && value.length <= 200 && !/[;{}<>]/.test(value),
  fontSize: intIn(10, 32),
  lineWidth: (value) => value === 0 || intIn(400, 2000)(value),
  spellcheck: isBoolean,
  confirmDelete: isBoolean,
  globalHotkey: (value) => typeof value === 'string' && (value === '' || isAccelerator(value)),
}

export const PANE_FIELDS: { [K in keyof PaneLayout]: (value: unknown) => boolean } = {
  sidebarWidth: intIn(...PANE_LIMITS.sidebarWidth),
  listWidth: intIn(...PANE_LIMITS.listWidth),
  sidebarCollapsed: isBoolean,
  listCollapsed: isBoolean,
  propertiesOpen: isBoolean,
}

/** Keeps the valid fields of `value` (a parsed JSON object, or anything), defaults for the rest. */
function pick<T extends object>(
  value: unknown,
  fields: { [K in keyof T]: (value: unknown) => boolean },
  defaults: T,
): T {
  const source: Partial<Record<keyof T, unknown>> = typeof value === 'object' && value !== null ? value : {}
  const result = { ...defaults }
  for (const key of Object.keys(fields) as Array<keyof T>) {
    const candidate = source[key]
    if (fields[key](candidate)) result[key] = candidate as T[keyof T]
  }
  return result
}

/** The stored `ui` section with every missing or invalid value replaced by its default. */
export function normalizeUi(value: unknown): UiPreferences {
  const { panes: _panes, ...defaults } = DEFAULT_UI
  return {
    ...pick(value, UI_FIELDS, defaults),
    panes: pick(
      typeof value === 'object' && value !== null && 'panes' in value ? value.panes : undefined,
      PANE_FIELDS,
      DEFAULT_UI.panes,
    ),
  }
}

/** App-level settings stored in `userData/settings.json`. */
export interface Settings {
  windowBounds?: WindowBounds
  /** Vault folders the user opened, most recent first. */
  vaults?: string[]
  /** The vault reopened on start; absent after "Close Vault". */
  lastVault?: string
  /** Preferences and layout; read through `normalizeUi`. */
  ui?: UiPreferences
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

  /** The UI preferences, defaults filled in. */
  get ui(): UiPreferences {
    return normalizeUi(this.read().ui)
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
  const settings: Record<string, unknown> = { ...value }
  if (!Array.isArray(settings.vaults) || !settings.vaults.every((item) => typeof item === 'string')) {
    delete settings.vaults
  }
  if (typeof settings.lastVault !== 'string') delete settings.lastVault
  if (settings.ui !== undefined) settings.ui = normalizeUi(settings.ui)
  return settings as Settings
}
