/** Folder and note-link helpers for vault ids in the browser (`work/todo.md`, folder `work`, root `''`). */
import { parentOf, safeDecode } from '../../../../shared/vault-ids.ts'

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
  const target = safeDecode(href.replace(/[?#].*$/, '').replace(/(\.md)\/$/i, '$1'))
  if (!/\.md$/i.test(target)) return undefined
  const segments: string[] = []
  for (const segment of [...parentOf(fromId).split('/'), ...target.replace(/\\/g, '/').split('/')]) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.pop() === undefined) return undefined
  }
  return segments.join('/')
}
