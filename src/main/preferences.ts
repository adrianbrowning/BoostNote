import { globalShortcut, nativeTheme, session } from 'electron'

import type { PreferenceServices } from '../app/services.ts'

/**
 * One global hotkey's registration: `set` swaps the registered accelerator for another (`''` removes
 * it) and, when the OS refuses the new one, registers the previous one again.
 */
function hotkeyRegistration(callback: () => void) {
  let registered: string | undefined

  const register = (accelerator: string): boolean => {
    try {
      return globalShortcut.register(accelerator, callback)
    } catch {
      // Electron throws on accelerators it cannot parse.
      return false
    }
  }

  return {
    set(accelerator: string): boolean {
      if (accelerator === registered) return true
      const previous = registered
      if (previous) globalShortcut.unregister(previous)
      registered = undefined
      if (accelerator === '') return true
      if (register(accelerator)) {
        registered = accelerator
        return true
      }
      if (previous && register(previous)) registered = previous
      return false
    },
    get registered() {
      return registered
    },
  }
}

/**
 * Electron side of the preferences: `nativeTheme.themeSource` (which also drives the renderer's
 * `prefers-color-scheme`, so the page and the editor switch theme without a reload), the session
 * spellchecker, the global show/hide hotkey (`toggleWindow`) and the Quick capture hotkey (`capture`).
 */
export function createPreferenceServices(toggleWindow: () => void, capture: () => void): PreferenceServices {
  const hotkey = hotkeyRegistration(toggleWindow)
  const captureHotkey = hotkeyRegistration(capture)

  return {
    apply(ui) {
      nativeTheme.themeSource = ui.theme
      session.defaultSession.setSpellCheckerEnabled(ui.spellcheck)
    },
    setHotkey: (accelerator) => hotkey.set(accelerator),
    get registeredHotkey() {
      return hotkey.registered
    },
    setCaptureHotkey: (accelerator) => captureHotkey.set(accelerator),
    get registeredCaptureHotkey() {
      return captureHotkey.registered
    },
  }
}
