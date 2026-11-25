import { isUnder, movedId, noteStem } from '../../../../shared/vault-ids.ts'
import type { Client } from './api.ts'
import type { Navigation } from './navigation.ts'
import type { NoteSession } from './note-session.ts'
import { linksUpdatedNotice, linkUpdateFailedNotice, refreshFailedNotice, relocateNotice } from './relocate.ts'
import type { FolderRelocation, LinkMove, LinkUpdate, NoteDocument, TitleRename, TitleRenameReport } from './types.ts'

/** The client calls a relocation makes. */
export type RelocationApi = Pick<
  Client,
  | 'readNote'
  | 'renameNote'
  | 'moveNote'
  | 'renameFolder'
  | 'moveFolder'
  | 'applyTitleRenames'
  | 'planLinkUpdates'
  | 'applyLinkUpdates'
>

/** The "Update links?" question after a relocation. */
export interface LinksQuestion {
  title: string
  message: string
  notes: LinkUpdate[]
  confirm: string
  cancel: string
}

/** What relocations need from the workspace around them (`WorkspaceModel`). */
export interface RelocationHost {
  /** The folder's name as the sidebar shows it (`''`: the vault's). */
  folderName(id: string): string
  /** A folder was renamed or moved: the folder ids the view keeps (selection, expanded folders) follow `map`. */
  folderMoved(map: (id: string) => string): void
  /** Re-reads the vault's lists. */
  refresh(): Promise<void>
  notify(kind: 'error' | 'info', text: string, sticky: boolean): void
  /** Shows the question; resolves with the answer (`true`: update the links). */
  askLinks(question: LinksQuestion): Promise<boolean>
}

export interface RelocationOptions {
  session: NoteSession
  navigation: Navigation
  /** The page's `client`, or one over the router in tests (`createClient`). */
  api: RelocationApi
  host: RelocationHost
}

/** What a relocation that the vault made did, as far as the app caught up with it. */
interface Done<R> {
  result: R
  /** Whether the vault on screen is still the one relocated in (`Navigation.vaultToken`). */
  sameVault: () => boolean
  /**
   * Why the app could not catch up (the open note's read, the list refresh, or saving the tabs to the store failed);
   * `undefined` when it did.
   */
  failed: string | undefined
  /**
   * Asks the link question (with the relocation's assets `warning`) in its place in the question order; resolves
   * once it is answered and done. Called once for every relocation with moves, also when another vault shows (then
   * nothing is asked, and the questions after it go on).
   */
  ask(warning?: string): Promise<void>
}

/** A place in the order of link questions (`Relocation.#reserve`). */
interface QuestionSlot {
  /** Asks the question there once the questions before it are answered and done. */
  ask(warning?: string): Promise<void>
  /** Gives the place up (the relocation failed after it was taken). */
  skip(): void
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Every rename and move the app makes of notes and folders, and the title renames, through one sequence: the
 * leave-note gate (renames and moves: when the relocation can replace the open note,
 * `Navigation.relocationReplaces`: it moves it, or the active tab shows another note that moves and so loads over it;
 * title renames: always; the open note is saved first, and nothing runs when that fails), the vault
 * operation, the open note taking the vault's document at its new place (its relocated links included, keeping the
 * editor's cursor, selection and undo), tabs and the view following, the list refresh, the notice, then the
 * "Update links?" question and, on "Update links", the rewrite (gated the same way). The open note is held
 * (`Navigation.hold`) while requests that move or rewrite it are out. When the vault did its part but the app
 * cannot catch up (a read, the refresh or saving the tabs fails), the result still counts, with a could-not-refresh
 * notice.
 */
export class Relocation {
  readonly #session: NoteSession
  readonly #navigation: Navigation
  readonly #api: RelocationApi
  readonly #host: RelocationHost
  /** The link question asked last (or waiting to be): the next one is asked once it is answered and done. */
  #questions: Promise<void> = Promise.resolve()

  constructor({ session, navigation, api, host }: RelocationOptions) {
    this.#session = session
    this.#navigation = navigation
    this.#api = api
    this.#host = host
  }

  get #openId(): string | null {
    return this.#session.note?.id ?? null
  }

  /** Renames note `id` to file name `name` (no extension). Rejects when the vault refused (`EXISTS`, …). */
  async renameNote(id: string, name: string): Promise<void> {
    const done = await this.#run(
      this.#navigation.relocationReplaces((path) => path === id),
      () => this.#api.renameNote(id, name),
      (renamed) =>
        this.#follow(
          (path) => (path === id ? renamed.note.id : path),
          (open) => open === id,
          renamed.note,
        ),
      (renamed) => renamed.moves,
    )
    if (!done) return
    const outcome = relocateNotice({ assetsLeftBehind: done.result.assetsLeftBehind })
    if (done.sameVault()) this.#report(outcome.notice, outcome.sticky, done.failed)
    await done.ask(outcome.warning)
  }

  /** Moves note `id` into `folder`. */
  async moveNote(id: string, folder: string): Promise<void> {
    const done = await this.#run(
      this.#navigation.relocationReplaces((path) => path === id),
      () => this.#api.moveNote(id, folder),
      (moved) =>
        this.#follow(
          (path) => (path === id ? moved.note.id : path),
          (open) => open === id,
          moved.note,
        ),
      (moved) => moved.moves,
    )
    if (!done) return
    const outcome = relocateNotice({
      assetsLeftBehind: done.result.assetsLeftBehind,
      done: `Moved to ${this.#host.folderName(folder)}`,
    })
    if (done.sameVault()) this.#report(outcome.notice, outcome.sticky, done.failed)
    await done.ask(outcome.warning)
  }

  renameFolder(id: string, name: string): Promise<void> {
    return this.#relocateFolder(id, () => this.#api.renameFolder(id, name))
  }

  moveFolder(id: string, parent: string): Promise<void> {
    return this.#relocateFolder(id, () => this.#api.moveFolder(id, parent))
  }

  /**
   * File › Rename Files From Titles…, after the user confirmed the plan: saves the open note, runs the renames (the
   * vault rewrites the links to them too), then the open note takes its text at its new place and tabs follow
   * their notes; it takes no edits until then. The report also when the app could not catch up afterwards (with
   * the could-not-refresh notice) or another vault shows by then; `null` when nothing was renamed: the open note
   * could not be saved first (the unsaved-changes notice shows), or another vault shows by the time it was saved.
   */
  async applyTitleRenames(renames: TitleRename[]): Promise<TitleRenameReport | null> {
    const done = await this.#run(
      true,
      () => this.#api.applyTitleRenames(renames),
      (report) => {
        const moved = new Map(report.renamed.map((rename) => [rename.from, rename.to]))
        // Any open note may have had its links rewritten: it is read again.
        return this.#follow(
          (path) => moved.get(path) ?? path,
          () => true,
        )
      },
    )
    if (!done) return null
    if (done.sameVault()) this.#report(undefined, false, done.failed)
    return done.result
  }

  async #relocateFolder(id: string, relocate: () => Promise<FolderRelocation>): Promise<void> {
    const inside = (path: string) => isUnder(path, id)
    const done = await this.#run(
      this.#navigation.relocationReplaces(inside),
      relocate,
      (relocated) => {
        const rebase = (value: string) => movedId(value, id, relocated.folder) ?? value
        this.#host.folderMoved(rebase)
        // Decided now: a note inside the folder may have been opened while the request was out.
        return this.#follow(rebase, inside)
      },
      (relocated) => relocated.moves,
    )
    if (!done) return
    if (done.sameVault()) this.#report(undefined, false, done.failed)
    await done.ask()
  }

  /**
   * The sequence up to the list refresh: the gate (with `gate`), the vault's `request` and `follow`, holding the
   * open note; then the lists refresh. `null` when the gate refused; `request`'s failure rejects. When another vault
   * shows by the time the request returns (`sameVault()` is `false`), nothing follows and the caller does nothing
   * more for it (no refresh, notice or link question: they would reach the vault on screen). With `moves`, the link
   * question takes its place in the question order as soon as the request returns (`Done.ask` asks it there).
   * Nothing is requested (`null`, like a refused gate) when another vault shows by the time the gate let it through.
   */
  async #run<R>(
    gate: boolean,
    request: () => Promise<R>,
    follow: (result: R) => Promise<string | undefined>,
    moves?: (result: R) => LinkMove[],
  ): Promise<Done<R> | null> {
    let slot: QuestionSlot | undefined
    /** What `run` returned: the hold can still reject after it, when saving the tabs to the store throws. */
    let landed: Omit<Done<R>, 'ask'> | undefined
    let held: Omit<Done<R>, 'ask'> | null
    // Taken before the gate: the operation is for the vault on screen when it was asked for.
    const sameVault = this.#navigation.vaultToken()
    try {
      held = await this.#navigation.hold(
        async () => {
          if (!sameVault()) return null
          const result = await request()
          // Recorded at once: the vault did its part, whatever happens while the app catches up.
          landed = { result, sameVault, failed: undefined }
          if (sameVault()) {
            if (moves) slot = this.#reserve(moves(result), sameVault)
            landed.failed = await follow(result)
          }
          return landed
        },
        { gate },
      )
    } catch (error) {
      if (!landed) {
        slot?.skip()
        throw error
      }
      // The vault did its part: it still counts, with the store's error as what the app could not catch up with.
      held = landed
      held.failed ??= message(error)
    }
    if (!held) return null
    const done: Done<R> = { ...held, ask: (warning) => slot?.ask(warning) ?? Promise.resolve() }
    if (!done.sameVault()) return done
    try {
      await this.#host.refresh()
    } catch (error) {
      done.failed ??= message(error)
    }
    return done
  }

  /**
   * After the vault relocated notes (`map` gives each path's new path): when `affects` the open note, it takes the
   * vault's document at its new place (`returned`), or follows there at once (`NoteSession.retarget`) and is read
   * again; tabs follow before that read. So relocations map the open note and the tabs in the order the vault made
   * them, also when another one lands while the read is out. Runs inside the relocation's `hold`, in the vault
   * relocated in. Resolves with the read's error message when it failed: the open note's, or the active tab's when
   * its note moved and loads there (`Navigation.rebase`).
   */
  async #follow(
    map: (path: string) => string,
    affects: (id: string) => boolean,
    returned?: NoteDocument,
  ): Promise<string | undefined> {
    const openId = this.#openId
    let read: string | undefined
    if (openId !== null && affects(openId)) {
      const to = map(openId)
      if (returned?.id === to) this.#session.relocated(returned)
      else {
        if (to !== openId) this.#session.retarget(to)
        read = to
      }
    }
    const reload = await this.#navigation.rebase(map)
    const failed = read === undefined ? undefined : await this.#reread(read)
    return reload ? message(reload.error) : failed
  }

  /**
   * The open note `id` takes the vault's document there (`NoteSession.relocated`). Resolves with the read's error
   * message when it failed: the note then keeps the hash and text it had, so its next save conflicts (instead of
   * overwriting) when the vault changed its text meanwhile. Nothing is taken, nor a failure reported, once the note
   * is no longer open there (another note opened, another relocation moved it again, or another vault shows).
   */
  async #reread(id: string): Promise<string | undefined> {
    const current = this.#navigation.token()
    const sameVault = this.#navigation.vaultToken()
    let note: NoteDocument | undefined
    let failed: string | undefined
    try {
      note = await this.#api.readNote(id)
    } catch (error) {
      failed = message(error)
    }
    if (!current() || !sameVault() || this.#session.note?.id !== id) return undefined
    if (note) this.#session.relocated(note)
    return failed
  }

  /** Shows `notice` (if any); when the app could not catch up (`failed`), the could-not-refresh notice after it. */
  #report(notice: string | undefined, sticky: boolean, failed: string | undefined): void {
    if (failed !== undefined) this.#host.notify('error', refreshFailedNotice(failed, notice), sticky)
    else if (notice) this.#host.notify('info', notice, sticky)
  }

  /**
   * Takes the next place in the order of link questions for a relocation that just landed (`moves`, as the server
   * returned them). Questions are asked one at a time, in the order their relocations landed: each waits for the
   * answer (and the update) of the one before, so none is dropped. The slot's `ask` asks this one there and resolves
   * once it is answered and done (it never rejects: a failure is the link-update notice); `skip` gives the place up.
   * One of them must be called, or the questions after it wait for good.
   */
  #reserve(moves: LinkMove[], sameVault: () => boolean): QuestionSlot {
    const { promise, resolve } = Promise.withResolvers<{ warning: string | undefined } | null>()
    const turn = this.#questions.then(async () => {
      const asked = await promise
      if (asked) await this.#askLinks(moves, sameVault, asked.warning)
    })
    this.#questions = turn
    return {
      ask: (warning) => {
        resolve({ warning })
        return turn
      },
      skip: () => resolve(null),
    }
  }

  /**
   * One link question: the plan, the question, then on "Update links" the gate (the open note's pending edits are
   * saved first; nothing is rewritten when that fails) and the rewrite; the open note takes its rewritten text
   * (keeping the editor's cursor, selection and undo), the lists refresh and "Updated N links" shows. Nothing is
   * asked or rewritten once another vault shows: its links are not the ones that pointed at the move.
   */
  async #askLinks(moves: LinkMove[], sameVault: () => boolean, warning?: string): Promise<void> {
    const [move] = moves
    if (!move || !sameVault()) return
    let done: { total: number; failed: string | undefined } | null
    /** What the rewrite did: the hold can still reject after it, when saving the tabs to the store throws. */
    let applied: { total: number; failed: string | undefined } | undefined
    try {
      const plan = await this.#api.planLinkUpdates(moves)
      if (plan.total === 0 || !sameVault()) return
      const name = noteStem(move.from)
      const links = plan.total === 1 ? '1 link' : `${plan.total} links`
      const notes = plan.notes.length === 1 ? '1 note' : `${plan.notes.length} notes`
      const ok = await this.#host.askLinks({
        title: 'Update links?',
        message: `${links} in ${notes} ${plan.total === 1 ? 'points' : 'point'} to “${name}”.`,
        notes: plan.notes,
        confirm: 'Update links',
        cancel: 'Don’t update',
      })
      if (!ok || !sameVault()) return
      done = await this.#navigation.hold(async () => {
        // The gate saved the open note first: another vault may show by now.
        if (!sameVault()) return null
        const report = await this.#api.applyLinkUpdates(moves)
        const openId = this.#openId
        const rewritten = openId !== null && report.notes.some((note) => note.id === openId)
        applied = {
          total: report.total,
          failed: rewritten && sameVault() ? await this.#reread(openId) : undefined,
        }
        return applied
      })
    } catch (error) {
      if (applied) {
        // The links were rewritten: that still counts, with the store's error as what the app could not catch up with.
        done = applied
        done.failed ??= message(error)
      } else {
        const notice = linkUpdateFailedNotice(message(error), warning)
        this.#host.notify('error', notice.text, notice.sticky)
        return
      }
    }
    if (!done || !sameVault()) return
    try {
      await this.#host.refresh()
    } catch (error) {
      done.failed ??= message(error)
    }
    const notice = linksUpdatedNotice(done.total, warning)
    this.#report(notice.text, notice.sticky, done.failed)
  }
}
