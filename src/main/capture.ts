import type { PreferenceServices } from '../app/services.ts'
import type { MenuEvent } from '../shared/commands.ts'
import { sameAccelerator, type UiPreferences } from './settings.ts'

export interface CaptureOptions {
  /** Shows and focuses the main window, creating it when there is none. */
  show: () => void
  /** Forwards a command to the renderer (main.ts broadcasts it as an SSE `menu` event). */
  send: (event: MenuEvent) => void
}

/**
 * The Quick capture hotkey (`ui.captureHotkey`): brings the window to the front, also from hidden,
 * minimised or in the background, and then asks the page for a new scratch note (New Scratch Note),
 * which opens focused. Unlike the show/hide hotkey it never hides the app. A capture made while no
 * page is connected is not queued.
 */
export function createCaptureHandler({ show, send }: CaptureOptions): () => void {
  return () => {
    show()
    send({ type: 'menu', command: 'new-scratch-note' })
  }
}

/**
 * Registers the stored hotkeys at startup: the show/hide hotkey, then the Quick capture hotkey unless it is
 * off. A capture hotkey that presses the same keys as the show/hide one (a hand-edited settings.json) is
 * not registered, so the show/hide hotkey keeps it; each one the OS refuses is reported through `warn`.
 */
export function registerStoredHotkeys(
  preferences: Pick<PreferenceServices, 'setHotkey' | 'setCaptureHotkey'>,
  ui: Pick<UiPreferences, 'globalHotkey' | 'captureHotkey'>,
  warn: (message: string) => void,
): void {
  if (!preferences.setHotkey(ui.globalHotkey)) warn(`Could not register the hotkey ${ui.globalHotkey}`)
  if (
    ui.captureHotkey !== '' &&
    (sameAccelerator(ui.captureHotkey, ui.globalHotkey) || !preferences.setCaptureHotkey(ui.captureHotkey))
  ) {
    warn(`Could not register the Quick capture hotkey ${ui.captureHotkey}`)
  }
}
