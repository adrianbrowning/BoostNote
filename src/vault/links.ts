import * as path from 'node:path'

import { ASSETS_SUFFIX, encodeLinkPath, safeDecode } from './paths.ts'

/**
 * A note or folder that was renamed or moved, by id. A note move also covers its `<stem>.assets/`
 * folder; a folder move covers every note, asset and subfolder under it.
 */
export interface LinkMove {
  from: string
  to: string
  kind: 'note' | 'folder'
}

interface MovedPrefix {
  from: string
  to: string
  /** Only the path itself moved (a note file), not paths under it. */
  exact: boolean
}

/**
 * Inline code spans (group 1, matched only to be skipped), then markdown link/image destinations
 * (`](dest)`, `](<dest> "title")`) and HTML `src`/`href` attributes: groups 2/4 are the prefix,
 * 3/5 the destination, kept apart so only the URL changes.
 */
const LINK = /(`+)[^\n]*?(?<!`)\1(?!`)|(\]\(\s*)(<[^>\n]*>|[^\s)]+)|(\b(?:src|href)\s*=\s*["'])([^"'\n]+)/g

function isRelative(destination: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination)
}

/** Calls `transform` on every line outside fenced code blocks. */
function mapOutsideCode(markdown: string, transform: (line: string) => string): string {
  let fence: string | undefined
  return markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (match?.[1]) {
        const marker = match[1]
        if (fence === undefined) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
        return line
      }
      return fence === undefined ? transform(line) : line
    })
    .join('')
}

/**
 * Rewrites relative link destinations outside code blocks and code spans. `map` receives the
 * decoded path (no `#fragment`/`?query`) and returns a replacement path, or `undefined` to keep
 * the link as is. `onOther` sees the destinations that are not relative paths (URLs, absolute
 * paths; not same-note `#anchors`), which are always kept.
 */
export function rewriteRelativeLinks(
  markdown: string,
  map: (relPath: string) => string | undefined,
  onOther?: (destination: string) => void,
): string {
  return mapOutsideCode(markdown, (line) =>
    line.replace(
      LINK,
      (whole, code?: string, mdPrefix?: string, mdDest?: string, htmlPrefix?: string, htmlDest?: string) => {
        if (code !== undefined) return whole
        const prefix = mdPrefix ?? htmlPrefix ?? ''
        const raw = mdDest ?? htmlDest ?? ''
        const bracketed = raw.startsWith('<') && raw.endsWith('>')
        const destination = bracketed ? raw.slice(1, -1) : raw
        if (!isRelative(destination)) {
          if (!destination.startsWith('#')) onOther?.(destination)
          return whole
        }
        const suffixIndex = destination.search(/[#?]/)
        let pathPart = suffixIndex === -1 ? destination : destination.slice(0, suffixIndex)
        let suffix = suffixIndex === -1 ? '' : destination.slice(suffixIndex)
        // `note.md/#anchor` (common in notes copied from GitHub) is a link to `note.md`.
        if (/\.md\/$/i.test(pathPart)) {
          pathPart = pathPart.slice(0, -1)
          suffix = `/${suffix}`
        }
        if (pathPart === '') return whole
        const next = map(safeDecode(pathPart))
        if (next === undefined) return whole
        const encoded = bracketed ? `<${next}${suffix}>` : `${encodeLinkPath(next)}${suffix}`
        return `${prefix}${encoded}`
      },
    ),
  )
}

/** The paths `moves` relocate, longest first, so the most specific move wins. */
function movedPrefixes(moves: readonly LinkMove[]): MovedPrefix[] {
  return moves
    .flatMap((move): MovedPrefix[] =>
      move.kind === 'note'
        ? [
            { from: move.from, to: move.to, exact: true },
            {
              from: move.from.replace(/\.md$/, ASSETS_SUFFIX),
              to: move.to.replace(/\.md$/, ASSETS_SUFFIX),
              exact: false,
            },
          ]
        : [{ from: move.from, to: move.to, exact: false }],
    )
    .sort((a, b) => b.from.length - a.from.length)
}

/** Where the vault path `target` is after the moves, or `undefined` when none of them moved it. */
function movedTarget(target: string, prefixes: readonly MovedPrefix[]): string | undefined {
  for (const prefix of prefixes) {
    if (target === prefix.from || (!prefix.exact && target.startsWith(`${prefix.from}/`))) {
      return prefix.to + target.slice(prefix.from.length)
    }
  }
  return undefined
}

/**
 * Rewrites a note's relative links after it moved from `fromId` to `toId` as part of `moves`
 * (by default just itself): links to anything that moved too (the note itself, its assets folder,
 * a moved folder's contents) follow it, and the other relative links are re-based on the new
 * folder. Links that would leave the vault are left alone.
 */
export function rebaseNoteLinks(
  markdown: string,
  fromId: string,
  toId: string,
  moves: readonly LinkMove[] = [{ from: fromId, to: toId, kind: 'note' }],
): string {
  if (fromId === toId) return markdown
  const fromDir = path.posix.dirname(fromId)
  const toDir = path.posix.dirname(toId)
  const prefixes = movedPrefixes(moves)
  return rewriteRelativeLinks(markdown, (relPath) => {
    const old = path.posix.normalize(path.posix.join(fromDir, relPath))
    if (old === '..' || old.startsWith('../')) return undefined
    const relative = path.posix.relative(toDir, movedTarget(old, prefixes) ?? old)
    if (relative === '') return undefined
    const next = relative.startsWith('../') ? relative : `./${relative}`
    const current = relPath.startsWith('./') || relPath.startsWith('../') ? relPath : `./${relPath}`
    return path.posix.normalize(next) === path.posix.normalize(current) ? undefined : next
  })
}

/**
 * Rewrites the relative links of a note in folder `dir` that point at (or into) something `moves`
 * relocated. `./` is kept where the link had it; returns the new body and how many links changed.
 */
export function rewriteMovedLinks(
  markdown: string,
  dir: string,
  moves: readonly LinkMove[],
): { body: string; links: number } {
  const prefixes = movedPrefixes(moves)
  let links = 0
  const body = rewriteRelativeLinks(markdown, (relPath) => {
    const next = movedTarget(path.posix.normalize(path.posix.join(dir, relPath)), prefixes)
    if (next === undefined) return undefined
    links++
    const relative = path.posix.relative(dir, next)
    return relPath.startsWith('./') && !relative.startsWith('../') ? `./${relative}` : relative
  })
  return { body, links }
}
