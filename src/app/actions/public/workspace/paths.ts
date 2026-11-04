/** Folder helpers for vault ids in the browser (`work/todo.md`, folder `work`, root `''`). */
import { parentOf } from '../../../../shared/vault-ids.ts'

/** `work/a` → `['work', 'work/a']`: the folder and its ancestors, root excluded. */
export function folderChain(folder: string): string[] {
  const chain: string[] = []
  for (let current = folder; current !== ''; current = parentOf(current)) chain.unshift(current)
  return chain
}
