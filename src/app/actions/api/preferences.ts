import { PANE_FIELDS, type PaneLayout, sameAccelerator, UI_FIELDS, type UiPatch } from '../../../main/settings.ts'
import { isUpdateShown } from '../../../main/updates.ts'
import { HttpError } from '../../http.ts'
import type { AppServices } from '../../services.ts'
import type { PreferencesState } from '../public/workspace/types.ts'

export function preferencesState(services: AppServices): PreferencesState {
  const ui = services.settings.ui
  return {
    ui,
    hotkeyRegistered: ui.globalHotkey !== '' && services.preferences.registeredHotkey === ui.globalHotkey,
    captureHotkeyRegistered:
      ui.captureHotkey !== '' && services.preferences.registeredCaptureHotkey === ui.captureHotkey,
    update: isUpdateShown(services.updates.available, ui.dismissedUpdate) ? services.updates.available : null,
  }
}

/** The `409` of a hotkey the OS refused to register. */
function refused(accelerator: string): HttpError {
  return new HttpError(
    409,
    'HOTKEY_UNAVAILABLE',
    `${accelerator} could not be registered. Another app may already use it.`,
  )
}

function invalid(name: string): HttpError {
  return new HttpError(400, 'BAD_REQUEST', `Invalid value for "${name}"`)
}

/** A `POST /api/preferences` body: known keys with valid values only, anything else is a `400`. */
export function parseUiPatch(body: Record<string, unknown>): UiPatch {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'panes') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('panes')
      const panes: Partial<Record<keyof PaneLayout, unknown>> = {}
      for (const [paneKey, paneValue] of Object.entries(value)) {
        if (!(paneKey in PANE_FIELDS)) throw new HttpError(400, 'BAD_REQUEST', `Unknown preference "panes.${paneKey}"`)
        const field = paneKey as keyof PaneLayout
        if (!PANE_FIELDS[field](paneValue)) throw invalid(`panes.${paneKey}`)
        panes[field] = paneValue
      }
      patch.panes = panes
    } else if (key in UI_FIELDS) {
      if (!UI_FIELDS[key as keyof typeof UI_FIELDS](value)) throw invalid(key)
      patch[key] = value
    } else {
      throw new HttpError(400, 'BAD_REQUEST', `Unknown preference "${key}"`)
    }
  }
  // Every key and value was checked against `UI_FIELDS`/`PANE_FIELDS` above.
  return patch as UiPatch
}

/**
 * Merges `patch` into the stored preferences and applies them. A new show/hide or Quick capture
 * hotkey is registered first; when the OS refuses it nothing is stored and the previous hotkeys stay
 * registered (`409 HOTKEY_UNAVAILABLE`). The two hotkeys never share an accelerator, aliases included
 * (`CommandOrControl+Shift+Space` and `Command+Shift+Space` on macOS): a hotkey in the patch equal to
 * the other hotkey, current or as patched, is refused the same way before anything is registered.
 */
export function savePreferences(services: AppServices, patch: UiPatch): PreferencesState {
  const current = services.settings.ui
  const next = { ...current, ...patch, panes: { ...current.panes, ...patch.panes } }
  const { preferences } = services
  if (
    patch.captureHotkey !== undefined &&
    (sameAccelerator(patch.captureHotkey, current.globalHotkey) ||
      sameAccelerator(patch.captureHotkey, next.globalHotkey))
  ) {
    throw new HttpError(409, 'HOTKEY_UNAVAILABLE', `${patch.captureHotkey} is already the show/hide hotkey.`)
  }
  if (
    patch.globalHotkey !== undefined &&
    (sameAccelerator(patch.globalHotkey, current.captureHotkey) ||
      sameAccelerator(patch.globalHotkey, next.captureHotkey))
  ) {
    throw new HttpError(409, 'HOTKEY_UNAVAILABLE', `${patch.globalHotkey} is already the Quick capture hotkey.`)
  }
  const previousHotkey = preferences.registeredHotkey
  const hotkeyChanged = patch.globalHotkey !== undefined && patch.globalHotkey !== previousHotkey
  if (hotkeyChanged && !preferences.setHotkey(next.globalHotkey)) throw refused(next.globalHotkey)
  if (
    patch.captureHotkey !== undefined &&
    patch.captureHotkey !== preferences.registeredCaptureHotkey &&
    !preferences.setCaptureHotkey(patch.captureHotkey)
  ) {
    if (hotkeyChanged) preferences.setHotkey(previousHotkey ?? '')
    throw refused(patch.captureHotkey)
  }
  services.settings.update({ ui: next })
  services.preferences.apply(next)
  if (patch.checkUpdates !== undefined) services.updates.setAutomatic(patch.checkUpdates)
  return preferencesState(services)
}
