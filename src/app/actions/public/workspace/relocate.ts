/** The notice the app shows after a note was renamed, moved, trashed or restored. */
export interface RelocateNotice {
  notice: string | undefined
  /** The assets-left-behind warning, if any; later notices about this relocation carry it too. */
  warning: string | undefined
  /** True when the notice carries the warning, so it stays until the user closes it. */
  sticky: boolean
}

/**
 * The notice after a rename, move, trash or restore: `done` is its lead text ("Moved to …"); when an
 * extension-case twin kept the assets folder (`assetsLeftBehind`), the notice names it. Without
 * either there is no notice.
 */
export function relocateNotice(options: { assetsLeftBehind?: string | undefined; done?: string }): RelocateNotice {
  const left = options.assetsLeftBehind
  const warning = left
    ? `The assets folder ${left} stayed in place for the note with the same name; this note's links into it may break.`
    : undefined
  return { notice: joinNotice(options.done, warning), warning, sticky: warning !== undefined }
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
