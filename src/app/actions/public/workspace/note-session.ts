import { TypedEventTarget } from 'remix/component'

import { ApiError, client } from './api.ts'
import type { JsonValue, NoteDocument } from './types.ts'

/** Quiet period after the last keystroke before the note is written. */
export const AUTOSAVE_DELAY_MS = 500

/**
 * - `saved`: the editor matches the file.
 * - `dirty`: unsaved edits; an autosave is scheduled.
 * - `saving`: a save request is in flight.
 * - `error`: the last save failed (retried on the next edit or flush).
 * - `conflict`: the file changed on disk while there were unsaved edits (`theirs` holds the disk
 *   version); autosave is suspended until the user picks a side.
 * - `removed`: the file was deleted or moved outside the app; nothing is written until the user
 *   saves their copy again or closes the note.
 */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'removed'

/** Tells the editor to show `body`; `preserveSelection` for live reloads, a full reset when another note opens. */
export class DocEvent extends Event {
  readonly body: string
  readonly preserveSelection: boolean

  constructor(body: string, preserveSelection: boolean) {
    super('doc')
    this.body = body
    this.preserveSelection = preserveSelection
  }
}

/** The open note's disk state changed (saved, reloaded, renamed): lists update their summary. */
export class SavedEvent extends Event {
  readonly note: NoteDocument

  constructor(note: NoteDocument) {
    super('saved')
    this.note = note
  }
}

/**
 * The note open in the editor and its persistence: debounced autosave with optimistic concurrency
 * (every save sends the hash it is based on; the server answers 409 when the file changed), live
 * reload of external edits, and conflict handling that never drops either version silently.
 * Frontmatter is kept apart from the body and only sent when it is edited (`setFrontmatter`).
 */
export class NoteSession extends TypedEventTarget<{ change: Event; doc: DocEvent; saved: SavedEvent }> {
  /** What is on disk, as of the last read or save. */
  note: NoteDocument | null = null
  /** The editor's current body. */
  body = ''
  state: SaveState = 'saved'
  /** The disk version while `state` is `conflict`. */
  theirs: NoteDocument | null = null
  /** Message of the last failed save. */
  error = ''

  #timer: ReturnType<typeof setTimeout> | undefined
  #inflight: Promise<void> | undefined
  #frontmatter: Record<string, JsonValue> | undefined

  /** Unsaved work that would be lost by leaving the note now (after `flush`). */
  get blocked(): boolean {
    return this.state === 'conflict' || this.state === 'removed' || this.state === 'error'
  }

  open(note: NoteDocument): void {
    this.#reset(note)
    this.dispatchEvent(new DocEvent(note.body, false))
    this.#changed()
  }

  close(): void {
    this.#reset(null)
    this.dispatchEvent(new DocEvent('', false))
    this.#changed()
  }

  /** The note was renamed/moved/restored by the app: same content, new id and hash. */
  relocated(note: NoteDocument): void {
    if (!this.note) return
    this.note = note
    this.dispatchEvent(new SavedEvent(note))
    this.#changed()
  }

  /** The user edited the body. */
  edit(body: string): void {
    if (!this.note || body === this.body) return
    this.body = body
    if (this.state !== 'conflict' && this.state !== 'removed') {
      this.state = 'dirty'
      this.#schedule()
    }
    this.#changed()
  }

  /** Replaces the frontmatter (written with the next save, which happens right away). */
  setFrontmatter(frontmatter: Record<string, JsonValue>): Promise<boolean> {
    this.#frontmatter = frontmatter
    if (this.state === 'saved') this.state = 'dirty'
    return this.flush()
  }

  /** Writes pending edits now (blur, note switch, quit). Resolves `true` when nothing unsaved remains. */
  async flush(): Promise<boolean> {
    clearTimeout(this.#timer)
    if (this.#inflight) await this.#inflight
    if (this.state === 'dirty' || this.state === 'error') await this.#save()
    return this.state === 'saved' || this.note === null
  }

  /** The SSE `note-changed` event for the open note. */
  async externalChange(): Promise<void> {
    const note = this.note
    if (!note) return
    if (this.#inflight) await this.#inflight
    let theirs: NoteDocument
    try {
      theirs = await client.readNote(note.id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.externalRemoval()
      return
    }
    if (this.note?.id !== note.id || theirs.hash === this.note.hash) return
    if (this.state === 'saved') {
      this.note = theirs
      this.body = theirs.body
      this.dispatchEvent(new DocEvent(theirs.body, true))
      this.dispatchEvent(new SavedEvent(theirs))
    } else if (this.state === 'removed' || this.body === theirs.body) {
      // The file came back, or the outside edit matches ours: nothing to choose between.
      this.note = theirs
      this.state = this.body === theirs.body ? 'saved' : 'dirty'
      if (this.state === 'dirty') this.#schedule()
      this.dispatchEvent(new SavedEvent(theirs))
    } else {
      clearTimeout(this.#timer)
      this.theirs = theirs
      this.state = 'conflict'
    }
    this.#changed()
  }

  /** The SSE `note-removed` event for the open note. */
  externalRemoval(): void {
    if (!this.note) return
    clearTimeout(this.#timer)
    this.state = 'removed'
    this.theirs = null
    this.#changed()
  }

  /** Conflict: overwrite the disk version with the editor's. Removed: write the editor's copy back. */
  keepMine(): Promise<boolean> {
    if (!this.note) return Promise.resolve(true)
    if (this.state === 'conflict' && this.theirs) {
      this.note = { ...this.note, hash: this.theirs.hash, frontmatter: this.theirs.frontmatter }
    } else if (this.state === 'removed') {
      this.note = { ...this.note, hash: '' }
    } else {
      return this.flush()
    }
    this.theirs = null
    this.state = 'dirty'
    return this.flush()
  }

  /** Conflict: drop the editor's edits and show the disk version. */
  loadTheirs(): void {
    const theirs = this.theirs
    if (this.state !== 'conflict' || !theirs) return
    this.#reset(theirs)
    this.dispatchEvent(new DocEvent(theirs.body, true))
    this.dispatchEvent(new SavedEvent(theirs))
    this.#changed()
  }

  #reset(note: NoteDocument | null): void {
    clearTimeout(this.#timer)
    this.note = note
    this.body = note?.body ?? ''
    this.state = 'saved'
    this.theirs = null
    this.error = ''
    this.#frontmatter = undefined
  }

  #schedule(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS)
  }

  #save(): Promise<void> {
    const note = this.note
    if (!note) return Promise.resolve()
    const body = this.body
    const frontmatter = this.#frontmatter
    this.state = 'saving'
    this.#changed()
    const run = (async () => {
      try {
        const saved = await client.saveNote({
          id: note.id,
          body,
          // `''` marks a note removed on disk: it must not exist when we write our copy back.
          baseHash: note.hash === '' ? null : note.hash,
          ...(frontmatter ? { frontmatter } : {}),
        })
        if (this.note?.id !== note.id) return
        this.note = saved
        if (this.#frontmatter === frontmatter) this.#frontmatter = undefined
        this.state = this.body === body && this.#frontmatter === undefined ? 'saved' : 'dirty'
        if (this.state === 'dirty') this.#schedule()
        this.dispatchEvent(new SavedEvent(saved))
      } catch (error) {
        if (this.note?.id !== note.id) return
        if (error instanceof ApiError && error.conflict) {
          this.theirs = error.conflict
          this.state = 'conflict'
        } else if (error instanceof ApiError && error.status === 404) {
          this.state = 'removed'
        } else {
          this.state = 'error'
          this.error = error instanceof Error ? error.message : String(error)
        }
      } finally {
        this.#inflight = undefined
        this.#changed()
      }
    })()
    this.#inflight = run
    return run
  }

  #changed(): void {
    this.dispatchEvent(new Event('change'))
  }
}
