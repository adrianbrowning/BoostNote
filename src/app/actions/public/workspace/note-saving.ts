import type { NoteSession, SaveOutcome } from './note-session.ts'

/**
 * The open note's save actions and their notice policy: the silent "save now" (editor focusout, a hidden
 * window, quit) and the conflict bar's buttons, whose saves show an error notice when they still fail.
 * Leaving the note is `Navigation.leave`. `WorkspaceModel` holds one and its actions call through, so
 * components keep calling model actions.
 */
export class NoteSaving {
  readonly #session: NoteSession
  readonly #notify: (text: string) => void

  /** `notify` shows an error notice. */
  constructor(session: NoteSession, notify: (text: string) => void) {
    this.#session = session
    this.#notify = notify
  }

  /**
   * Saves the open note's pending edits now, with no notice; a save that failed is tried again. Resolves
   * `false` when unsaved work remains, which decides main's "Quit Anyway?" dialog.
   */
  saveNow(): Promise<boolean> {
    return this.#session.flush()
  }

  /** Conflict bar "Retry" (a save that failed). */
  retry(): Promise<void> {
    return this.#resolved(this.#session.retry())
  }

  /** Conflict bar "Keep mine": the editor's version overwrites the one changed on disk. */
  keepMine(): Promise<void> {
    return this.#resolved(this.#session.keepMine())
  }

  /** Removed bar "Save my copy": the editor's version is written back where the note was. */
  saveMyCopy(): Promise<void> {
    return this.#resolved(this.#session.saveMyCopy())
  }

  /** Conflict bar "Load theirs": the editor's edits are dropped for the version on disk. */
  loadTheirs(): void {
    this.#session.loadTheirs()
  }

  /**
   * A conflict-bar save that failed shows an error notice; the bar shows the new state. A save that worked
   * while newer edits arrived leaves the note dirty, with those edits already queued for autosave: no notice.
   * The notice follows how the button's own save ended, not the session state after it: another flush
   * waiting on that save (editor focusout) may have started the next save by then.
   */
  async #resolved(save: Promise<SaveOutcome>): Promise<void> {
    const outcome = await save
    if (outcome.state === 'error') this.#notify(`Could not save the note: ${outcome.error}`)
    else if (outcome.state === 'conflict' || outcome.state === 'removed') this.#notify('Could not save the note')
  }
}
