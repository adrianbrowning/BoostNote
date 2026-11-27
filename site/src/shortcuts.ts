import { COMMANDS, type CommandRow, commandLabel } from '../../src/shared/commands.ts'

/** The two ways the guide writes a shortcut: macOS, and Windows and Linux (they share one). */
export type KeyStyle = 'mac' | 'pc'

export interface ShortcutRow {
  /** The menu item's name, with the per-platform names when they differ. */
  command: string
  mac: readonly string[]
  pc: readonly string[]
}

/** macOS writes modifiers as symbols, in this order: ⌃ ⌥ ⇧ ⌘. */
const MAC_MODIFIERS: Readonly<Record<string, string>> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd']

/**
 * The keys of Electron accelerator `accelerator`, one per key cap. `CmdOrCtrl` is ⌘ on macOS and
 * Ctrl on Windows and Linux; a plain `Ctrl` (as in `Ctrl+Tab`) is Ctrl everywhere.
 */
export function acceleratorKeys(accelerator: string, style: KeyStyle): string[] {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((part) => {
    if (part === 'CmdOrCtrl' || part === 'CommandOrControl') return style === 'mac' ? 'Cmd' : 'Ctrl'
    if (part === 'Control') return 'Ctrl'
    if (part === 'Option') return 'Alt'
    return part
  })
  if (style === 'pc') return [...modifiers, key]
  const ordered = MAC_ORDER.filter((modifier) => modifiers.includes(modifier))
  return [...ordered.map((modifier) => MAC_MODIFIERS[modifier] ?? modifier), key]
}

const PLATFORM_NAMES = [
  ['darwin', 'macOS'],
  ['win32', 'Windows'],
  ['linux', 'Linux'],
] as const

/** `label` as the guide names it: one name, or each name with the platforms that use it. */
function commandName(label: CommandRow['label']): string {
  const platforms = new Map<string, string[]>()
  for (const [platform, name] of PLATFORM_NAMES) {
    const shown = commandLabel(label, platform)
    platforms.set(shown, [...(platforms.get(shown) ?? []), name])
  }
  if (platforms.size === 1) return [...platforms.keys()][0] ?? ''
  return [...platforms].map(([shown, names]) => `${shown} (${names.join(' and ')})`).join(' / ')
}

/** One row per menu shortcut of the app, in menu-table order (`src/shared/commands.ts`). */
export function shortcutRows(): ShortcutRow[] {
  return (COMMANDS as readonly CommandRow[]).flatMap((row): ShortcutRow[] => {
    const name = commandName(row.label)
    if (row.tabs) {
      return row.tabs.map((tab) => ({
        command: `${name} › ${tab.label}`,
        mac: acceleratorKeys(tab.accelerator, 'mac'),
        pc: acceleratorKeys(tab.accelerator, 'pc'),
      }))
    }
    if (!row.accelerator) return []
    return [{ command: name, mac: acceleratorKeys(row.accelerator, 'mac'), pc: acceleratorKeys(row.accelerator, 'pc') }]
  })
}
