import { globalShortcut, nativeTheme, session } from 'electron'

import type { PreferenceServices } from '../app/services.ts'

/**
 * Electron side of the preferences: `nativeTheme.themeSource` (which also drives the renderer's
 * `prefers-color-scheme`, so the page and the editor switch theme without a reload), the session
 * spellchecker and the global show/hide hotkey.
 */
export function createPreferenceServices(toggleWindow: () => void): PreferenceServices {
  let registered: string | undefined

  const register = (accelerator: string): boolean => {
    try {
      return globalShortcut.register(accelerator, toggleWindow)
    } catch {
      // Electron throws on accelerators it cannot parse.
      return false
    }
  }

  return {
    apply(ui) {
      nativeTheme.themeSource = ui.theme
      session.defaultSession.setSpellCheckerEnabled(ui.spellcheck)
    },
    setHotkey(accelerator) {
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
    get registeredHotkey() {
      return registered
    },
  }
}
