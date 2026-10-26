import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { editorFocused, selectionTouches } from './selection.ts'
import { BulletWidget } from './widgets.ts'

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const inlineCode = Decoration.mark({ class: 'cm-lp-inline-code' })
const linkText = (href: string) => Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href } })
const lineClass = (className: string) => Decoration.line({ class: className })

const HEADING_LEVEL = /^(?:ATX|Setext)Heading(\d)$/
const INLINE_MARKS: Record<string, string> = {
  Emphasis: 'EmphasisMark',
  StrongEmphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark',
  InlineCode: 'CodeMark',
}

/**
 * Inline live preview for `[from, to)`: styles headings, quotes, lists, code blocks and links, and hides
 * markdown markers (`#`, `*`, `_`, `` ` ``, `~~`, link brackets/URLs, `>`) unless the selection touches
 * the construct (or, for line-level markers, its line).
 */
export function buildMarkerDecorations(state: EditorState, from = 0, to = state.doc.length): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = []
  const doc = state.doc
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos)
    return selectionTouches(state, line.from, line.to)
  }
  /** Hides `[markFrom, markTo)` plus the whitespace that follows it on the same line. */
  const hideWithSpace = (markFrom: number, markTo: number) => {
    const lineEnd = doc.lineAt(markFrom).to
    let end = markTo
    while (end < lineEnd && /[ \t]/.test(doc.sliceString(end, end + 1))) end++
    if (end > markFrom) decorations.push(hidden.range(markFrom, end))
  }
  const eachLine = (node: SyntaxNode, deco: Decoration) => {
    for (let pos = node.from; pos <= node.to; ) {
      const line = doc.lineAt(pos)
      decorations.push(deco.range(line.from))
      pos = line.to + 1
    }
  }

  syntaxTree(state).iterate({
    from,
    to,
    enter(ref) {
      const node = ref.node
      const name = node.name

      const heading = HEADING_LEVEL.exec(name)
      if (heading) {
        eachLine(node, lineClass(`cm-lp-heading cm-lp-h${heading[1]}`))
        if (name.startsWith('ATX') && !lineTouched(node.from)) {
          for (const mark of node.getChildren('HeaderMark')) {
            if (mark.from === node.from) {
              hideWithSpace(mark.from, mark.to)
            } else {
              // Closing `###`: hide it and the space before it.
              let start = mark.from
              while (start > node.from && doc.sliceString(start - 1, start) === ' ') start--
              decorations.push(hidden.range(start, mark.to))
            }
          }
        }
        return undefined
      }

      const markName = INLINE_MARKS[name]
      if (markName) {
        if (name === 'InlineCode') decorations.push(inlineCode.range(node.from, node.to))
        if (!selectionTouches(state, node.from, node.to)) {
          for (const mark of node.getChildren(markName)) decorations.push(hidden.range(mark.from, mark.to))
        }
        return name === 'InlineCode' ? false : undefined
      }

      switch (name) {
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          const open = marks[0]
          const close = marks[1]
          if (!open || !close) return undefined
          const href = url ? state.sliceDoc(url.from, url.to).replace(/^<(.*)>$/, '$1') : ''
          if (close.from > open.to) decorations.push(linkText(href).range(open.to, close.from))
          if (!selectionTouches(state, node.from, node.to)) {
            decorations.push(hidden.range(open.from, open.to))
            decorations.push(hidden.range(close.from, node.to))
          }
          return undefined
        }
        case 'Autolink': {
          const url = node.getChild('URL')
          if (!url) return false
          decorations.push(linkText(state.sliceDoc(url.from, url.to)).range(url.from, url.to))
          if (!selectionTouches(state, node.from, node.to)) {
            for (const mark of node.getChildren('LinkMark')) decorations.push(hidden.range(mark.from, mark.to))
          }
          return false
        }
        case 'URL':
          // A bare GFM autolink. URLs of links are hidden with the link's `](…)` tail.
          if (node.parent?.name !== 'Link') {
            decorations.push(linkText(state.sliceDoc(node.from, node.to)).range(node.from, node.to))
          }
          return false
        case 'Image':
        case 'InlineMath':
        case 'BlockMath':
        case 'Table':
        case 'HTMLBlock':
        case 'HTMLTag':
        case 'Comment':
          return false
        case 'Escape':
          if (!selectionTouches(state, node.from, node.to)) decorations.push(hidden.range(node.from, node.from + 1))
          return false
        case 'Blockquote':
          eachLine(node, lineClass('cm-lp-blockquote'))
          return undefined
        case 'QuoteMark':
          if (!lineTouched(node.from)) hideWithSpace(node.from, node.to)
          return false
        case 'ListMark': {
          const item = node.parent
          if (item?.parent?.name === 'BulletList' && !lineTouched(node.from)) {
            if (item.getChild('Task')) hideWithSpace(node.from, node.to)
            else decorations.push(bullet.range(node.from, node.to))
          } else {
            decorations.push(Decoration.mark({ class: 'cm-lp-list-mark' }).range(node.from, node.to))
          }
          return false
        }
        case 'FencedCode':
        case 'CodeBlock': {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            const edge = `${n === first ? ' cm-lp-codeblock-first' : ''}${n === last ? ' cm-lp-codeblock-last' : ''}`
            decorations.push(lineClass(`cm-lp-codeblock${edge}`).range(doc.line(n).from))
          }
          // Fence lines (```lang / ```) collapse to padding; the language label widget stays.
          if (name === 'FencedCode' && !selectionTouches(state, doc.line(first).from, doc.line(last).to)) {
            for (const mark of node.getChildren('CodeMark')) {
              const markEnd = mark.from === node.from ? doc.lineAt(mark.from).to : mark.to
              decorations.push(hidden.range(mark.from, markEnd))
            }
          }
          return false
        }
        default:
          return undefined
      }
    },
  })
  return decorations
}

function buildForView(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) decorations.push(...buildMarkerDecorations(view.state, from, to))
  return Decoration.set(decorations, true)
}

export const livePreviewMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildForView(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.state.field(editorFocused, false) !== update.startState.field(editorFocused, false) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildForView(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
