/** The notice the app shows after a note was renamed, moved, trashed or restored. */
export interface RelocateNotice {
  notice: string | undefined
  /** The assets-left-behind warning, if any; later notices about this relocation carry it too. */
  warning: string | undefined
  /** True when the notice carries the warning, so it stays until the user closes it. */
  sticky: boolean
}

/**
 * The notice after a rename, move, trash or restore: `done` is its lead text ("Moved to …"); when a
 * stem twin (`a.MD` or `a.mdx` beside `a.md`) kept the assets folder (`assetsLeftBehind`), the notice names it. Without
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

/**
 * The notice when the vault made a relocation but the list refresh, the open note's read or saving the tabs after it
 * failed: what was done (`done`, if anything is said about it), then that the app could not refresh.
 */
export function refreshFailedNotice(message: string, done?: string): string {
  const failed = `Could not refresh: ${message}`
  return joinNotice(done, failed) ?? failed
}

/** Joins the present parts with '. ', or with ' ' after a part that already ends in a period. */
function joinNotice(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part) => part !== undefined)
  if (present.length === 0) return undefined
  return present.reduce((text, part) => `${text}${text.endsWith('.') ? ' ' : '. '}${part}`)
}
