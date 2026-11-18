import type { LinkMove } from './types.ts'

/** What the app does after a note was renamed, moved or restored: the link-update moves to offer and the notice to show. */
export interface RelocateOutcome {
  moves: LinkMove[]
  notice: string | undefined
}

/**
 * Turns a rename, move (`from` set) or restore (no `from`) result into the link-update moves and
 * the notice text. When an extension-case twin kept the shared assets folder, the move leaves
 * links into it alone (`assets: false`) and the notice names the folder. `done` is the notice's
 * lead text ("Moved to …"); without it the notice is only the assets warning, if any.
 */
export function linkMovesAfterRelocate(options: {
  from?: string
  result: { id: string; assetsLeftBehind?: string }
  done?: string
}): RelocateOutcome {
  const { from, result, done } = options
  const left = result.assetsLeftBehind
  const moves: LinkMove[] =
    from === undefined ? [] : [{ from, to: result.id, kind: 'note', ...(left ? { assets: false } : {}) }]
  const warning = left
    ? `The assets folder ${left} stayed in place for the note with the same name; this note's links into it may break.`
    : undefined
  const parts = [done, warning].filter((part) => part !== undefined)
  return { moves, notice: parts.length === 0 ? undefined : parts.join('. ') }
}
