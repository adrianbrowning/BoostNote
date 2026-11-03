import * as path from 'node:path'

import type { MigrationReport } from '../../../migrate/index.ts'
import { toMeta } from '../../../shared/vault-ids.ts'
import { type FolderNode, type Note, toJsonValue, type Vault } from '../../../vault/index.ts'
import { HttpError } from '../../http.ts'
import type { AppServices } from '../../services.ts'
import type { FolderSummary, ImportSummary, NoteDocument, WorkspaceData } from '../public/workspace/types.ts'

export function toNoteDocument(note: Note): NoteDocument {
  return {
    ...toMeta(note),
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

/**
 * The lists of the open vault at `root` (default: the active vault), plus every open vault and the
 * recent list. A `root` that is not open is a `409 NO_VAULT`.
 */
export async function workspaceData(services: AppServices, root?: string): Promise<WorkspaceData> {
  const vault: Vault | undefined = root === undefined ? services.vaults.current : services.vaults.get(root)
  if (root !== undefined && !vault) throw new HttpError(409, 'NO_VAULT', `This vault is not open: ${root}`)
  const recent = services.vaults.recent.map((item) => ({ root: item, name: path.basename(item) }))
  const open = services.vaults.all.map((item) => ({ root: item.root, name: path.basename(item.root) }))
  if (!vault) return { vault: null, open, recent, tree: null, notes: [], trash: [] }
  const [trash, tree, notes] = await Promise.all([vault.listTrash(), vault.tree(), vault.notes()])
  return {
    vault: { root: vault.root, name: path.basename(vault.root) },
    open,
    recent,
    tree: folderSummary(tree),
    notes: notes.map((meta) => toMeta(meta)),
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
