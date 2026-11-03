/**
 * Vault-id and note-name rules shared by main and the browser. Browser-safe: no `node:` imports
 * (Biome enforces it for `src/shared/**`), served to the page through `remix.json` `allowFiles`.
 *
 * A vault id is a POSIX path relative to the vault root: `work/todo.md` (note), `work` (folder),
 * `''` (the root). Note files end in lowercase `.md`; `.MD` is not a note extension.
 */

/** Folder id of a note or folder id (`work/todo.md` → `work`, `todo.md` → `''`). */
export function parentOf(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? '' : id.slice(0, slash)
}

/** Last segment of a vault id or an OS path (`/` or `\` separated, trailing separators ignored). */
export function lastSegment(id: string): string {
  return id.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '')
}

/** File name without `.md` (`work/todo.md` → `todo`); `.MD` and a bare `.md` are kept. */
export function noteStem(id: string): string {
  const name = lastSegment(id)
  return name.endsWith('.md') && name.length > 3 ? name.slice(0, -3) : name
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
