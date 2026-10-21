import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'

import { isExternalUrl } from '../config.ts'
import { mathExtension } from '../syntax/math.ts'
import { renderMath } from './math.ts'

const parser = (markdownLanguage.parser as MarkdownParser).configure([mathExtension])

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

const WRAPPERS: Record<string, string> = { Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del' }
const MARKS: Record<string, true> = { EmphasisMark: true, StrikethroughMark: true, CodeMark: true, MathMark: true }

/**
 * Renders a single line of inline markdown (a table cell) to safe HTML: emphasis, strong, strikethrough,
 * code, links, images, inline math, escapes. Raw HTML is shown as text, never interpreted.
 */
export function renderInlineMarkdown(text: string, resolveAssetUrl: (relPath: string) => string): string {
  const tree = parser.parse(text)
  const paragraph = tree.topNode.firstChild
  if (!paragraph) return escapeHtml(text)

  const renderChildren = (node: SyntaxNode, from: number, to: number): string => {
    let html = ''
    let pos = from
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from < pos) continue
      html += escapeHtml(text.slice(pos, child.from)) + renderNode(child)
      pos = child.to
    }
    return html + escapeHtml(text.slice(pos, to))
  }

  const renderNode = (node: SyntaxNode): string => {
    const wrapper = WRAPPERS[node.name]
    if (wrapper) return `<${wrapper}>${renderChildren(node, node.from, node.to)}</${wrapper}>`
    if (MARKS[node.name]) return ''
    switch (node.name) {
      case 'InlineCode':
        return `<code>${escapeHtml(innerText(node))}</code>`
      case 'InlineMath':
        return renderMath(innerText(node), false)
      case 'Escape':
        return escapeHtml(text.slice(node.from + 1, node.to))
      case 'Link': {
        const url = node.getChild('URL')
        const label = linkLabel(node)
        const inner = label ? renderChildren(node, label.from, label.to) : ''
        if (!url) return inner
        return `<a href="${escapeHtml(text.slice(url.from, url.to))}">${inner}</a>`
      }
      case 'Image': {
        const url = node.getChild('URL')
        const label = linkLabel(node)
        if (!url) return escapeHtml(text.slice(node.from, node.to))
        const src = text.slice(url.from, url.to)
        const alt = label ? text.slice(label.from, label.to) : ''
        return `<img src="${escapeHtml(isExternalUrl(src) ? src : resolveAssetUrl(src))}" alt="${escapeHtml(alt)}">`
      }
      case 'Autolink':
      case 'URL': {
        const url = node.name === 'URL' ? node : node.getChild('URL')
        const href = url ? text.slice(url.from, url.to) : ''
        return `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`
      }
      default:
        return escapeHtml(text.slice(node.from, node.to))
    }
  }

  const innerText = (node: SyntaxNode): string => {
    const open = node.firstChild
    const close = node.lastChild
    if (!open || !close || open === close) return text.slice(node.from, node.to)
    return text.slice(open.to, close.from).trim()
  }

  const linkLabel = (node: SyntaxNode): { from: number; to: number } | undefined => {
    const marks = node.getChildren('LinkMark')
    const open = marks[0]
    const close = marks[1]
    return open && close ? { from: open.to, to: close.from } : undefined
  }

  return renderChildren(paragraph, 0, text.length)
}
