import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import CSON from 'cson-parser'
import {
  any,
  array,
  boolean,
  defaulted,
  enum_,
  type InferOutput,
  nullable,
  number,
  object,
  optional,
  parseSafe,
  string,
  union,
} from 'remix/data-schema'

import { isNodeError } from '../vault/errors.ts'

/** Thrown when the source is not a legacy storage or the target is unsuitable. */
export class MigrationError extends Error {
  readonly code: 'NOT_A_LEGACY_STORAGE' | 'TARGET_NOT_EMPTY' | 'INVALID_TARGET'

  constructor(code: MigrationError['code'], message: string) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

const looseString = () => optional(nullable(string()))
const date = () => optional(nullable(union([string(), number()])))

const BoostnoteJson = object({
  folders: array(object({ key: string(), name: looseString(), color: looseString() })),
  version: optional(nullable(union([string(), number()]))),
})

const LegacyNoteSchema = object({
  type: enum_(['MARKDOWN_NOTE', 'SNIPPET_NOTE']),
  folder: defaulted(string(), ''),
  title: looseString(),
  content: looseString(),
  description: looseString(),
  snippets: optional(nullable(array(object({ name: looseString(), mode: looseString(), content: looseString() })))),
  tags: optional(nullable(array(any()))),
  isStarred: optional(nullable(boolean())),
  isTrashed: optional(nullable(boolean())),
  isPinned: optional(nullable(boolean())),
  createdAt: date(),
  updatedAt: date(),
})

export interface LegacyFolder {
  key: string
  name: string
  color?: string
}

export type LegacyNote = InferOutput<typeof LegacyNoteSchema> & {
  /** File name without `.cson` (`notes/<key>.cson`), the id legacy `:note:` links use. */
  key: string
  /** Modification time of the source file; date fallback for notes without `createdAt`/`updatedAt`. */
  fileTime: Date
}

export interface LegacyStorage {
  path: string
  folders: LegacyFolder[]
  notes: LegacyNote[]
  /** Notes that could not be read, with the reason. */
  skipped: Array<{ file: string; reason: string }>
}

function describeIssues(issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }>): string {
  return issues.map((issue) => `${issue.path?.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')
}

/** CSON is a superset of JSON; the legacy app read every file with `@rokt33r/season` (cson-parser). */
async function readCson(file: string): Promise<unknown> {
  return CSON.parse(await readFile(file, 'utf8'))
}

/**
 * Reads a legacy Boostnote storage without modifying it: `boostnote.json` (folders) and
 * `notes/*.cson`. Pre-1.0 storages (notes in `<folderKey>/data.json`) are read too.
 */
export async function readLegacyStorage(storagePath: string): Promise<LegacyStorage> {
  const jsonFile = path.join(storagePath, 'boostnote.json')
  let raw: unknown
  try {
    raw = await readCson(jsonFile)
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      throw new MigrationError('NOT_A_LEGACY_STORAGE', `No boostnote.json in ${storagePath}`)
    }
    throw new MigrationError('NOT_A_LEGACY_STORAGE', `Cannot parse ${jsonFile}: ${String(error)}`)
  }
  const parsed = parseSafe(BoostnoteJson, raw)
  if (!parsed.success) {
    throw new MigrationError('NOT_A_LEGACY_STORAGE', `Invalid ${jsonFile}: ${describeIssues(parsed.issues)}`)
  }
  const folders = parsed.value.folders.map((folder) => ({
    key: folder.key,
    name: folder.name ?? '',
    ...(folder.color ? { color: folder.color } : {}),
  }))
  const storage: LegacyStorage = { path: storagePath, folders, notes: [], skipped: [] }

  const accept = (file: string, key: string, value: unknown, fileTime: Date) => {
    const note = parseSafe(LegacyNoteSchema, value)
    if (note.success) storage.notes.push({ ...note.value, key, fileTime })
    else storage.skipped.push({ file, reason: describeIssues(note.issues) })
  }

  const notesDir = path.join(storagePath, 'notes')
  let names: string[] = []
  try {
    names = (await readdir(notesDir)).filter((name) => name.endsWith('.cson')).sort()
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  for (const name of names) {
    const file = path.join(notesDir, name)
    try {
      accept(file, path.basename(name, '.cson'), await readCson(file), (await stat(file)).mtime)
    } catch (error) {
      // CSON syntax errors span several lines (source excerpt + caret); the first one says it all.
      storage.skipped.push({ file, reason: String(error).split('\n')[0] ?? String(error) })
    }
  }

  if (String(parsed.value.version ?? '') !== '1.0' && names.length === 0) {
    // Storage format before 1.0: every folder directory holds a data.json with its notes.
    for (const folder of folders) {
      const file = path.join(storagePath, folder.key, 'data.json')
      let data: unknown
      try {
        data = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) storage.skipped.push({ file, reason: String(error) })
        continue
      }
      const list = parseSafe(
        object({ notes: array(object({ key: optional(string()) }, { unknownKeys: 'passthrough' })) }),
        data,
      )
      if (!list.success) {
        storage.skipped.push({ file, reason: describeIssues(list.issues) })
        continue
      }
      const fileTime = (await stat(file)).mtime
      list.value.notes.forEach((note, index) => {
        accept(file, note.key ?? `${folder.key}-${index}`, { folder: folder.key, ...note }, fileTime)
      })
    }
  }
  return storage
}
