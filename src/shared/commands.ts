/**
 * The application's commands: one row each. The native menu (`src/main/menu.ts`) builds its items
 * from these rows, and the renderer reserves their accelerators (`isReservedShortcut`) so the editor
 * never acts on a key the menu also acts on: each shortcut fires exactly once, through the menu.
 * Data only (no Electron, no DOM), so main and renderer both import it.
 */

/** A label that differs per platform: `process.platform` keys, `default` for the rest. */
export type PlatformLabel = { readonly default: string } & Readonly<Partial<Record<NodeJS.Platform, string>>>

interface CommandRowBase {
  readonly id: string
  readonly label: string | PlatformLabel
  /** Whether the workspace ignores the command until a vault is open. */
  readonly needsVault: boolean
}

/** A submenu item of a row with `tabs`: one per accelerator. */
export interface TabItem {
  readonly label: string
  /** Electron accelerator; `CmdOrCtrl` is ⌘ on macOS, Ctrl elsewhere. */
  readonly accelerator: string
}

/**
 * A command row: one menu item with an optional accelerator, or a submenu with one item per
 * accelerator (Window › Select Tab), never both.
 */
export type CommandRow =
  | (CommandRowBase & {
      /** Electron accelerator; `CmdOrCtrl` is ⌘ on macOS, Ctrl elsewhere. */
      readonly accelerator?: string
      readonly tabs?: never
    })
  | (CommandRowBase & { readonly tabs: readonly TabItem[]; readonly accelerator?: never })

export const COMMANDS = [
  { id: 'new-note', label: 'New Note', accelerator: 'CmdOrCtrl+N', needsVault: true },
  { id: 'new-folder', label: 'New Folder…', accelerator: 'CmdOrCtrl+Shift+N', needsVault: true },
  { id: 'open-folder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', needsVault: false },
  { id: 'import-storage', label: 'Import Boostnote Storage…', needsVault: false },
  /** The bulk rename of slug-named (imported) notes. */
  { id: 'rename-from-titles', label: 'Rename Files From Titles…', needsVault: true },
  /** File › Export: the open note, the selected folder or the vault. */
  { id: 'export-html', label: 'Note as HTML…', needsVault: true },
  { id: 'export-pdf', label: 'Note as PDF…', needsVault: true },
  { id: 'export-markdown', label: 'Note as Markdown…', needsVault: true },
  { id: 'export-folder', label: 'Folder as HTML…', needsVault: true },
  { id: 'export-vault', label: 'Vault as HTML…', needsVault: true },
  { id: 'print', label: 'Print…', accelerator: 'CmdOrCtrl+P', needsVault: true },
  {
    id: 'reveal-note',
    label: { darwin: 'Reveal in Finder', win32: 'Show in Explorer', default: 'Show in Folder' },
    accelerator: 'CmdOrCtrl+Alt+R',
    needsVault: true,
  },
  { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', needsVault: false },
  { id: 'reopen-tab', label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', needsVault: true },
  {
    id: 'preferences',
    label: { darwin: 'Settings…', default: 'Preferences…' },
    accelerator: 'CmdOrCtrl+,',
    needsVault: false,
  },
  { id: 'find', label: 'Find…', accelerator: 'CmdOrCtrl+F', needsVault: true },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+E', needsVault: false },
  { id: 'toggle-note-list', label: 'Toggle Note List', accelerator: 'CmdOrCtrl+Shift+J', needsVault: false },
  { id: 'toggle-properties', label: 'Toggle Properties', accelerator: 'CmdOrCtrl+Shift+P', needsVault: false },
  { id: 'go-back', label: 'Back', accelerator: 'CmdOrCtrl+[', needsVault: true },
  { id: 'go-forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', needsVault: true },
  { id: 'next-tab', label: 'Next Tab', accelerator: 'Ctrl+Tab', needsVault: false },
  { id: 'previous-tab', label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', needsVault: false },
  /**
   * Window › Select Tab: one item per accelerator. `index` is 0–7 for tabs 1–8 and `-1` for the
   * last tab (Cmd/Ctrl+9).
   */
  {
    id: 'select-tab',
    label: 'Select Tab',
    tabs: [
      { label: 'Tab 1', accelerator: 'CmdOrCtrl+1' },
      { label: 'Tab 2', accelerator: 'CmdOrCtrl+2' },
      { label: 'Tab 3', accelerator: 'CmdOrCtrl+3' },
      { label: 'Tab 4', accelerator: 'CmdOrCtrl+4' },
      { label: 'Tab 5', accelerator: 'CmdOrCtrl+5' },
      { label: 'Tab 6', accelerator: 'CmdOrCtrl+6' },
      { label: 'Tab 7', accelerator: 'CmdOrCtrl+7' },
      { label: 'Tab 8', accelerator: 'CmdOrCtrl+8' },
      { label: 'Last Tab', accelerator: 'CmdOrCtrl+9' },
    ],
    needsVault: false,
  },
] as const satisfies readonly CommandRow[]

/** Menu commands the workspace performs (it knows the selected folder, the open note and the tabs). */
export type MenuCommand = (typeof COMMANDS)[number]['id']

/**
 * The SSE `menu` event main sends when a command's menu item is clicked. Only `select-tab` carries
 * `index` (0–7 for tabs 1–8, `-1` for the last tab), and it always does.
 */
export type MenuEvent = {
  [C in MenuCommand]: C extends 'select-tab'
    ? { type: 'menu'; command: C; index: number }
    : { type: 'menu'; command: C; index?: never }
}[MenuCommand]

/** The row of command `id`, typed as that command's row. Throws on an id the table lacks. */
export function commandRow<C extends MenuCommand>(id: C): Extract<(typeof COMMANDS)[number], { id: C }> {
  const row = COMMANDS.find((command) => command.id === id)
  if (!row) throw new Error(`Unknown command: ${id}`)
  return row as Extract<(typeof COMMANDS)[number], { id: C }>
}

/** Every accelerator `row` binds: its own, or its submenu's. */
export function commandAccelerators(row: CommandRow): readonly string[] {
  return row.tabs ? row.tabs.map((tab) => tab.accelerator) : row.accelerator ? [row.accelerator] : []
}

/** The label to show on `platform`. */
export function commandLabel(label: string | PlatformLabel, platform: NodeJS.Platform): string {
  return typeof label === 'string' ? label : (label[platform] ?? label.default)
}
