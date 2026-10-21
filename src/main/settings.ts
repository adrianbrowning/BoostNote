import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

/** App-level settings stored in `userData/settings.json`. Later phases add vaults and UI prefs. */
export interface Settings {
  windowBounds?: WindowBounds
}

let cache: Settings | undefined

export function readSettings(): Settings {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) as Settings
  } catch {
    cache = {}
  }
  return cache
}

/** Merges `patch` into the settings and writes them atomically (temp file + rename). */
export function updateSettings(patch: Partial<Settings>): void {
  cache = { ...readSettings(), ...patch }
  const file = path.join(app.getPath('userData'), 'settings.json')
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`)
  renameSync(temp, file)
}
