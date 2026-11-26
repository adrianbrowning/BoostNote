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

/** Opening a `.md`/`.mdx` outside every known vault: a read-only reader tab, or its folder as the vault. */
export type OutsideFilePreference = 'reader' | 'vault'

/** Table width: `'line'` keeps the line width, `'full'` allows the whole pane, a number is px (400–2000). */
export type TableWidthPreference = 'line' | 'full' | number

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
  /** Maximum width of top-level tables in the reader pane and the live preview, exposed as `--table-max-width`; the workspace root never applies a px value below the line width. */
  tableWidth: TableWidthPreference
  spellcheck: boolean
  /** Ask before moving notes and folders to the Trash. */
  confirmDelete: boolean
  /** Electron accelerator that shows/hides the window from anywhere; `''` disables it. */
  globalHotkey: string
  /** Electron accelerator that shows the window with a new scratch note (Quick capture); `''` disables it. */
  captureHotkey: string
  /** Check GitHub for a newer release once a day (packaged app only). */
  checkUpdates: boolean
  /** Version whose update notice the user dismissed; `''` when none. */
  dismissedUpdate: string
  /** "Opening a .md or .mdx outside a vault" (`VaultSession.takeOpenRequest`). */
  outsideFile: OutsideFilePreference
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
  tableWidth: 'line',
  spellcheck: true,
  confirmDelete: true,
  globalHotkey: DEFAULT_HOTKEY,
  captureHotkey: '',
  checkUpdates: true,
  dismissedUpdate: '',
  outsideFile: 'reader',
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

/** One name per modifier Electron parses as the same flag (`CommandOrControl` presses Command on macOS only). */
function modifierName(part: string, platform: NodeJS.Platform): string {
  if (part === 'CommandOrControl' || part === 'CmdOrCtrl') return platform === 'darwin' ? 'Command' : 'Control'
  if (part === 'Cmd' || part === 'Super' || part === 'Meta') return 'Command'
  if (part === 'Ctrl') return 'Control'
  if (part === 'Option') return 'Alt'
  return part
}

/** Shifted characters Electron parses as their unshifted key plus Shift (`'+'` and `Plus` as `Shift+=`). */
const SHIFTED: Record<string, string> = {
  ')': '0',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ':': ';',
  '+': '=',
  PLUS: '=',
  '<': ',',
  _: '-',
  '>': '.',
  '?': '/',
  '~': '`',
  '{': '[',
  '}': ']',
  '|': '\\',
  '"': "'",
}

/** One name per key Electron parses as the same key code, in upper case, and whether it adds Shift. */
function keyName(key: string): { key: string; shift: boolean } {
  const upper = key.toUpperCase()
  if (upper === 'ESC') return { key: 'ESCAPE', shift: false }
  if (upper === 'ENTER') return { key: 'RETURN', shift: false }
  const base = SHIFTED[upper]
  return base === undefined ? { key: upper, shift: false } : { key: base, shift: true }
}

/**
 * Whether two accelerators press the same keys on `platform`: aliases Electron parses alike count as
 * one (`CommandOrControl` and `Command` on macOS or `Control` elsewhere; `Cmd`, `Super` and `Meta`;
 * `Option` and `Alt`; `Esc` and `Escape`; `Enter` and `Return`; a shifted character and its unshifted
 * key with Shift, such as `!` and `Shift+1` or `Plus`/`+` and `Shift+=`), modifiers in any order, the
 * key in any case. `''` (no hotkey) is never the same as anything.
 */
export function sameAccelerator(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === '' || b === '') return false
  const canonical = (value: string) => {
    const parts = value.split(/\+(?!$)/)
    const { key, shift } = keyName(parts.pop() ?? '')
    const modifiers = new Set(parts.map((part) => modifierName(part, platform)))
    if (shift) modifiers.add('Shift')
    return { key, modifiers }
  }
  const left = canonical(a)
  const right = canonical(b)
  return (
    left.key === right.key &&
    left.modifiers.size === right.modifiers.size &&
    [...left.modifiers].every((modifier) => right.modifiers.has(modifier))
  )
}

/** A global hotkey preference: an accelerator, or `''` for none. */
const isHotkey = (value: unknown): boolean => typeof value === 'string' && (value === '' || isAccelerator(value))

/** Validity of each preference value (also used to validate `POST /api/preferences`). */
export const UI_FIELDS: { [K in keyof Omit<UiPreferences, 'panes'>]: (value: unknown) => boolean } = {
  theme: (value) => value === 'system' || value === 'light' || value === 'dark',
  editorFont: (value) => typeof value === 'string' && value.length <= 200 && !/[;{}<>\\]|\/\*/.test(value),
  fontSize: intIn(10, 32),
  lineWidth: (value) => value === 0 || intIn(400, 2000)(value),
  tableWidth: (value) => value === 'line' || value === 'full' || intIn(400, 2000)(value),
  spellcheck: isBoolean,
  confirmDelete: isBoolean,
  globalHotkey: isHotkey,
  captureHotkey: isHotkey,
  checkUpdates: isBoolean,
  dismissedUpdate: (value) => typeof value === 'string' && value.length <= 64 && /^[0-9A-Za-z.+-]*$/.test(value),
  outsideFile: (value) => value === 'reader' || value === 'vault',
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
  /** The active vault: the one shown on start (and the CLI's default); absent when none is open. */
  lastVault?: string
  /** Every vault open when the app last ran, reopened on start. Absent in settings from before multi-vault. */
  openVaults?: string[]
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
  for (const key of ['vaults', 'openVaults'] as const) {
    const list = settings[key]
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) delete settings[key]
  }
  if (typeof settings.lastVault !== 'string') delete settings.lastVault
  if (settings.ui !== undefined) settings.ui = normalizeUi(settings.ui)
  return settings as Settings
}
