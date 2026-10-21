import { createHash } from 'node:crypto'

import type { Frontmatter, NoteText } from './frontmatter.ts'
import { noteFolder, noteStem } from './paths.ts'

/** What the index and lists know about a note. */
export interface NoteMeta {
  /** POSIX path relative to the vault root, e.g. `work/todo.md`. */
  id: string
  /** Folder id (`''` for the vault root). */
  folder: string
  title: string
  tags: string[]
  starred: boolean
  /** ISO-8601; frontmatter `created`, else the file's birth time. */
  created: string
  /** ISO-8601; frontmatter `updated`, else the file's modification time. */
  updated: string
  excerpt: string
}

/** A note as read from disk. */
export interface Note extends NoteMeta {
  frontmatter: Frontmatter
  body: string
  /** The whole file, exactly as read. */
  raw: string
  /** sha256 (hex) of `raw`; lets callers detect that the file changed under them. */
  hash: string
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Text of the first ATX `# H1` outside fenced code blocks, with inline markup stripped. */
export function findH1(body: string): string | undefined {
  let fence: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const heading = /^ {0,3}#(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (heading) {
      const title = stripInline(heading[1] ?? '')
      if (title !== '') return title
    }
  }
  return undefined
}

function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

/** The title a note gets without a frontmatter `title`: its first H1, else the file stem. */
export function fallbackTitle(id: string, body: string): string {
  return findH1(body) ?? noteStem(id)
}

function readTags(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(/[,\s]+/) : Array.isArray(value) ? value : []
  const tags: string[] = []
  for (const tag of raw) {
    const text = typeof tag === 'string' || typeof tag === 'number' ? String(tag).trim() : ''
    if (text !== '' && !tags.includes(text)) tags.push(text)
  }
  return tags
}

function readDate(value: unknown, fallback: Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return fallback.toISOString()
}

/** Length of a note-list excerpt, ellipsis included. */
export const EXCERPT_LENGTH = 160

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Removes block-level markers: quotes, headings, list bullets/numbers and task boxes. */
function stripBlockMarkers(line: string): string {
  let text = line
  for (;;) {
    const next = text
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*#{1,6}(?:\s+|$)/, '')
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')
      .replace(/^\s*\[[ xX]\]\s+/, '')
    if (next === text) return text.replace(/\s+#+\s*$/, '')
    text = next
  }
}

/** Inline markdown → plain text: images and HTML dropped, links reduced to their text, markers removed. */
function plainInline(text: string): string {
  // Escaped punctuation is parked in the Private Use Area so no marker rule touches it.
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>$])/g, (_match, char: string) =>
      String.fromCharCode(0xe000 + char.charCodeAt(0)),
    )
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, ' ')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/[\ue000-\ue07f]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xe000))
}

/**
 * Plain-text preview of a body for the note list: no frontmatter (invalid YAML stays in the body),
 * code blocks, math blocks, HTML, images, link URLs or markdown markers; the first H1 (the title in
 * most notes) is skipped; whitespace collapsed; at most `EXCERPT_LENGTH` characters.
 */
export function excerptOf(body: string): string {
  const text = body
    .replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const parts: string[] = []
  let length = 0
  let fence: string | undefined
  let math = false
  let skippedTitle = false
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1]
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    if (/^\s*\$\$/.test(line)) {
      if (!/^\s*\$\$.*\S.*\$\$\s*$/.test(line)) math = !math
      continue
    }
    if (math) continue
    if (!skippedTitle && /^ {0,3}#[ \t]/.test(line)) {
      skippedTitle = true
      continue
    }
    // Thematic breaks, setext underlines, table delimiter rows, link reference definitions.
    if (/^ {0,3}(?:(?:[-*_][ \t]*){3,}|=+[ \t]*)$/.test(line)) continue
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-')) continue
    if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(line)) continue
    const plain = plainInline(stripBlockMarkers(line)).replace(/\s+/g, ' ').trim()
    if (plain === '') continue
    parts.push(plain)
    length += plain.length + 1
    if (length > EXCERPT_LENGTH) break
  }
  const excerpt = parts.join(' ')
  return excerpt.length > EXCERPT_LENGTH ? `${excerpt.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : excerpt
}

/** Builds a `Note` from a parsed file. `stats` supplies date fallbacks for notes without frontmatter dates. */
export function toNote(id: string, raw: string, text: NoteText, stats: { birthtime: Date; mtime: Date }): Note {
  const { frontmatter, body } = text
  const title =
    typeof frontmatter.title === 'string' && frontmatter.title.trim() !== ''
      ? frontmatter.title.trim()
      : fallbackTitle(id, body)
  return {
    id,
    folder: noteFolder(id),
    title,
    tags: readTags(frontmatter.tags),
    starred: frontmatter.starred === true,
    created: readDate(frontmatter.created, stats.birthtime),
    updated: readDate(frontmatter.updated, stats.mtime),
    excerpt: excerptOf(body),
    frontmatter,
    body,
    raw,
    hash: hashText(raw),
  }
}

export function toMeta(note: Note): NoteMeta {
  const { id, folder, title, tags, starred, created, updated, excerpt } = note
  return { id, folder, title, tags, starred, created, updated, excerpt }
}
