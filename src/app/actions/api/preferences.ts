import { PANE_FIELDS, type PaneLayout, UI_FIELDS, type UiPatch } from '../../../main/settings.ts'
import { isUpdateShown } from '../../../main/updates.ts'
import { HttpError } from '../../http.ts'
import type { AppServices } from '../../services.ts'
import type { PreferencesState } from '../public/workspace/types.ts'

export function preferencesState(services: AppServices): PreferencesState {
  const ui = services.settings.ui
  return {
    ui,
    hotkeyRegistered: ui.globalHotkey !== '' && services.preferences.registeredHotkey === ui.globalHotkey,
    update: isUpdateShown(services.updates.available, ui.dismissedUpdate) ? services.updates.available : null,
  }
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
 * Merges `patch` into the stored preferences and applies them. A new global hotkey is registered
 * first; when the OS refuses it nothing is stored (`409 HOTKEY_UNAVAILABLE`).
 */
export function savePreferences(services: AppServices, patch: UiPatch): PreferencesState {
  const current = services.settings.ui
  const next = { ...current, ...patch, panes: { ...current.panes, ...patch.panes } }
  if (patch.globalHotkey !== undefined && patch.globalHotkey !== services.preferences.registeredHotkey) {
    if (!services.preferences.setHotkey(patch.globalHotkey)) {
      throw new HttpError(
        409,
        'HOTKEY_UNAVAILABLE',
        `${patch.globalHotkey} could not be registered. Another app may already use it.`,
      )
    }
  }
  services.settings.update({ ui: next })
  services.preferences.apply(next)
  if (patch.checkUpdates !== undefined) services.updates.setAutomatic(patch.checkUpdates)
  return preferencesState(services)
}
