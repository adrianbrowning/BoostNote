/**
 * Scratch-note rules shared by main and the browser. Browser-safe: no `node:` imports. A scratch
 * note lives outside every vault (`<userData>/scratch/<id>.md`, see `ScratchStore`); its file is the
 * text as typed, so its title comes from that text.
 */

/** An ATX heading (`# Title`, `## Title ##`), indented at most three spaces; group 1 is its text. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
/** The opening or closing line of a fenced code block; group 1 is the fence (```` ``` ```` or `~~~`, or longer). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** The opening line of a leading frontmatter block, as `parseNoteText` finds it. */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/

/**
 * `text` without a leading frontmatter block: a first `---` line and a later `---` or `...` line closing it, the
 * fences `parseNoteText` uses. A plain text check: the YAML in between is not read. Unclosed, it is all text.
 */
function withoutFrontmatter(text: string): string {
  const open = FRONTMATTER_OPEN.exec(text)
  if (!open) return text
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm
  close.lastIndex = open[0].length
  const match = close.exec(text)
  return match ? text.slice(match.index + match[0].length) : text
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * A scratch note's title, a leading frontmatter block skipped (`withoutFrontmatter`): the text of its first ATX
 * heading outside fenced code, else its first non-blank line trimmed, else `Scratch YYYY-MM-DD HH:mm` for `created`
 * (ISO-8601) in local time. The scratch list, the scratch tab and Save to vault all name a scratch note with it.
 */
export function scratchTitle(text: string, created: string): string {
  const lines = withoutFrontmatter(text).split(/\r?\n/)
  let fence: string | undefined
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined
      }
      continue
    }
    if (marker !== undefined) {
      fence = marker
      continue
    }
    const heading = HEADING.exec(line)?.[1]?.trim()
    // `# #`, `## ##`: one space between, so the closing sequence came out as the text; an empty heading, skipped.
    if (heading && !/^#+$/.test(heading)) return heading
  }
  const first = lines.find((line) => line.trim() !== '')
  if (first !== undefined) return first.trim()
  const date = new Date(created)
  return `Scratch ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
