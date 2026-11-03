/**
 * Vault-id and note-name rules shared by main and the browser. Browser-safe: no `node:` imports
 * (Biome enforces it for `src/shared/**`), served to the page through `remix.json` `allowFiles`.
 *
 * A vault id is a POSIX path relative to the vault root: `work/todo.md` (note), `work` (folder),
 * `''` (the root). Note files end in lowercase `.md`; `.MD` is not a note extension.
 */

/** What the index and lists know about a note; also the JSON the client gets for a note list. */
export interface NoteMeta {
  /** POSIX path relative to the vault root, e.g. `work/todo.md`. */
  id: string
  /** Folder id (`''` for the vault root). */
  folder: string
  title: string
  tags: string[]
  starred: boolean
  /** ISO-8601; frontmatter `created`, else the file's birth time. */
  created: string
  /** ISO-8601; frontmatter `updated`, else the file's modification time. */
  updated: string
  excerpt: string
}

/**
 * A fresh, mutable copy of the `NoteMeta` fields of `note` (a full note or document loses
 * `frontmatter`, `body`, `raw`, `hash`). Takes the vault's frozen query results too; `tags` is copied.
 */
export function toMeta(note: Readonly<Omit<NoteMeta, 'tags'>> & { readonly tags: readonly string[] }): NoteMeta {
  const { id, folder, title, tags, starred, created, updated, excerpt } = note
  return { id, folder, title, tags: [...tags], starred, created, updated, excerpt }
}

/** Folder id of a note or folder id (`work/todo.md` → `work`, `todo.md` → `''`). */
export function parentOf(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? '' : id.slice(0, slash)
}

/** Last segment of a vault id or an OS path (`/` or `\` separated, trailing separators ignored). */
export function lastSegment(id: string): string {
  return id.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
}

/** Whether a file name is a note's: it ends in lowercase `.md` and has a stem (`a.md`; not `.md`, `B.MD`). */
export function isNoteFileName(name: string): boolean {
  return name.endsWith('.md') && name.length > 3
}

/** File name without `.md` (`work/todo.md` → `todo`); `.MD` and a bare `.md` are kept. */
export function noteStem(id: string): string {
  const name = lastSegment(id)
  return isNoteFileName(name) ? name.slice(0, -3) : name
}

/** `folder` + `name` as a vault id (`''` is the root). */
export function joinId(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** A note's displayed name: its frontmatter `title` (a non-empty string, trimmed), else its file name stem. */
export function noteDisplayName(id: string, frontmatter: { readonly title?: unknown }): string {
  const title = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
  return title === '' ? noteStem(id) : title
}

/** `decodeURIComponent`, or `value` unchanged when it is not valid percent-encoding. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A link's path: its `?query` and `#fragment` cut off, then percent-decoded (`a%20b.md#x` → `a b.md`). */
export function linkPath(href: string): string {
  return safeDecode(href.replace(/[?#].*$/, ''))
}

/**
 * A scheme (`https:`, `mailto:`), an absolute or protocol-relative path (`/`, `//`) or a leading `\`.
 * Tested after decoding; a decoded leading `#` or `?` (`%23ideas.md`) is part of the file name.
 */
const NOT_RELATIVE = /^(?:[a-z][a-z\d+.-]*:|[/\\])/i

/**
 * Whether `href` is a relative link (`../work/todo.md#x`, `todo.assets/a.png`): its `linkPath` is not
 * empty (so not a raw `#anchor`, `?query` or `''`), has no NUL and does not start with a scheme, `/`,
 * `//` or `\`. Checked after decoding, so `%2Fetc%2Fx.md` is absolute too.
 */
export function isRelativeLink(href: string): boolean {
  const target = linkPath(href)
  return target !== '' && !target.includes('\0') && !NOT_RELATIVE.test(target)
}

/** A dot-file or dot-folder (`.trash`, `.boostnote`), not the `.`/`..` navigation segments. */
function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.') && segment !== '.' && segment !== '..'
}

/**
 * The vault id that the decoded relative path `relPath` names from folder `folder` (`''`: the
 * root, also a possible result). `\` is a separator like `/`, `.`, `..` and empty segments are
 * resolved (`a//b`, `note.md/`). `undefined` only when it climbs above the vault root; hidden
 * segments are kept (link rewriting re-bases links into dot-folders).
 */
export function normalizeLinkPath(folder: string, relPath: string): string | undefined {
  const segments: string[] = []
  for (const segment of [...folder.split('/'), ...relPath.replace(/\\/g, '/').split('/')]) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.pop() === undefined) return undefined
  }
  return segments.join('/')
}

/**
 * `normalizeLinkPath`, but `undefined` when `folder` or `relPath` has a hidden segment (`.trash/x.md`,
 * also `.trash/../x.md`), checked before `..` is resolved.
 */
export function resolveLinkPath(folder: string, relPath: string): string | undefined {
  if (`${folder}/${relPath}`.replace(/\\/g, '/').split('/').some(isHiddenSegment)) return undefined
  return normalizeLinkPath(folder, relPath)
}

/** Vault id `toId` as a relative path from folder `folder` (`a/b`, `a/c/d.md` → `../c/d.md`). */
export function relativeId(folder: string, toId: string): string {
  const from = folder === '' ? [] : folder.split('/')
  const to = toId.split('/')
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/')
}

/**
 * Whether `href` is a link to a note, whatever note it is in: a relative link whose path ends in a
 * note file name (lowercase `.md`; also the `note.md/#anchor` form copied from GitHub) with no
 * hidden segment. Whether it stays inside the vault depends on the note: see `resolveNoteLink`.
 */
export function isNoteLink(href: string): boolean {
  if (!isRelativeLink(href)) return false
  const segments = linkPath(href)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '')
  return !segments.some(isHiddenSegment) && isNoteFileName(segments.at(-1) ?? '')
}

/**
 * The note a link in note `fromId` opens (`../work/todo.md#x` → `work/todo.md`, `note.md/#x` →
 * `note.md`), or `undefined` for anything that is not a note link (`isNoteLink`) inside the vault.
 */
export function resolveNoteLink(fromId: string, href: string): string | undefined {
  return isNoteLink(href) ? resolveLinkPath(parentOf(fromId), linkPath(href)) : undefined
}
