import type { MenuCommand } from './types.ts'

/**
 * Accelerators of the app's commands, shown and handled by the native menu (`src/main/menu.ts`).
 * The renderer reserves the same combinations (`isReservedShortcut`) so the editor never acts on a
 * key the menu also acts on: each shortcut fires exactly once, through the menu.
 */
export const ACCELERATORS = {
  'new-note': 'CmdOrCtrl+N',
  'new-folder': 'CmdOrCtrl+Shift+N',
  'open-folder': 'CmdOrCtrl+O',
  'reveal-note': 'CmdOrCtrl+Alt+R',
  'close-tab': 'CmdOrCtrl+W',
  'reopen-tab': 'CmdOrCtrl+Shift+T',
  'next-tab': 'Ctrl+Tab',
  'previous-tab': 'Ctrl+Shift+Tab',
  'go-back': 'CmdOrCtrl+[',
  'go-forward': 'CmdOrCtrl+]',
  'toggle-sidebar': 'CmdOrCtrl+Shift+E',
  'toggle-note-list': 'CmdOrCtrl+Shift+J',
  'toggle-properties': 'CmdOrCtrl+Shift+P',
  preferences: 'CmdOrCtrl+,',
  find: 'CmdOrCtrl+F',
  print: 'CmdOrCtrl+P',
} satisfies Partial<Record<MenuCommand, string>>

/** `select-tab`: Cmd/Ctrl+1–8 pick a tab, Cmd/Ctrl+9 the last one. */
export const TAB_ACCELERATORS = Array.from({ length: 9 }, (_, index) => `CmdOrCtrl+${index + 1}`)

const CODES: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', Tab: 'Tab' }

const RESERVED = [...Object.values(ACCELERATORS), ...TAB_ACCELERATORS].map((accelerator) => {
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
