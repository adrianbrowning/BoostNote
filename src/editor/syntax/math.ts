import { tags } from '@lezer/highlight'
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'

const DOLLAR = 36
const SPACE = /\s/

/** `line.depth` is not in the public typings; FencedCode uses it to stop at the end of its container. */
interface ContainerAware {
  depth: number
}

/**
 * KaTeX-style math for `@lezer/markdown`:
 * - `InlineMath`: `$x^2$` (no space after the opening or before the closing `$`, closing `$` not followed by a digit,
 *   so prices like `$5 and $6` stay text). `$$x$$` on one line inside a paragraph is inline display math.
 * - `BlockMath`: a block starting with `$$` and ending at the next line that ends with `$$` (or the same line).
 * Both carry `MathMark` children for the delimiters; the TeX source is everything between them.
 */
export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: tags.special(tags.string) },
    { name: 'BlockMath', block: true, style: tags.special(tags.string) },
    { name: 'MathMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Escape',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== DOLLAR) return -1
        const double = cx.char(pos + 1) === DOLLAR
        const markLen = double ? 2 : 1
        const contentStart = pos + markLen
        if (contentStart >= cx.end || SPACE.test(cx.slice(contentStart, contentStart + 1))) return -1
        if (cx.char(pos - 1) === DOLLAR) return -1
        for (let i = contentStart; i < cx.end; i++) {
          const ch = cx.char(i)
          if (ch === 92 /* \ */) {
            i++
            continue
          }
          if (ch !== DOLLAR) continue
          if (double) {
            if (cx.char(i + 1) !== DOLLAR) continue
          } else if (cx.char(i + 1) === DOLLAR || (cx.char(i + 1) >= 48 && cx.char(i + 1) <= 57)) {
            continue
          }
          if (SPACE.test(cx.slice(i - 1, i)) || i === contentStart) return -1
          const end = i + markLen
          return cx.addElement(
            cx.elt('InlineMath', pos, end, [cx.elt('MathMark', pos, contentStart), cx.elt('MathMark', i, end)]),
          )
        }
        return -1
      },
    },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx: BlockContext, line: Line) {
        if (!isMathFence(line)) return false
        const from = cx.lineStart + line.pos
        const marks: Element[] = [cx.elt('MathMark', from, from + 2)]
        const rest = line.text.slice(line.pos + 2)
        const closeOnFirst = rest.trimEnd().endsWith('$$') && rest.trim().length >= 2
        if (closeOnFirst) {
          const closeAt = cx.lineStart + line.pos + 2 + rest.trimEnd().length - 2
          marks.push(cx.elt('MathMark', closeAt, closeAt + 2))
          cx.nextLine()
          cx.addElement(cx.elt('BlockMath', from, closeAt + 2, marks))
          return true
        }
        const depth = cx.depth
        let end = cx.lineStart + line.text.length
        while (cx.nextLine() && (line as unknown as ContainerAware).depth >= depth) {
          for (const marker of line.markers) marks.push(marker)
          const trimmed = line.text.trimEnd()
          end = cx.lineStart + line.text.length
          if (trimmed.endsWith('$$') && trimmed.length - 2 >= line.pos) {
            const closeAt = cx.lineStart + trimmed.length - 2
            marks.push(cx.elt('MathMark', closeAt, closeAt + 2))
            end = closeAt + 2
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('BlockMath', from, end, marks))
        return true
      },
      endLeaf: (_cx, line) => isMathFence(line),
    },
  ],
}

function isMathFence(line: Line): boolean {
  return line.indent - line.baseIndent < 4 && line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR
}
