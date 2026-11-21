import type { LinkMove } from './types.ts'

/** What the app does after a note was renamed, moved, trashed or restored: the link-update moves to offer and the notice to show. */
export interface RelocateOutcome {
  moves: LinkMove[]
  notice: string | undefined
  /** The assets-left-behind warning, if any; later notices about this relocation carry it too. */
  warning: string | undefined
  /** True when the notice carries the warning, so it stays until the user closes it. */
  sticky: boolean
}

/**
 * Turns a rename or move (`from` set), or a trash or restore (no `from`), result into the
 * link-update moves and the notice text. The move carries what the relocation did with the assets
 * folder (`assets: true` when it moved, `false` when an extension-case twin kept it), so the server
 * never has to work it out again from the disk; the notice then names the kept folder. `done` is
 * the notice's lead text ("Moved to …"); without it the notice is only the assets warning, if any.
 */
export function linkMovesAfterRelocate(options: {
  from?: string
  result: { id: string; assetsLeftBehind?: string }
  done?: string
}): RelocateOutcome {
  const { from, result, done } = options
  const left = result.assetsLeftBehind
  const moves: LinkMove[] =
    from === undefined ? [] : [{ from, to: result.id, kind: 'note', assets: left === undefined }]
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

/** The notice when updating links failed: the error, still carrying the relocation's assets warning; sticky when it does. */
export function linkUpdateFailedNotice(message: string, warning?: string): { text: string; sticky: boolean } {
  return { text: joinNotice(message, warning) ?? message, sticky: warning !== undefined }
}

function joinNotice(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part) => part !== undefined)
  return present.length === 0 ? undefined : present.join('. ')
}
