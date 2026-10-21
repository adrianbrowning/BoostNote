import type { Note, NoteMeta } from './note.ts'
import { toMeta } from './note.ts'

export interface SearchHit extends NoteMeta {
  score: number
}

interface Entry {
  meta: NoteMeta
  title: string
  tags: string[]
  body: string
}

/** Lower-cased words of `text` (letters, digits, marks; `_`, `-` and `.` kept inside words). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+(?:[_\-.'][\p{L}\p{N}\p{M}]+)*/gu) ?? []
}

function countOccurrences(haystack: string, needle: string, limit: number): number {
  let count = 0
  for (
    let index = haystack.indexOf(needle);
    index !== -1 && count < limit;
    index = haystack.indexOf(needle, index + 1)
  ) {
    count++
  }
  return count
}

/**
 * In-memory index of a vault's notes: metadata, tags and a simple full-text search. Bodies are kept
 * lower-cased in memory; a vault of thousands of notes is a few MB.
 */
export class NoteIndex {
  readonly #entries = new Map<string, Entry>()

  put(note: Note): void {
    this.#entries.set(note.id, {
      meta: toMeta(note),
      title: note.title.toLowerCase(),
      tags: note.tags.map((tag) => tag.toLowerCase()),
      body: note.body.toLowerCase(),
    })
  }

  delete(id: string): void {
    this.#entries.delete(id)
  }

  get(id: string): NoteMeta | undefined {
    return this.#entries.get(id)?.meta
  }

  has(id: string): boolean {
    return this.#entries.has(id)
  }

  /** All notes, sorted by id. */
  all(): NoteMeta[] {
    return [...this.#entries.values()].map((entry) => entry.meta).sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Notes directly inside `folder`, sorted by id. */
  inFolder(folder: string): NoteMeta[] {
    return this.all().filter((meta) => meta.folder === folder)
  }

  starred(): NoteMeta[] {
    return this.all().filter((meta) => meta.starred)
  }

  /** Tag → ids of the notes carrying it; tags sorted case-insensitively. */
  tags(): Map<string, string[]> {
    const tags = new Map<string, string[]>()
    for (const meta of this.all()) {
      for (const tag of meta.tags) {
        const ids = tags.get(tag)
        if (ids) ids.push(meta.id)
        else tags.set(tag, [meta.id])
      }
    }
    return new Map([...tags].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
  }

  withTag(tag: string): NoteMeta[] {
    return this.all().filter((meta) => meta.tags.includes(tag))
  }

  /**
   * Notes matching every token of `query`, best first. Per token: whole-word title match 10, title
   * substring 6, exact tag 8, tag prefix 4, body occurrences 1 each (max 5). A leading `#` restricts
   * a token to tags. Ties sort by most recently updated.
   */
  search(query: string, limit = 100): SearchHit[] {
    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((term) =>
        term.startsWith('#')
          ? tokenize(term.slice(1)).map((token) => ({ token, tagOnly: true }))
          : tokenize(term).map((token) => ({ token, tagOnly: false })),
      )
    if (terms.length === 0) return []
    const hits: SearchHit[] = []
    for (const entry of this.#entries.values()) {
      let total = 0
      for (const { token, tagOnly } of terms) {
        let score = 0
        if (entry.tags.includes(token)) score += 8
        else if (entry.tags.some((tag) => tag.startsWith(token))) score += 4
        if (!tagOnly) {
          if (tokenize(entry.title).includes(token)) score += 10
          else if (entry.title.includes(token)) score += 6
          score += countOccurrences(entry.body, token, 5)
        }
        if (score === 0) {
          total = 0
          break
        }
        total += score
      }
      if (total > 0) hits.push({ ...entry.meta, score: total })
    }
    return hits.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated)).slice(0, limit)
  }
}
