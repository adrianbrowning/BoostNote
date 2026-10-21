import type { Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorHost } from '../../src/editor/config.ts'
import { buildPreviewWidgets } from '../../src/editor/live-preview/blocks.ts'
import { buildMarkerDecorations } from '../../src/editor/live-preview/markers.ts'
import {
  CheckboxWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  toggleTaskAt,
} from '../../src/editor/live-preview/widgets.ts'
import { decorationList, hiddenTexts, markdownState } from './helpers.ts'

const hidden = (doc: string) => {
  const state = markdownState(doc)
  return hiddenTexts(state, buildMarkerDecorations(state))
}

const widgets = (doc: string, extensions: Extension = []) => {
  const state = markdownState(doc, extensions)
  return decorationList(buildPreviewWidgets(state)).map((range) => ({
    widget: range.value.spec.widget as unknown,
    block: range.value.spec.block === true,
    text: state.sliceDoc(range.from, range.to),
  }))
}

describe('marker hiding', () => {
  it('hides heading markers unless the cursor is on the heading line', () => {
    expect(hidden('# Title\n\ntext‸')).toEqual(['# '])
    expect(hidden('# Ti‸tle\n\ntext')).toEqual([])
    expect(hidden('## Closed ##\n‸')).toEqual(['## ', ' ##'])
  })

  it('hides emphasis, strong, strikethrough and code markers until the selection touches them', () => {
    expect(hidden('a *em* **strong** ~~del~~ `code`\n‸')).toEqual(['*', '*', '**', '**', '~~', '~~', '`', '`'])
    expect(hidden('a **str‸ong** *em*')).toEqual(['*', '*'])
    // A cursor right after the closing marker still counts as touching.
    expect(hidden('a **strong**‸ *em*')).toEqual(['*', '*'])
  })

  it('hides link brackets and the URL but keeps the label, carrying the href', () => {
    const state = markdownState('see [the docs](https://example.com "Title") now\n‸')
    const decorations = buildMarkerDecorations(state)
    expect(hiddenTexts(state, decorations)).toEqual(['[', '](https://example.com "Title")'])
    const link = decorations.find((range) => range.value.spec.class === 'cm-lp-link')
    expect(link && state.sliceDoc(link.from, link.to)).toBe('the docs')
    expect(link?.value.spec.attributes).toEqual({ 'data-href': 'https://example.com' })
    expect(hidden('see [the d‸ocs](https://example.com) now')).toEqual([])
  })

  it('hides blockquote markers on lines without the cursor', () => {
    expect(hidden('> one\n> two‸')).toEqual(['> '])
    expect(hidden('> one\n> two\n\n‸')).toEqual(['> ', '> '])
  })

  it('hides escapes and the bullet of task items', () => {
    expect(hidden('\\*not em\\*\n‸')).toEqual(['\\', '\\'])
    expect(hidden('- [ ] task\n\n‸')).toEqual(['- '])
  })

  it('hides fence lines of code blocks unless the cursor is inside', () => {
    expect(hidden('```js\nlet a\n```\n\n‸')).toEqual(['```js', '```'])
    expect(hidden('```js\nlet ‸a\n```')).toEqual([])
  })
})

describe('preview widgets', () => {
  it('renders mermaid fences as a block widget only while the cursor is outside', () => {
    const outside = widgets('```mermaid\ngraph TD\n  A --> B\n```\n\n‸')
    expect(outside).toHaveLength(1)
    expect(outside[0]?.block).toBe(true)
    expect(outside[0]?.widget).toBeInstanceOf(MermaidWidget)
    expect(outside[0]?.widget).toMatchObject({ source: 'graph TD\n  A --> B' })
    expect(widgets('```mermaid\ngraph ‸TD\n```\n')).toEqual([])
    // On the line right after the closing fence the block stays rendered.
    expect(widgets('```mermaid\ngraph TD\n```\n‸')).toHaveLength(1)
  })

  it('renders $$ blocks, ```math fences and inline $…$ with KaTeX widgets', () => {
    const [block] = widgets('$$\nE = mc^2\n$$\n\n‸')
    expect(block?.block).toBe(true)
    expect(block?.widget).toEqual(new MathWidget('E = mc^2', true))
    const [fence] = widgets('```math\n\\frac{1}{2}\n```\n\n‸')
    expect(fence?.widget).toEqual(new MathWidget('\\frac{1}{2}', true))
    const [inline] = widgets('Euler: $e^{i\\pi}$ ok\n‸')
    expect(inline).toMatchObject({ block: false, text: '$e^{i\\pi}$' })
    expect(inline?.widget).toEqual(new MathWidget('e^{i\\pi}', false))
    expect(widgets('$$\nE = ‸mc^2\n$$')).toEqual([])
    expect(widgets('Euler: $e^{i‸\\pi}$')).toEqual([])
    expect(widgets('costs $5 and $6\n‸')).toEqual([])
  })

  it('renders GFM tables as HTML with alignment and inline markdown', () => {
    const [table] = widgets('| a | b |\n| :-: | --: |\n| **x** | `y \\| z` |\n\n‸')
    expect(table?.block).toBe(true)
    const html = table?.widget instanceof TableWidget ? table.widget.html : ''
    expect(html).toContain('<th style="text-align:center">a</th>')
    expect(html).toContain('<td style="text-align:center"><strong>x</strong></td>')
    expect(html).toContain('<td style="text-align:right"><code>y | z</code></td>')
    expect(widgets('| a | b |\n| - | - |\n| 1 | ‸2 |')).toEqual([])
  })

  it('renders images through resolveAssetUrl with alt text and size', () => {
    const host = editorHost.of({
      resolveAssetUrl: (relPath) => `boost://app/vault-asset/${relPath}`,
      saveAsset: async () => '',
      onOpenLink: () => {},
    })
    const [local] = widgets('![A cat|320x200](./note.assets/cat.png)\n‸', host)
    expect(local?.widget).toEqual(new ImageWidget('boost://app/vault-asset/./note.assets/cat.png', 'A cat', 320, 200))
    const [remote] = widgets('![logo](https://example.com/logo.svg)\n‸', host)
    expect(remote?.widget).toEqual(new ImageWidget('https://example.com/logo.svg', 'logo', undefined, undefined))
    expect(widgets('![logo](https://example.com/l‸ogo.svg)')).toEqual([])
  })

  it('renders task markers as checkboxes unless the cursor touches the marker', () => {
    const items = widgets('- [ ] open\n- [x] done\n\n‸')
    const boxes = items.filter((item) => item.widget instanceof CheckboxWidget)
    expect(boxes.map((box) => (box.widget as CheckboxWidget).checked)).toEqual([false, true])
    expect(items.some((item) => item.text === ' done')).toBe(true)
    expect(widgets('- [‸x] done').filter((item) => item.widget instanceof CheckboxWidget)).toEqual([])
  })

  it('toggles task markers in the source', () => {
    const state = markdownState('- [ ] open\n- [X] done')
    const open = state.update(toggleTaskAt(state, 2) ?? {}).state
    expect(open.doc.toString()).toBe('- [x] open\n- [X] done')
    const done = open.update(toggleTaskAt(open, 13) ?? {}).state
    expect(done.doc.toString()).toBe('- [x] open\n- [ ] done')
    expect(toggleTaskAt(state, 0)).toBeNull()
  })
})
