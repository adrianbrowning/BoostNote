/** POSIX-path helpers for vault ids in the browser (`work/todo.md`, folder `work`, root `''`). */

/** Folder id of a note or folder id (`''` at the root). */
export function parentOf(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? '' : id.slice(0, slash)
}

/** `work/a` → `['work', 'work/a']`: the folder and its ancestors, root excluded. */
export function folderChain(folder: string): string[] {
  const chain: string[] = []
  for (let current = folder; current !== ''; current = parentOf(current)) chain.unshift(current)
  return chain
}

/**
 * The vault id a relative markdown link in note `fromId` points to (`../work/todo.md#x` →
 * `work/todo.md`), or `undefined` for anything that is not a relative `.md` link inside the vault.
 */
export function resolveNoteLink(fromId: string, href: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return undefined
  // `note.md/#anchor` (as in notes copied from GitHub) opens `note.md`.
  let target = href.replace(/[?#].*$/, '').replace(/(\.md)\/$/i, '$1')
  try {
    target = decodeURIComponent(target)
  } catch {
    // Keep the raw text when it isn't valid percent-encoding.
  }
  if (!/\.md$/i.test(target)) return undefined
  const segments: string[] = []
  for (const segment of [...parentOf(fromId).split('/'), ...target.replace(/\\/g, '/').split('/')]) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.pop() === undefined) return undefined
  }
  return segments.join('/')
}
