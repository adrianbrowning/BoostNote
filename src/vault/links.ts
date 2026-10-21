import * as path from 'node:path'

import { encodeLinkPath, safeDecode } from './paths.ts'

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
 * the link as is.
 */
export function rewriteRelativeLinks(markdown: string, map: (relPath: string) => string | undefined): string {
  return mapOutsideCode(markdown, (line) =>
    line.replace(
      LINK,
      (whole, code?: string, mdPrefix?: string, mdDest?: string, htmlPrefix?: string, htmlDest?: string) => {
        if (code !== undefined) return whole
        const prefix = mdPrefix ?? htmlPrefix ?? ''
        const raw = mdDest ?? htmlDest ?? ''
        const bracketed = raw.startsWith('<') && raw.endsWith('>')
        const destination = bracketed ? raw.slice(1, -1) : raw
        if (!isRelative(destination)) return whole
        const suffixIndex = destination.search(/[#?]/)
        const pathPart = suffixIndex === -1 ? destination : destination.slice(0, suffixIndex)
        const suffix = suffixIndex === -1 ? '' : destination.slice(suffixIndex)
        if (pathPart === '') return whole
        const next = map(safeDecode(pathPart))
        if (next === undefined) return whole
        const encoded = bracketed ? `<${next}${suffix}>` : `${encodeLinkPath(next)}${suffix}`
        return `${prefix}${encoded}`
      },
    ),
  )
}

/**
 * Rewrites a note's relative links after it moved from `fromId` to `toId`: links into its own
 * `<stem>.assets/` follow the renamed assets directory, and other relative links are re-based on
 * the new folder. Links that would leave the vault are left alone.
 */
export function rebaseNoteLinks(markdown: string, fromId: string, toId: string): string {
  const fromDir = path.posix.dirname(fromId)
  const toDir = path.posix.dirname(toId)
  const fromAssets = `${path.posix.join(fromDir, path.posix.basename(fromId, '.md'))}.assets`
  const toAssets = `${path.posix.join(toDir, path.posix.basename(toId, '.md'))}.assets`
  if (fromDir === toDir && fromAssets === toAssets) return markdown
  return rewriteRelativeLinks(markdown, (relPath) => {
    let target = path.posix.normalize(path.posix.join(fromDir, relPath))
    if (target === '..' || target.startsWith('../')) return undefined
    if (target === fromAssets || target.startsWith(`${fromAssets}/`))
      target = toAssets + target.slice(fromAssets.length)
    const relative = path.posix.relative(toDir, target)
    const next = relative.startsWith('../') ? relative : `./${relative}`
    const current = relPath.startsWith('./') || relPath.startsWith('../') ? relPath : `./${relPath}`
    return path.posix.normalize(next) === path.posix.normalize(current) ? undefined : next
  })
}
