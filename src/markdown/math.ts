import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it'

const DOLLAR = 0x24
const BACKSLASH = 0x5c
const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

/**
 * Inline math with the editor's rules (`src/editor/syntax/math.ts`): `$x$` needs no space after the
 * opening or before the closing `$`, and the closing `$` must not be followed by a digit, so
 * `$5 and $6` stays text. `$$x$$` inside a paragraph is inline display math.
 */
function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state
  if (src.charCodeAt(pos) !== DOLLAR) return false
  const double = src.charCodeAt(pos + 1) === DOLLAR
  const markLen = double ? 2 : 1
  const contentStart = pos + markLen
  if (contentStart >= posMax || isSpace(src.charCodeAt(contentStart))) return false
  if (pos > 0 && src.charCodeAt(pos - 1) === DOLLAR) return false
  for (let i = contentStart; i < posMax; i++) {
    const code = src.charCodeAt(i)
    if (code === BACKSLASH) {
      i++
      continue
    }
    if (code !== DOLLAR) continue
    const next = src.charCodeAt(i + 1)
    if (double) {
      if (next !== DOLLAR) continue
    } else if (next === DOLLAR || (next >= 0x30 && next <= 0x39)) {
      continue
    }
    if (i === contentStart || isSpace(src.charCodeAt(i - 1))) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = src.slice(contentStart, i)
      token.markup = double ? '$$' : '$'
    }
    state.pos = i + markLen
    return true
  }
  return false
}

/**
 * Block math: a block starting with `$$` that ends at the first line ending with `$$` (possibly the
 * same line); unclosed, it runs to the end of its container, as in the editor.
 */
function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0)
  const max = state.eMarks[startLine] ?? 0
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false
  if (state.src.charCodeAt(start) !== DOLLAR || state.src.charCodeAt(start + 1) !== DOLLAR) return false
  if (silent) return true

  const firstRest = state.src.slice(start + 2, max)
  const lines: string[] = []
  let nextLine = startLine
  let closed = false
  if (firstRest.trimEnd().endsWith('$$') && firstRest.trim().length >= 2) {
    lines.push(firstRest.trimEnd().slice(0, -2))
    closed = true
  } else {
    lines.push(firstRest)
  }
  while (!closed) {
    nextLine++
    if (nextLine >= endLine) break
    const lineStart = (state.bMarks[nextLine] ?? 0) + (state.tShift[nextLine] ?? 0)
    const lineEnd = state.eMarks[nextLine] ?? 0
    // A less-indented non-empty line ends the container (list item, quote) and with it the math.
    if (lineStart < lineEnd && (state.sCount[nextLine] ?? 0) < state.blkIndent) break
    const text = state.src.slice(lineStart, lineEnd).trimEnd()
    if (text.endsWith('$$')) {
      lines.push(text.slice(0, -2))
      closed = true
    } else {
      lines.push(text)
    }
  }

  state.line = Math.min(nextLine + 1, endLine)
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = lines.join('\n').trim()
  token.markup = '$$'
  token.map = [startLine, state.line]
  return true
}

/** Adds `math_inline` and `math_block` tokens; rendering is the renderer's job (KaTeX). */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', inlineMath)
  md.block.ruler.before('fence', 'math_block', blockMath, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
}
