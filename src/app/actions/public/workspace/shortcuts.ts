import { COMMANDS } from '../../../../shared/commands.ts'

const CODES: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', Tab: 'Tab' }

/**
 * Every accelerator in the command table (`select-tab`'s numbered ones included). The native menu
 * handles them, so the renderer reserves them: each shortcut fires exactly once, through the menu.
 */
const RESERVED = COMMANDS.flatMap((command): readonly string[] =>
  'tabAccelerators' in command ? command.tabAccelerators : 'accelerator' in command ? [command.accelerator] : [],
).map((accelerator) => {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  return {
    code: CODES[key] ?? (/^\d$/.test(key) ? `Digit${key}` : `Key${key}`),
    mod: parts.includes('CmdOrCtrl'),
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
  }
})

/** Whether `event` is one of the menu's accelerators (`CmdOrCtrl` is ⌘ on macOS, Ctrl elsewhere). */
export function isReservedShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  return RESERVED.some((shortcut) => {
    const meta = shortcut.mod && isMac
    const ctrl = shortcut.ctrl || (shortcut.mod && !isMac)
    return (
      event.code === shortcut.code &&
      event.metaKey === meta &&
      event.ctrlKey === ctrl &&
      event.altKey === shortcut.alt &&
      event.shiftKey === shortcut.shift
    )
  })
}
