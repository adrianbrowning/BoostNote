/**
 * Vault storage core: plain `.md` notes with YAML frontmatter in a user-chosen folder. Pure Node,
 * no Electron imports; the router controllers (phase 4) are its only intended caller.
 */
export type { FolderConfig, TrashEntry, TrashKind, VaultConfig } from './config.ts'
export { VaultError, type VaultErrorCode } from './errors.ts'
export { type Frontmatter, type NoteText, parseNoteText, serializeNoteText } from './frontmatter.ts'
export { fallbackTitle, findH1, type Note, type NoteMeta } from './note.ts'
export { slugify } from './paths.ts'
export type { SearchHit } from './search.ts'
export {
  type CreateNoteOptions,
  type FolderNode,
  type OpenVaultOptions,
  openVault,
  type TrashItem,
  Vault,
  type VaultEvent,
  type VaultEventType,
  type WriteNoteInput,
} from './vault.ts'
