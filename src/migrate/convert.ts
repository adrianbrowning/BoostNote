import { safeDecode } from '../vault/paths.ts'
import type { LegacyNote } from './legacy.ts'

/** CodeMirror mode names/ids the legacy app stored → fenced-code language. */
const LANGUAGE_BY_MODE: Record<string, string> = {
  'plain text': 'text',
  text: 'text',
  null: 'text',
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  'objective-c': 'objectivec',
  'objective c': 'objectivec',
  objectivec: 'objectivec',
  'github flavored markdown': 'markdown',
  gfm: 'markdown',
  htmlmixed: 'html',
  'embedded javascript': 'ejs',
  ejs: 'ejs',
  'embedded ruby': 'erb',
  html_ruby: 'erb',
  shell: 'bash',
  sh: 'bash',
  'unix shell': 'bash',
  mysql: 'sql',
  'ms sql': 'sql',
  'mariadb sql': 'sql',
  postgresql: 'sql',
  jinja2: 'jinja',
  tsx: 'tsx',
  'typescript-jsx': 'tsx',
  'json-ld': 'json',
  'protocol buffers': 'protobuf',
}

/** Fenced-code language for a legacy snippet mode (`'JavaScript'` → `javascript`, `'C++'` → `cpp`). */
export function languageForMode(mode: string | null | undefined): string {
  const key = (mode ?? '').trim().toLowerCase()
  if (key === '') return 'text'
  return LANGUAGE_BY_MODE[key] ?? (key.replace(/\s+/g, '-').replace(/[^a-z0-9+#_-]/g, '') || 'text')
}

function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Markdown for a snippet note: `# title`, the description, then `## name` and a fenced block per
 * snippet. Highlighted lines are dropped.
 */
export function snippetToMarkdown(title: string, note: LegacyNote): string {
  const parts = [`# ${title}`]
  const description = (note.description ?? '').trimEnd()
  if (description.trim() !== '') parts.push(description)
  for (const [index, snippet] of (note.snippets ?? []).entries()) {
    const name = (snippet.name ?? '').trim() || `Snippet ${index + 1}`
    const content = (snippet.content ?? '').replace(/\n$/, '')
    const fence = fenceFor(content)
    parts.push(`## ${name}`, `${fence}${languageForMode(snippet.mode)}\n${content}\n${fence}`)
  }
  return `${parts.join('\n\n')}\n`
}

/** Title of a legacy markdown note computed the way the legacy app did (first heading, else first line). */
export function legacyContentTitle(content: string): string {
  const lines = content.split('\n')
  let start = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end !== -1) start = end + 1
  }
  let inCode = false
  for (let index = start; index < lines.length; index++) {
    const line = (lines[index] ?? '').trim()
    if (line.includes('```')) inCode = !inCode
    if (!inCode && (/^# +/.test(line) || /^=+$/.test((lines[index + 1] ?? '').trim()))) {
      return line.replace(/^#\s+/, '').trim()
    }
  }
  return (
    lines
      .slice(start)
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}

/**
 * Legacy attachment references: `:storage/<noteKey>/<file>` (and `/:storage…`) with `/`, `\`,
 * `%2F` or `%5C` separators. Very old notes use `:storage/<file>` for files in `images/`.
 */
export const STORAGE_REFERENCE = /\/?:storage(?:[\\/]|%5[cC]|%2[fF])[^"'()<>\s]+/g

/** Path segments (decoded) of a `STORAGE_REFERENCE` match. */
export function storageReferenceSegments(reference: string): string[] {
  return reference
    .replace(/^\/?:storage/, '')
    .replace(/%5[cC]|%2[fF]|\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(safeDecode)
}
/** Legacy inter-note link target: `:note:<key>` (hex key or UUID). */
export const NOTE_LINK = /:note:([a-zA-Z0-9-]{20,36})/g
