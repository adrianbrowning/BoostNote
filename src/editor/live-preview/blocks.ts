import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, type WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { editorHost, editorTheme, isExternalUrl } from '../config.ts'
import { renderInlineMarkdown } from '../render/inline.ts'
import { selectionTouches } from './selection.ts'
import {
  CheckboxWidget,
  CodeLanguageWidget,
  HorizontalRuleWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
} from './widgets.ts'

const MATH_FENCES: Record<string, true> = { math: true, latex: true, katex: true, tex: true }

/**
 * Widgets that replace source: images, task checkboxes, horizontal rules, tables, math and mermaid.
 * Each one shows its source again while the selection touches it. Block widgets span whole lines, so
 * they must come from a state field rather than a view plugin.
 */
export const previewWidgets = StateField.define<DecorationSet>({
  create: (state) => buildPreviewWidgets(state),
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.facet(editorTheme) !== tr.startState.facet(editorTheme)
    ) {
      return buildPreviewWidgets(tr.state)
    }
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function buildPreviewWidgets(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const doc = state.doc
  const host = state.facet(editorHost)
  const theme = state.facet(editorTheme)

  /** Replaces the node's full lines, unless something other than indentation precedes it (a quote or list marker). */
  const addBlock = (node: SyntaxNode, widget: WidgetType) => {
    const first = doc.lineAt(node.from)
    if (doc.sliceString(first.from, node.from).trim() !== '') return
    const to = doc.lineAt(node.to).to
    if (selectionTouches(state, first.from, to)) return
    decorations.push(Decoration.replace({ widget, block: true }).range(first.from, to))
  }

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node
      switch (node.name) {
        case 'Image': {
          if (selectionTouches(state, node.from, node.to)) return false
          const image = parseImage(state, node)
          if (!image) return false
          const src = isExternalUrl(image.url) ? image.url : host.resolveAssetUrl(image.url)
          decorations.push(
            Decoration.replace({ widget: new ImageWidget(src, image.alt, image.width, image.height) }).range(
              node.from,
              node.to,
            ),
          )
          return false
        }
        case 'TaskMarker': {
          if (selectionTouches(state, node.from, node.to)) return false
          const checked = state.sliceDoc(node.from + 1, node.from + 2).toLowerCase() === 'x'
          decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
          const task = node.parent
          if (checked && task && node.to < task.to) {
            decorations.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(node.to, task.to))
          }
          return false
        }
        case 'HorizontalRule': {
          const line = doc.lineAt(node.from)
          if (selectionTouches(state, line.from, line.to)) return false
          decorations.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(node.from, node.to))
          return false
        }
        case 'Table':
          addBlock(node, new TableWidget(renderTable(state, node, host.resolveAssetUrl)))
          return false
        case 'BlockMath':
          addBlock(node, new MathWidget(mathSource(state, node), true))
          return false
        case 'InlineMath':
          if (!selectionTouches(state, node.from, node.to)) {
            decorations.push(
              Decoration.replace({ widget: new MathWidget(mathSource(state, node), false) }).range(node.from, node.to),
            )
          }
          return false
        case 'FencedCode': {
          const infoNode = node.getChild('CodeInfo')
          const info = infoNode ? state.sliceDoc(infoNode.from, infoNode.to).trim() : ''
          const language = info.split(/\s/)[0]?.toLowerCase() ?? ''
          if (language === 'mermaid') {
            addBlock(node, new MermaidWidget(fenceSource(state, node), theme))
          } else if (MATH_FENCES[language]) {
            addBlock(node, new MathWidget(fenceSource(state, node), true))
          } else if (language) {
            const firstLine = doc.lineAt(node.from)
            decorations.push(
              Decoration.widget({ widget: new CodeLanguageWidget(language), side: 1 }).range(firstLine.to),
            )
          }
          return false
        }
        default:
          return undefined
      }
    },
  })

  return Decoration.set(decorations, true)
}

interface ParsedImage {
  url: string
  alt: string
  width?: number
  height?: number
}

/** `![alt](url "title")`; `![alt|200](url)` and `![alt|200x100](url)` set the display size (Obsidian style). */
function parseImage(state: EditorState, node: SyntaxNode): ParsedImage | undefined {
  const url = node.getChild('URL')
  const marks = node.getChildren('LinkMark')
  if (!url || marks.length < 2) return undefined
  let rawUrl = state.sliceDoc(url.from, url.to)
  if (rawUrl.startsWith('<') && rawUrl.endsWith('>')) rawUrl = rawUrl.slice(1, -1)
  const altText = state.sliceDoc(marks[0]?.to, marks[1]?.from)
  const size = /\|(\d+)(?:x(\d+))?\s*$/.exec(altText)
  if (!size) return { url: rawUrl, alt: altText }
  return {
    url: rawUrl,
    alt: altText.slice(0, size.index).trimEnd(),
    width: Number(size[1]),
    height: size[2] ? Number(size[2]) : undefined,
  }
}

/** TeX between the math delimiters, with blockquote markers removed. */
function mathSource(state: EditorState, node: SyntaxNode): string {
  const marks = node.getChildren('MathMark')
  const open = marks[0]
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined
  return state.sliceDoc(open?.to ?? node.from, close?.from ?? node.to).trim()
}

/** The lines between a fence's opening and closing lines. */
function fenceSource(state: EditorState, node: SyntaxNode): string {
  const doc = state.doc
  const first = doc.lineAt(node.from).number + 1
  const closed = node.getChildren('CodeMark').length > 1
  const last = doc.lineAt(node.to).number - (closed ? 1 : 0)
  const lines: string[] = []
  for (let n = first; n <= last; n++) lines.push(doc.line(n).text)
  return lines.join('\n')
}

/** Splits a GFM table row on unescaped pipes outside code spans. */
function splitTableRow(text: string): string[] {
  let row = text.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cell += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

function renderTable(state: EditorState, node: SyntaxNode, resolveAssetUrl: (relPath: string) => string): string {
  const doc = state.doc
  const firstLine = doc.lineAt(node.from).number
  const lastLine = doc.lineAt(node.to).number
  const header = splitTableRow(doc.line(firstLine).text)
  const aligns = splitTableRow(doc.line(Math.min(firstLine + 1, lastLine)).text).map((spec) => {
    const left = spec.startsWith(':')
    const right = spec.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return left ? 'left' : undefined
  })
  const cellHtml = (tag: 'th' | 'td', text: string, column: number) => {
    const align = aligns[column]
    const style = align ? ` style="text-align:${align}"` : ''
    return `<${tag}${style}>${renderInlineMarkdown(text, resolveAssetUrl)}</${tag}>`
  }

  let html = `<table><thead><tr>${header.map((text, i) => cellHtml('th', text, i)).join('')}</tr></thead><tbody>`
  for (let n = firstLine + 2; n <= lastLine; n++) {
    const cells = splitTableRow(doc.line(n).text)
    html += `<tr>${header.map((_, i) => cellHtml('td', cells[i] ?? '', i)).join('')}</tr>`
  }
  html += '</tbody></table>'
  return html.replace('<tbody></tbody>', '')
}
