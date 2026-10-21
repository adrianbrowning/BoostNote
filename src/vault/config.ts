import * as path from 'node:path'
import { array, defaulted, enum_, object, optional, parseSafe, record, string } from 'remix/data-schema'

import { readJsonFile, writeJsonFile } from './files.ts'
import { CONFIG_DIR, TRASH_DIR } from './paths.ts'

export interface FolderConfig {
  color?: string
  [key: string]: unknown
}

/** `<vault>/.boostnote/config.json`. Unknown keys are preserved. */
export interface VaultConfig {
  version: 1
  /** Keyed by folder id (`work/projects`). */
  folders: Record<string, FolderConfig>
  /** Folder ids in display order; siblings not listed sort alphabetically after listed ones. */
  folderOrder?: string[]
  [key: string]: unknown
}

export type TrashKind = 'note' | 'folder'

/** One deleted note or folder. */
export interface TrashEntry {
  /** Path relative to `.trash/` (equals `originalPath` unless that name was already taken in the trash). */
  id: string
  kind: TrashKind
  /** Where `restore` puts it back (vault-relative). */
  originalPath: string
  /** ISO-8601. */
  deletedAt: string
  /** Folder settings (colours) of a deleted folder and its subfolders, keyed relative to the folder. */
  folders?: Record<string, FolderConfig>
}

/** `<vault>/.trash/.index.json`. */
export interface TrashIndex {
  version: 1
  entries: Record<string, Omit<TrashEntry, 'id'>>
}

export function configFile(root: string): string {
  return path.join(root, CONFIG_DIR, 'config.json')
}

export function trashIndexFile(root: string): string {
  return path.join(root, TRASH_DIR, '.index.json')
}

const FolderConfigSchema = object({ color: optional(string()) }, { unknownKeys: 'passthrough' })

const VaultConfigSchema = object(
  {
    folders: defaulted(record(string(), FolderConfigSchema), {}),
    folderOrder: optional(array(string())),
  },
  { unknownKeys: 'passthrough' },
)

const TrashIndexSchema = object({
  entries: record(
    string(),
    object({
      kind: defaulted(enum_(['note', 'folder']), 'note'),
      originalPath: string(),
      deletedAt: defaulted(string(), new Date(0).toISOString()),
      folders: optional(record(string(), FolderConfigSchema)),
    }),
  ),
})

/** Reads the vault config; a missing, unreadable or malformed file yields an empty config. */
export async function readConfig(root: string): Promise<VaultConfig> {
  const result = parseSafe(VaultConfigSchema, await readJsonFile(configFile(root)))
  if (!result.success) return { version: 1, folders: {} }
  const { folderOrder, ...rest } = result.value
  return { ...rest, version: 1, ...(folderOrder ? { folderOrder } : {}) }
}

export async function writeConfig(root: string, config: VaultConfig): Promise<void> {
  await writeJsonFile(configFile(root), config)
}

/** Reads the trash index; a missing or malformed file yields an empty index. */
export async function readTrashIndex(root: string): Promise<TrashIndex> {
  const result = parseSafe(TrashIndexSchema, await readJsonFile(trashIndexFile(root)))
  return { version: 1, entries: result.success ? result.value.entries : {} }
}

export async function writeTrashIndex(root: string, index: TrashIndex): Promise<void> {
  await writeJsonFile(trashIndexFile(root), index)
}
