import type { LinkMove } from './types.ts'

/** What the app does after a note was renamed, moved or restored: the link-update moves to offer and the notice to show. */
export interface RelocateOutcome {
  moves: LinkMove[]
  notice: string | undefined
  /** The assets-left-behind warning, if any; later notices about this relocation carry it too. */
  warning: string | undefined
  /** True when the notice carries the warning, so it stays until the user closes it. */
  sticky: boolean
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
  return { moves, notice: joinNotice(done, warning), warning, sticky: warning !== undefined }
}

/** The "Updated N links" notice, still carrying the relocation's assets warning so it is not lost; sticky when it does. */
export function linksUpdatedNotice(total: number, warning?: string): { text: string; sticky: boolean } {
  const done = `Updated ${total === 1 ? '1 link' : `${total} links`}`
  return { text: joinNotice(done, warning) ?? done, sticky: warning !== undefined }
}

function joinNotice(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part) => part !== undefined)
  return present.length === 0 ? undefined : present.join('. ')
}
