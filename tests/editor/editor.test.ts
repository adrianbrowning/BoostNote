// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => {
    if (source.includes('broken')) throw new Error('Parse error on line 1')
    return { svg: `<svg id="${id}" data-source="${source}"></svg>` }
  }),
}))
vi.mock('mermaid/dist/mermaid.esm.min.mjs', () => ({ default: mermaidMock }))

import { createLivePreviewEditor, type LivePreviewEditor } from '../../src/editor/index.ts'
import { continueMarkup } from '../../src/editor/language.ts'
import { linkAt } from '../../src/editor/links.ts'
import { renderMermaid } from '../../src/editor/render/mermaid.ts'
import { docWithSelection, markdownState, runCommand } from './helpers.ts'

let editor: LivePreviewEditor | undefined

function mount(doc: string, overrides: Partial<Parameters<typeof createLivePreviewEditor>[0]> = {}) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const onChange = vi.fn()
  editor = createLivePreviewEditor({
    parent,
    doc,
    theme: 'light',
    onChange,
    resolveAssetUrl: (relPath) => `asset:${relPath}`,
    saveAsset: async (file) => `./note.assets/${file.name}`,
    onOpenLink: vi.fn(),
    ...overrides,
  })
  return { editor, parent, onChange }
}

afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
  mermaidMock.render.mockClear()
  mermaidMock.initialize.mockClear()
})

describe('createLivePreviewEditor', () => {
  it('reports user edits through onChange but not setDoc', () => {
    const { editor, onChange } = mount('# Hello')
    editor.view.dispatch({ changes: { from: 7, insert: ' world' } })
    expect(onChange).toHaveBeenCalledWith('# Hello world')
    onChange.mockClear()
    editor.setDoc('# Replaced', { preserveSelection: true })
    editor.setDoc('# Fresh')
    expect(onChange).not.toHaveBeenCalled()
    expect(editor.view.state.doc.toString()).toBe('# Fresh')
  })

  it('setDoc with preserveSelection keeps the cursor on unchanged text', () => {
    const { editor } = mount('alpha\nbeta\ngamma')
    editor.view.dispatch({ selection: { anchor: 13 } }) // inside "gamma"
    editor.setDoc('alpha\nBETA!\ngamma', { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(14)
    editor.setDoc('other')
    expect(editor.view.state.selection.main.head).toBe(0)
  })

  it('toggles a task when its checkbox is clicked', () => {
    const { editor, parent, onChange } = mount('- [ ] buy milk\n\nend')
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    const box = parent.querySelector<HTMLInputElement>('input.cm-lp-checkbox')
    expect(box?.checked).toBe(false)
    box?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(editor.view.state.doc.toString()).toBe('- [x] buy milk\n\nend')
    expect(onChange).toHaveBeenCalledWith('- [x] buy milk\n\nend')
    expect(parent.querySelector<HTMLInputElement>('input.cm-lp-checkbox')?.checked).toBe(true)
  })

  it('renders mermaid lazily with strict security, follows the theme and shows errors inline', async () => {
    const { editor, parent } = mount('```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nbroken\n```\n\nend')
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    // The widgets' renders are the same cached promises.
    await Promise.all([renderMermaid('graph TD\n  A --> B', 'light'), renderMermaid('broken', 'light')])
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'default', startOnLoad: false }),
    )
    const blocks = parent.querySelectorAll('.cm-lp-mermaid')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.querySelector('svg')?.getAttribute('data-source')).toBe('graph TD\n  A --> B')
    expect(blocks[1]?.classList.contains('cm-lp-mermaid-error')).toBe(true)
    expect(blocks[1]?.textContent).toContain('Parse error on line 1')
    const ids = mermaidMock.render.mock.calls.map(([id]) => id)
    expect(new Set(ids).size).toBe(ids.length)

    // Cursor inside the diagram: the source is editable again, no widget.
    editor.view.dispatch({ selection: { anchor: 15 } })
    expect(parent.querySelectorAll('.cm-lp-mermaid')).toHaveLength(1)
    expect(parent.textContent).toContain('A --> B')

    // Dark theme re-renders with mermaid's dark theme; cached results are reused.
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    editor.setTheme('dark')
    await Promise.all([renderMermaid('graph TD\n  A --> B', 'dark'), renderMermaid('broken', 'dark')])
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
    const renders = mermaidMock.render.mock.calls.length
    editor.setTheme('light')
    expect(mermaidMock.render.mock.calls.length).toBe(renders)
  })

  it('renders KaTeX and hides heading markers away from the cursor', () => {
    const { editor, parent } = mount('# Title\n\n$$\nx^2\n$$\n\nend')
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    expect(parent.querySelector('.cm-lp-math-block .katex')).not.toBeNull()
    expect(parent.querySelector('.cm-lp-h1')?.textContent).toBe('Title')
    editor.view.dispatch({ selection: { anchor: 3 } })
    expect(parent.querySelector('.cm-lp-h1')?.textContent).toBe('# Title')
  })

  it('finds the link target under the pointer for Mod-click', () => {
    const onOpenLink = vi.fn()
    const { editor } = mount('see [docs](https://example.com) and https://bare.dev', { onOpenLink })
    expect(linkAt(editor.view.state, 6)).toBe('https://example.com')
    expect(linkAt(editor.view.state, 40)).toBe('https://bare.dev')
    expect(linkAt(editor.view.state, 1)).toBeUndefined()
  })

  it('inserts pasted images through saveAsset', async () => {
    const saveAsset = vi.fn(async (file: File) => `./note.assets/${file.name}`)
    const { editor } = mount('before ', { saveAsset })
    editor.view.dispatch({ selection: { anchor: 7 } })
    const data = new DataTransfer()
    data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    editor.view.contentDOM.dispatchEvent(event)
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toBe('before ![shot](./note.assets/shot.png)'))
    expect(saveAsset).toHaveBeenCalledOnce()
  })

  it('converts pasted HTML to markdown', () => {
    const { editor } = mount('')
    const data = new DataTransfer()
    data.setData('text/html', '<p>Hello <strong>world</strong></p>')
    data.setData('text/plain', 'Hello world')
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
    expect(editor.view.state.doc.toString()).toBe('Hello **world**')
  })

  it('removes its DOM on destroy', () => {
    const { editor, parent } = mount('x')
    editor.destroy()
    expect(parent.querySelector('.cm-editor')).toBeNull()
  })
})

describe('nested list continuation', () => {
  it('moves an empty nested item out one level', () => {
    const next = runCommand(markdownState('- a\n  - ‸'), continueMarkup)
    expect(next && docWithSelection(next)).toBe('- a\n- ‸')
  })
})
