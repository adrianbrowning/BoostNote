/**
 * Vault storage core: plain `.md` notes with YAML frontmatter in a user-chosen folder. Pure Node,
 * no Electron imports; the router controllers (phase 4) are its only intended caller.
 */
export type { FolderConfig, TrashEntry, TrashKind, VaultConfig } from './config.ts'
export { VaultError, type VaultErrorCode } from './errors.ts'
export { type Frontmatter, type NoteText, parseNoteText, serializeNoteText } from './frontmatter.ts'
export { DEFAULT_IMPORT_LIMITS, type ImportFilesReport, type ImportLimits } from './import-files.ts'
export type { LinkMove } from './links.ts'
export { type Note, type NoteMeta, noteTitle } from './note.ts'
export { noteFileName } from './paths.ts'
export type { SearchHit } from './search.ts'
export {
  type CreateNoteOptions,
  type FolderNode,
  type LinkUpdate,
  type LinkUpdateReport,
  type OpenVaultOptions,
  openVault,
  type TitleRename,
  type TitleRenamePlan,
  type TitleRenameReport,
  type TitleRenameSkip,
  type TrashItem,
  Vault,
  type VaultEvent,
  type VaultEventType,
  type WriteNoteInput,
} from './vault.ts'
