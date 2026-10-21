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

function excerptOf(body: string): string {
  const lines: string[] = []
  let length = 0
  let skippedTitle = false
  for (const line of body.split(/\r?\n/)) {
    const text = stripInline(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, ''))
    if (text === '' || /^(?:`{3,}|~{3,}|-{3,}|\*{3,}|\|[-:| ]+\|?)$/.test(text)) continue
    if (!skippedTitle && /^\s*#\s/.test(line)) {
      skippedTitle = true
      continue
    }
    lines.push(text)
    length += text.length + 1
    if (length >= 200) break
  }
  const excerpt = lines.join(' ')
  return excerpt.length > 200 ? `${excerpt.slice(0, 199)}…` : excerpt
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
