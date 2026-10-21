import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { editorHost } from './config.ts'

/** The target of the link (inline link, `<autolink>` or bare URL) at `pos`, if any. */
export function linkAt(state: EditorState, pos: number): string | undefined {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Link' || node.name === 'Autolink' || node.name === 'Image') {
        const url = node.getChild('URL')
        return url ? state.sliceDoc(url.from, url.to).replace(/^<(.*)>$/, '$1') : undefined
      }
      if (node.name === 'URL') return state.sliceDoc(node.from, node.to)
    }
  }
  return undefined
}

/** Cmd-click (macOS) / Ctrl-click opens a link in the source or inside a rendered widget (tables). */
export const openLinkOnModClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    let href = anchor?.getAttribute('href') ?? undefined
    if (!href) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos !== null) href = linkAt(view.state, pos)
    }
    if (!href) return false
    event.preventDefault()
    view.state.facet(editorHost).onOpenLink(href)
    return true
  },
  click(event) {
    // Plain clicks on links inside widgets must not navigate the app window.
    if (event.target instanceof Element && event.target.closest('.cm-lp-table a[href]')) event.preventDefault()
    return false
  },
})
