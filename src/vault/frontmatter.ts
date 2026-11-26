import { isDeepStrictEqual } from 'node:util'
import { isMap, isNode, isScalar, parseDocument, stringify } from 'yaml'

/** Frontmatter as a plain object; key order is insertion order and is preserved on write. */
export type Frontmatter = Record<string, unknown>

/** `value` as JSON clients see it. YAML is parsed with the core schema, so this is lossless except for `.nan`/`.inf`. */
export function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? 'null')
}

/**
 * `next` with each value that equals its `previous` value after a JSON round trip replaced by the
 * previous value, so frontmatter sent back unchanged by a JSON client keeps its YAML (e.g. `.nan`).
 */
export function keepUnchangedValues(previous: Frontmatter, next: Frontmatter): Frontmatter {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => {
      const original = previous[key]
      return [key, Object.hasOwn(previous, key) && isDeepStrictEqual(toJsonValue(original), value) ? original : value]
    }),
  )
}

/** A note file split into its frontmatter block and body. */
export interface NoteText {
  frontmatter: Frontmatter
  /** YAML between the fences exactly as written, or `null` when the file has no (valid) frontmatter. */
  yaml: string | null
  /** Everything after the closing fence line, byte for byte. */
  body: string
  /** Opening/closing fence lines including their line breaks, reused on write. */
  fences: { open: string; close: string }
}

const DEFAULT_FENCES = { open: '---\n', close: '---\n' }
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const

/**
 * Splits `raw` into frontmatter and body. A file only has frontmatter when it starts with a `---`
 * line, a later `---`/`...` line closes it, and the YAML in between is a mapping. Anything else
 * (including invalid YAML) is treated as body so nothing is ever lost.
 */
export function parseNoteText(raw: string): NoteText {
  const open = /^---[ \t]*(\r?\n)/.exec(raw)
  if (open) {
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm
    closing.lastIndex = open[0].length
    // An empty block closes on the line right after the opening fence.
    const match = closing.exec(raw)
    if (match) {
      const yaml = raw.slice(open[0].length, match.index)
      const frontmatter = parseYamlMapping(yaml)
      if (frontmatter) {
        return {
          frontmatter,
          yaml,
          body: raw.slice(match.index + match[0].length),
          fences: { open: open[0], close: match[0] },
        }
      }
    }
  }
  return { frontmatter: {}, yaml: null, body: raw, fences: DEFAULT_FENCES }
}

function parseYamlMapping(yaml: string): Frontmatter | undefined {
  if (yaml.trim() === '') return {}
  const doc = parseDocument(yaml)
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined
  try {
    const value = toMapping(doc.toJS())
    // A recursive alias (`a: &a {self: *a}`) gives a cyclic value, which no note document can carry.
    JSON.stringify(value)
    return value
  } catch {
    // An unresolved alias, an alias bomb or a recursive alias is not reported in `doc.errors`; it is still invalid
    // frontmatter, left in the body.
    return undefined
  }
}

/**
 * Serialises a note. When `previous` is the parsed form of the file being replaced, the original
 * YAML text is edited in place: unchanged keys keep their exact bytes (quoting, comments, flow
 * style), changed keys are rewritten where they stand, removed keys are dropped and new keys are
 * appended. An empty frontmatter on a file that had none produces just the body.
 */
export function serializeNoteText(frontmatter: Frontmatter, body: string, previous?: NoteText): string {
  const yaml = previous?.yaml ?? null
  if (yaml === null && Object.keys(frontmatter).length === 0) return body
  const fences = previous?.fences ?? DEFAULT_FENCES
  let text = yaml === null ? stringifyMapping(frontmatter) : updateYaml(yaml, previous?.frontmatter ?? {}, frontmatter)
  if (text !== '' && !text.endsWith('\n')) text += '\n'
  const close = fences.close.endsWith('\n') || body === '' ? fences.close : `${fences.close}\n`
  return `${fences.open}${text}${close}${body}`
}

function stringifyMapping(frontmatter: Frontmatter): string {
  return Object.keys(frontmatter).length === 0 ? '' : stringify(frontmatter, STRINGIFY_OPTIONS)
}

/** Edits `yaml` (whose parsed value is `before`) so that it parses to `after`; see `serializeNoteText`. */
export function updateYaml(yaml: string, before: Frontmatter, after: Frontmatter): string {
  if (isDeepStrictEqual(before, after) && isDeepStrictEqual(Object.keys(before), Object.keys(after))) return yaml
  const spliced = spliceYaml(yaml, after)
  if (spliced !== undefined && isDeepStrictEqual(parseYamlMapping(spliced), after)) return spliced
  // Unusual layouts (flow mappings, anchors, reordered keys): re-emit through the document model,
  // which still keeps comments; keys follow `after`'s order.
  const doc = parseDocument(yaml)
  if (!isMap(doc.contents)) return stringifyMapping(after)
  const current = toMapping(doc.toJS())
  for (const key of Object.keys(current)) {
    if (!(key in after)) doc.delete(key)
  }
  for (const [key, value] of Object.entries(after)) {
    if (!isDeepStrictEqual(current[key], value)) doc.set(key, value)
  }
  const order = Object.keys(after)
  const map = doc.contents
  map.items.sort(
    (a, b) =>
      order.indexOf(String(isScalar(a.key) ? a.key.value : a.key)) -
      order.indexOf(String(isScalar(b.key) ? b.key.value : b.key)),
  )
  // A reorder can put an alias before its anchor: then the block cannot be written or parsed, so it is written anew.
  let text: string
  try {
    text = doc.toString(STRINGIFY_OPTIONS)
  } catch {
    return stringifyMapping(after)
  }
  return isDeepStrictEqual(parseYamlMapping(text), after) ? text : stringifyMapping(after)
}

/** `keys` in the order a JS object built from them in that order lists them (array-index keys first, ascending). */
function jsKeyOrder(keys: string[]): string[] {
  return Object.keys(Object.fromEntries(keys.map((key) => [key, true])))
}

function toMapping(value: unknown): Frontmatter {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

interface PairSpan {
  key: string
  /** Start of the key. */
  start: number
  /** End of the value (before any trailing comment). */
  end: number
}

/** Text-level edit of a block mapping; `undefined` when the layout is not simple enough. */
function spliceYaml(yaml: string, after: Frontmatter): string | undefined {
  const doc = parseDocument(yaml)
  const map = doc.contents
  if (doc.errors.length > 0 || !isMap(map) || map.flow) return undefined
  const spans: PairSpan[] = []
  for (const item of map.items) {
    if (!isScalar(item.key) || !item.key.range) return undefined
    const end = isNode(item.value) && item.value.range ? item.value.range[1] : item.key.range[1]
    spans.push({ key: String(item.key.value), start: item.key.range[0], end })
  }
  const beforeKeys = spans.map((span) => span.key)
  const kept = Object.keys(after).filter((key) => beforeKeys.includes(key))
  // `after` lists array-index keys first, as every JS object does: an unchanged YAML order reads that way too.
  if (!isDeepStrictEqual(kept, jsKeyOrder(beforeKeys.filter((key) => key in after)))) return undefined
  const before = toMapping(doc.toJS())
  let text = yaml
  // Apply from the end so earlier offsets stay valid.
  for (const span of [...spans].reverse()) {
    if (!(span.key in after)) {
      const lineStart = text.lastIndexOf('\n', span.start - 1) + 1
      const newline = text.indexOf('\n', span.end)
      text = text.slice(0, lineStart) + text.slice(newline === -1 ? text.length : newline + 1)
    } else if (!isDeepStrictEqual(before[span.key], after[span.key])) {
      const replacement = stringify({ [span.key]: after[span.key] }, STRINGIFY_OPTIONS).replace(/\n$/, '')
      text = text.slice(0, span.start) + replacement + text.slice(span.end)
    }
  }
  const added = Object.fromEntries(Object.entries(after).filter(([key]) => !beforeKeys.includes(key)))
  if (Object.keys(added).length > 0) {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += stringify(added, STRINGIFY_OPTIONS)
  }
  return text
}
