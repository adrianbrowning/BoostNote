import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'

import { scratchTitle } from '../shared/scratch.ts'
import { isNodeError } from '../vault/errors.ts'
import { isFile, readJsonFile, writeFileAtomic, writeJsonFile } from '../vault/files.ts'
import type { ScratchNote, ScratchSummary } from './actions/public/workspace/types.ts'
import { HttpError, isJsonObject } from './http.ts'

/** A scratch note's id: 32 random lowercase hex characters. */
const SCRATCH_ID = /^[0-9a-f]{32}$/
const NOTE_FILE = /^([0-9a-f]{32})\.md$/

function notFound(): HttpError {
  return new HttpError(404, 'NOT_FOUND', 'This scratch note no longer exists')
}

/**
 * Scratch notes: notes kept outside every vault, one file `<dir>/<id>.md` each (`dir` is
 * `<userData>/scratch`), holding the text as typed, with no frontmatter and no conflict checks (last
 * write wins). Their creation time lives beside them in `<id>.json` (`{ "created": ISO-8601 }`),
 * because every atomic write replaces the `.md` file and with it the file's birth time.
 *
 * Callers name a note by its id only, never a path; any other id form, or an id with no file, is a
 * `404 NOT_FOUND`, so nothing outside `dir` is ever read, written or removed.
 */
export class ScratchStore {
  readonly #dir: string
  /** The last operation queued on each note id (see `#serial`). */
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(dir: string) {
    this.#dir = dir
  }

  /** A new, empty scratch note: its file first, then its sidecar, so a failed create leaves no stray sidecar. */
  async create(): Promise<ScratchNote> {
    const id = randomBytes(16).toString('hex')
    const created = new Date().toISOString()
    return this.#serial(id, async () => {
      await writeFileAtomic(this.#file(id), '')
      await writeJsonFile(this.#meta(id), { created })
      return this.#read(id)
    })
  }

  /** Every scratch note, newest updated first. */
  async list(): Promise<ScratchSummary[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
    const notes: ScratchSummary[] = []
    for (const name of names) {
      const id = NOTE_FILE.exec(name)?.[1]
      if (id === undefined) continue
      // Discarded since the listing: left out.
      const note = await this.read(id).catch((error) => {
        if (error instanceof HttpError && error.code === 'NOT_FOUND') return undefined
        throw error
      })
      if (note) notes.push({ id: note.id, title: note.title, created: note.created, updated: note.updated })
    }
    return notes.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  /**
   * Note `id`. A note whose sidecar is missing or unreadable takes its file's birth time as its creation time and
   * keeps it from then on (the sidecar is written again), so later writes do not move it.
   */
  read(id: string): Promise<ScratchNote> {
    return this.#serial(id, () => this.#read(id))
  }

  /**
   * Replaces note `id`'s text (atomically). Writes, discards and reads of one note run one at a time, so a note
   * discarded before the write gets its turn answers `404` and stays gone.
   */
  write(id: string, text: string): Promise<ScratchNote> {
    return this.#serial(id, async () => {
      const file = await this.#existing(id)
      if (!(await writeFileAtomic(file, text, () => isFile(file)))) throw notFound()
      return this.#read(id)
    })
  }

  /**
   * Deletes note `id`: its creation time first, then its file, so a failure leaves the note listed with its text
   * (at worst with its file's birth time as its creation time). With `ifBlank`, deletes it only when its text is
   * empty or whitespace only. Answers whether it deleted the note.
   */
  discard(id: string, options: { ifBlank?: boolean } = {}): Promise<boolean> {
    return this.#serial(id, async () => {
      const file = await this.#existing(id)
      if (options.ifBlank && (await this.#text(file)).trim() !== '') return false
      await rm(this.#meta(id), { force: true })
      try {
        await rm(file)
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) throw notFound()
        throw error
      }
      return true
    })
  }

  /** Runs `task` after every operation queued earlier on note `id` has settled. */
  #serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(id) ?? Promise.resolve()).then(task, task)
    const settled = run.then(
      () => {},
      () => {},
    )
    this.#queues.set(id, settled)
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id)
    })
    return run
  }

  async #read(id: string): Promise<ScratchNote> {
    const file = await this.#existing(id)
    const text = await this.#text(file)
    let stats: Stats
    try {
      stats = await stat(file)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound()
      throw error
    }
    const meta = await readJsonFile(this.#meta(id))
    let created: string
    if (isJsonObject(meta) && typeof meta.created === 'string') {
      created = meta.created
    } else {
      created = stats.birthtime.toISOString()
      await writeJsonFile(this.#meta(id), { created })
    }
    return { id, text, title: scratchTitle(text, created), created, updated: stats.mtime.toISOString() }
  }

  async #text(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound()
      throw error
    }
  }

  /** The file of note `id`; `404` when `id` is not a scratch id or the note has no regular file. */
  async #existing(id: string): Promise<string> {
    if (!SCRATCH_ID.test(id)) throw notFound()
    const file = this.#file(id)
    if (!(await isFile(file))) throw notFound()
    return file
  }

  #file(id: string): string {
    return path.join(this.#dir, `${id}.md`)
  }

  #meta(id: string): string {
    return path.join(this.#dir, `${id}.json`)
  }
}
