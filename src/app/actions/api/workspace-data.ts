import * as path from 'node:path'

import type { MigrationReport } from '../../../migrate/index.ts'
import type { FolderNode, Note, NoteMeta, Vault } from '../../../vault/index.ts'
import type { AppServices } from '../../services.ts'
import type {
  FolderSummary,
  ImportSummary,
  JsonValue,
  NoteDocument,
  NoteSummary,
  WorkspaceData,
} from '../public/workspace/types.ts'

function summary({ id, folder, title, tags, starred, created, updated, excerpt }: NoteMeta): NoteSummary {
  return { id, folder, title, tags, starred, created, updated, excerpt }
}

/** `value` as the client sees it. The vault parses YAML with the core schema, so this is lossless except for `.nan`/`.inf`. */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue
}

export function toNoteDocument(note: Note): NoteDocument {
  return {
    ...summary(note),
    frontmatter: toJsonValue(note.frontmatter) as NoteDocument['frontmatter'],
    body: note.body,
    hash: note.hash,
  }
}

function folderSummary(node: FolderNode): FolderSummary {
  return {
    id: node.id,
    name: node.name,
    ...(node.color ? { color: node.color } : {}),
    folders: node.folders.map(folderSummary),
  }
}

export async function workspaceData(services: AppServices): Promise<WorkspaceData> {
  const vault: Vault | undefined = services.vaults.current
  const recent = services.vaults.recent.map((root) => ({ root, name: path.basename(root) }))
  if (!vault) return { vault: null, recent, tree: null, notes: [], trash: [] }
  const trash = await vault.listTrash()
  return {
    vault: { root: vault.root, name: path.basename(vault.root) },
    recent,
    tree: folderSummary(vault.tree()),
    notes: vault.index.all().map(summary),
    trash: trash.map(({ id, kind, originalPath, deletedAt, title }) => ({
      id,
      kind,
      originalPath,
      deletedAt,
      ...(title === undefined ? {} : { title }),
    })),
  }
}

export function importSummary(report: MigrationReport): ImportSummary {
  return {
    source: report.source,
    target: report.target,
    dryRun: report.dryRun,
    counts: report.counts,
    renamed: report.renamed.length,
    unresolvedAttachments: report.unresolvedAttachments.length,
    unresolvedLinks: report.unresolvedLinks.length,
    warnings: report.warnings,
    ...(report.dryRun ? {} : { reportPath: path.join(report.target, '.boostnote', 'migration-report.json') }),
  }
}
