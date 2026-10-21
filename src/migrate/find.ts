import { readdir, readFile, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { isNodeError } from '../vault/errors.ts'

export interface LegacyStorageLocation {
  /** Absolute storage folder (contains `boostnote.json`). */
  path: string
  /** Display name the legacy app gave the storage, when known. */
  name?: string
}

export interface FindLegacyStoragesOptions {
  /** Defaults to `os.homedir()`. */
  home?: string
  /** Legacy app data folder; defaults to the platform's `<appData>/Boostnote`. */
  appDataDir?: string
}

/** Electron's `app.getPath('appData')`/Boostnote for the legacy app, without importing Electron. */
function defaultAppDataDir(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Boostnote')
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Boostnote')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Boostnote')
}

/**
 * Storage paths the legacy app saved in its Chromium localStorage (`storages` key: an array of
 * `{key, type, name, path, isOpen}`). The LevelDB files are scanned as text (Latin-1 and UTF-16LE,
 * the two encodings Chromium uses for localStorage values); every hit is verified afterwards.
 */
async function storagesFromLocalStorage(appDataDir: string): Promise<LegacyStorageLocation[]> {
  const dir = path.join(appDataDir, 'Local Storage', 'leveldb')
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => /\.(?:log|ldb)$/.test(name))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return []
    throw error
  }
  const found: LegacyStorageLocation[] = []
  const pattern = /"name":"((?:[^"\\]|\\.)*)","path":"((?:[^"\\]|\\.)*)"/g
  for (const name of names) {
    const bytes = await readFile(path.join(dir, name))
    for (const text of [bytes.toString('latin1'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')]) {
      for (const match of text.matchAll(pattern)) {
        try {
          // Both captures are JSON string bodies, so parsing them quoted yields strings.
          const storagePath: string = JSON.parse(`"${match[2]}"`)
          const storageName: string = JSON.parse(`"${match[1]}"`)
          found.push({ path: storagePath, ...(storageName ? { name: storageName } : {}) })
        } catch {
          // Not a complete JSON string (e.g. cut by a LevelDB block boundary).
        }
      }
    }
  }
  return found
}

async function isStorage(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, 'boostnote.json'))).isFile()
  } catch {
    return false
  }
}

/**
 * Legacy Boostnote storages on this machine: the default `~/Boostnote` the legacy app created on
 * first launch, plus any storage listed in the legacy app's settings. Only folders that still hold
 * a `boostnote.json` are returned.
 */
export async function findLegacyStorages(options: FindLegacyStoragesOptions = {}): Promise<LegacyStorageLocation[]> {
  const home = options.home ?? os.homedir()
  const candidates: LegacyStorageLocation[] = [
    { path: path.join(home, 'Boostnote') },
    ...(await storagesFromLocalStorage(options.appDataDir ?? defaultAppDataDir(home))),
  ]
  const result = new Map<string, LegacyStorageLocation>()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path)
    const known = result.get(resolved)
    if (known) {
      if (!known.name && candidate.name) known.name = candidate.name
      continue
    }
    if (await isStorage(resolved)) result.set(resolved, { ...candidate, path: resolved })
  }
  return [...result.values()]
}
