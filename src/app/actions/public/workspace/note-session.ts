import { TypedEventTarget } from 'remix/component'

import { parentOf } from '../../../../shared/vault-ids.ts'
import { ApiError, type NoteApi } from './api.ts'
import type { JsonValue, NoteDocument } from './types.ts'

/** Quiet period after the last keystroke before the note is written. */
export const AUTOSAVE_DELAY_MS = 500

/**
 * - `saved`: the editor matches the file.
 * - `dirty`: unsaved edits; an autosave is scheduled.
 * - `saving`: a save request is in flight.
 * - `retrying`: a save started from the `error` state is in flight; the error bar (and its Retry) stays up.
 * - `error`: the last save failed (retried on the next edit or flush).
 * - `conflict`: the file changed on disk while there were unsaved edits (`theirs` holds the disk
 *   version); autosave is suspended until the user picks a side.
 * - `removed`: the file was deleted or moved outside the app; nothing is written until the user
 *   saves their copy again or closes the note.
 */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'retrying' | 'error' | 'conflict' | 'removed'

/**
 * How a flush ended: after a save request, the note's state when it settled (`dirty` when it worked but newer
 * edits were queued meanwhile; `saved` also when it worked after the session moved to another note) and, on
 * `error`, the message. When no save was needed, the state as it was once no save was in flight (`saved`,
 * `conflict` or `removed`).
 */
export type SaveOutcome = { state: 'error'; error: string } | { state: 'saved' | 'dirty' | 'conflict' | 'removed' }

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
  /** Message of the last failed save; cleared when a save works. */
  error = ''
  /**
   * While set the open note takes no edits (`edit` ignores them, `setFrontmatter` resolves `false`) and the
   * editor is read-only (`lock`): a transition is running (`Navigation.hold`) that may replace, close or move
   * the note once its requests return, and edits made meanwhile could be dropped or saved to the wrong place.
   */
  locked = false

  #timer: ReturnType<typeof setTimeout> | undefined
  #inflight: Promise<SaveOutcome> | undefined
  #frontmatter: Record<string, JsonValue> | undefined
  readonly #api: NoteApi
  /**
   * Counts the times the session took a document from scratch (`#reset`: opening or closing a note, and Load
   * theirs); a relocation keeps the count (`saveAsset`).
   */
  #opened = 0
  /**
   * Counts the reads of the open note taken out (`readTicket`) and the documents and states it took from elsewhere
   * (`relocated`, `#reset`, a save that worked, a save's conflict or removal, `externalRemoval`): a read's result
   * applies only while no later one was taken out or taken.
   */
  #generation = 0

  /** `api`: the page's `client`, or one over the router in tests (`createClient`). */
  constructor(api: NoteApi) {
    super()
    this.#api = api
  }

  /**
   * Saves an image pasted or dropped into the open note (`POST /api/assets`) and resolves with the link to insert,
   * relative to the note. When the note was renamed or moved while the image was saved (`relocated`), it is saved
   * again for the note's new place (assets are stored by content hash, so that is the same file) until the note
   * stays put, and the last link is the one returned; an upload that reached the vault once the note had left its
   * old place is refused there (`404`, nothing written) and saved again the same way, also when the app has not yet
   * taken the relocation's answer (it waits until no transition holds the note, `locked`). Rejects with "No note is
   * open" when no note is open, or the note closed meanwhile. When another note replaced it meanwhile, it resolves
   * with the link for the note it was saved for (the editor drops that insert). The editor also checks the place
   * right before the insert (`EditorHost.assetPlace`), for a relocation that lands after this resolved.
   */
  async saveAsset(file: File): Promise<string> {
    const opened = this.#opened
    let id = this.note?.id
    if (id === undefined) throw new Error('No note is open')
    for (;;) {
      let href: string
      try {
        href = (await this.#api.uploadAsset(id, file)).href
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error
        // A rename or move the vault ran may still be on its way back: the note moves once it lands.
        await this.#unlocked()
        const now = this.note?.id
        if (this.#opened !== opened || now === undefined || now === id) throw error
        id = now
        continue
      }
      const now: string | undefined = this.note?.id
      if (now === undefined) throw new Error('No note is open')
      if (this.#opened !== opened || now === id) return href
      id = now
    }
  }

  /** Resolves once no transition holds the note (`locked`). */
  async #unlocked(): Promise<void> {
    while (this.locked) {
      const { promise, resolve } = Promise.withResolvers<void>()
      this.addEventListener('change', () => resolve(), { once: true })
      await promise
    }
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

  /**
   * The app renamed or moved the open note, or rewrote its links: it takes the vault's `note` (its new id, hash
   * and text), and the editor keeps its cursor, selection and undo history. Callers save the note first and hold
   * it (`Navigation.hold`); text not yet saved is kept as it is, to be saved over the new hash.
   */
  relocated(note: NoteDocument): void {
    if (!this.note) return
    this.#generation++
    this.note = note
    if (this.state === 'saved' && note.body !== this.body) {
      this.body = note.body
      this.dispatchEvent(new DocEvent(note.body, true))
    }
    this.dispatchEvent(new SavedEvent(note))
    this.#changed()
  }

  /**
   * Takes out a read of the open note: the handle answers `true` while no later read was taken out and the note took
   * no document or state since (`relocated`, opening, closing, Load theirs, a save that worked, a save's conflict or
   * removal, `externalRemoval`). A read that returns once it answers `false` is older than what the note shows, and
   * is dropped.
   */
  readTicket(): () => boolean {
    const at = ++this.#generation
    return () => at === this.#generation
  }

  /**
   * The app moved the open note to `id` and has not read it there yet (`relocated` takes that read): it follows with
   * the hash and text it had, so when the read fails its next save goes to the new place and conflicts (instead of
   * overwriting) when the vault changed the file meanwhile. No `saved` event: the lists learn the new place from
   * their next refresh.
   */
  retarget(id: string): void {
    if (!this.note) return
    this.note = { ...this.note, id, folder: parentOf(id) }
    this.#changed()
  }

  /** Sets `locked`; the editor follows on `change`. */
  lock(locked: boolean): void {
    this.locked = locked
    this.#changed()
  }

  /** The user edited the body. */
  edit(body: string): void {
    if (!this.note || this.locked || body === this.body) return
    this.body = body
    if (this.state !== 'conflict' && this.state !== 'removed') {
      this.state = 'dirty'
      this.#schedule()
    }
    this.#changed()
  }

  /** Replaces the frontmatter (written with the next save, which happens right away); `false` while `locked`. */
  setFrontmatter(frontmatter: Record<string, JsonValue>): Promise<boolean> {
    if (this.locked) return Promise.resolve(false)
    this.#frontmatter = frontmatter
    if (this.state === 'saved') this.state = 'dirty'
    return this.flush()
  }

  /** Writes pending edits now (blur, note switch, quit). Resolves `true` when nothing unsaved remains. */
  async flush(): Promise<boolean> {
    await this.#flush()
    return this.state === 'saved' || this.note === null
  }

  /** Error bar "Retry": `flush`, resolving to how its own save ended (later flushes may already be saving). */
  retry(): Promise<SaveOutcome> {
    return this.#flush()
  }

  /** The SSE `note-changed` event for the open note. */
  async externalChange(): Promise<void> {
    const note = this.note
    if (!note) return
    if (this.#inflight) await this.#inflight
    const fresh = this.readTicket()
    let theirs: NoteDocument
    try {
      theirs = await this.#api.readNote(note.id)
    } catch (error) {
      if (fresh() && error instanceof ApiError && error.status === 404) this.externalRemoval()
      return
    }
    if (!fresh() || this.note?.id !== note.id || theirs.hash === this.note.hash) return
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
    this.#generation++
    clearTimeout(this.#timer)
    this.state = 'removed'
    this.theirs = null
    this.#changed()
  }

  /** Conflict: overwrite the disk version with the editor's (otherwise the same as `retry`). */
  keepMine(): Promise<SaveOutcome> {
    if (this.note && this.state === 'conflict' && this.theirs) {
      this.note = { ...this.note, hash: this.theirs.hash, frontmatter: this.theirs.frontmatter }
      this.theirs = null
      this.state = 'dirty'
    }
    return this.#flush()
  }

  /**
   * Removed: write the editor's copy back where the note was, as a new note (otherwise the same as `retry`).
   * The note's frontmatter goes with it (with no file there, the vault has none to keep).
   */
  saveMyCopy(): Promise<SaveOutcome> {
    if (this.note && this.state === 'removed') {
      this.#frontmatter ??= this.note.frontmatter
      this.note = { ...this.note, hash: '' }
      this.state = 'dirty'
    }
    return this.#flush()
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

  /**
   * Saves pending edits once no save is in flight (another waiter may start the next save first; that one is
   * waited for too); resolves to how this flush's own save ended, or the state as is.
   */
  async #flush(): Promise<SaveOutcome> {
    clearTimeout(this.#timer)
    while (this.#inflight) await this.#inflight
    const state = this.state
    if (state === 'dirty' || state === 'error') return this.#save()
    // `#inflight` is set with 'saving' and 'retrying' and cleared when they end.
    if (state === 'saving' || state === 'retrying') throw new Error(`No save in flight while ${state}`)
    return { state }
  }

  #reset(note: NoteDocument | null): void {
    clearTimeout(this.#timer)
    this.#opened++
    this.#generation++
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

  #save(): Promise<SaveOutcome> {
    const note = this.note
    if (!note) return Promise.resolve({ state: 'saved' })
    const body = this.body
    const frontmatter = this.#frontmatter
    this.state = this.state === 'error' ? 'retrying' : 'saving'
    this.#changed()
    const run = (async (): Promise<SaveOutcome> => {
      // `#inflight` is set before the request starts, even when `saveNote` throws before it sends anything.
      await undefined
      try {
        const saved = await this.#api.saveNote({
          id: note.id,
          body,
          // `''` marks a note removed on disk: it must not exist when we write our copy back.
          baseHash: note.hash === '' ? null : note.hash,
          ...(frontmatter ? { frontmatter } : {}),
        })
        if (this.note?.id !== note.id) return { state: 'saved' }
        this.#generation++
        this.note = saved
        this.error = ''
        if (this.#frontmatter === frontmatter) this.#frontmatter = undefined
        this.state = this.body === body && this.#frontmatter === undefined ? 'saved' : 'dirty'
        if (this.state === 'dirty') this.#schedule()
        this.dispatchEvent(new SavedEvent(saved))
        return { state: this.state }
      } catch (error) {
        const conflict = error instanceof ApiError ? error.conflict : undefined
        const outcome: SaveOutcome = conflict
          ? { state: 'conflict' }
          : error instanceof ApiError && error.status === 404
            ? { state: 'removed' }
            : { state: 'error', error: error instanceof Error ? error.message : String(error) }
        if (this.note?.id !== note.id) return outcome
        // A read taken out before this save is older than the disk version or the removal it found.
        if (outcome.state !== 'error') this.#generation++
        if (conflict) this.theirs = conflict
        if (outcome.state === 'error') this.error = outcome.error
        this.state = outcome.state
        return outcome
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
