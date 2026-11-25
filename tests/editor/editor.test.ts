// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { undo } from '@codemirror/commands'
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
import { setEditorFocused } from '../../src/editor/live-preview/selection.ts'
import { renderMermaid } from '../../src/editor/render/mermaid.ts'
import { slashCompletionSource } from '../../src/editor/slash.ts'
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
    assetPlace: () => 'note.md',
    onOpenLink: vi.fn(),
    ...overrides,
  })
  return { editor, parent, onChange }
}

/** Dispatches a paste of `text` (and optional HTML); jsdom has no default paste, so the fallback inserts it. */
function pasteText(editor: LivePreviewEditor, text: string, html?: string) {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  if (html) data.setData('text/html', html)
  const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
  editor.view.contentDOM.dispatchEvent(event)
  if (!event.defaultPrevented) editor.view.dispatch(editor.view.state.replaceSelection(text))
}

/** Fakes the `/image` command's file picker: `run` opens it at the end of the document, `pick` answers it. */
function imagePicker() {
  const pickers: HTMLInputElement[] = []
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    pickers.push(this)
  })
  return {
    /** Runs `/image` at the end of the document, opening the (fake) file picker. */
    run(editor: LivePreviewEditor) {
      const { state } = editor.view
      editor.view.dispatch({ selection: { anchor: state.doc.length } })
      const result = slashCompletionSource(new CompletionContext(editor.view.state, state.doc.length, false))
      const option = result?.options.find((candidate) => candidate.label === '/image')
      if (typeof option?.apply !== 'function') throw new Error('no /image command')
      option.apply(editor.view, option, result?.from ?? 0, state.doc.length)
    },
    /**
     * The user picks `name` in the last opened picker; resolves once the command's reaction to it (a chain of
     * promise continuations, no timers) has run.
     */
    async pick(name: string) {
      const input = pickers.at(-1)
      if (!input) throw new Error('no picker opened')
      Object.defineProperty(input, 'files', { value: [new File(['png'], name, { type: 'image/png' })] })
      input.dispatchEvent(new Event('change'))
      // A macrotask runs only after every queued microtask, so the command has checked and saved (or not) by then.
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 0)
      await promise
    },
  }
}

afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
  mermaidMock.render.mockClear()
  mermaidMock.initialize.mockClear()
  vi.restoreAllMocks()
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

  it('takes no changes while read-only: pastes (HTML, URL, image), drops, a late image save and dispatched edits', async () => {
    const saved = Promise.withResolvers<string>()
    const saveAsset = vi.fn(() => saved.promise)
    const { editor, onChange } = mount('see ', { saveAsset })
    editor.view.dispatch({ selection: { anchor: 4 } })
    const image = () => {
      const data = new DataTransfer()
      data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }))
      return data
    }
    // An image save that started before the editor went read-only finishes while it is.
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: image(), cancelable: true }))
    expect(saveAsset).toHaveBeenCalledOnce()
    editor.setReadOnly(true)

    const html = new DataTransfer()
    html.setData('text/html', '<p>Hello <strong>world</strong></p>')
    html.setData('text/plain', 'Hello world')
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: html, cancelable: true }))
    pasteText(editor, 'https://example.com/cat.png')
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: image(), cancelable: true }))
    editor.view.contentDOM.dispatchEvent(new DragEvent('drop', { dataTransfer: image(), cancelable: true }))
    // No image save starts while read-only (it would go to whichever vault the page names by then).
    expect(saveAsset).toHaveBeenCalledOnce()
    // The early save finishes while read-only: its insert waits for the editor to be editable again.
    saved.resolve('./note.assets/shot.png')
    await saved.promise
    editor.view.dispatch({ changes: { from: 4, insert: 'typed' } })
    expect(editor.view.state.doc.toString()).toBe('see ')
    expect(onChange).not.toHaveBeenCalled()

    // The app's own updates still show while read-only, and a full reset (another note) stays read-only and
    // drops the waiting insert.
    editor.setDoc('see', { preserveSelection: true })
    expect(editor.view.state.doc.toString()).toBe('see')
    editor.setDoc('see you')
    editor.view.dispatch({ changes: { from: 7, insert: '?' } })
    expect(editor.view.state.doc.toString()).toBe('see you')
    editor.setReadOnly(false)
    editor.view.dispatch({ changes: { from: 7, insert: '!' } })
    // Editable again, the waiting insert wakes in a later microtask. It must insert nothing, so there is no
    // signal to await: one zero-delay macrotask lets it run before the document is checked.
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await promise
    expect(editor.view.state.doc.toString()).toBe('see you!')
    expect(onChange).toHaveBeenLastCalledWith('see you!')
  })

  it('inserts an image whose save finished while the editor was read-only once it is editable again', async () => {
    const saved = Promise.withResolvers<string>()
    const { editor } = mount('see ', { saveAsset: vi.fn(() => saved.promise) })
    editor.view.dispatch({ selection: { anchor: 4 } })
    const data = new DataTransfer()
    data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }))
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
    // A transition holds the note (another note is deleted, say) while the save is out; the note stays.
    editor.setReadOnly(true)
    saved.resolve('./note.assets/shot.png')
    await saved.promise
    expect(editor.view.state.doc.toString()).toBe('see ')
    editor.setReadOnly(false)
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toBe('see ![shot](./note.assets/shot.png)'))
  })

  it('inserts nothing from an image picked after the note was replaced, and saves one picked while locked once unlocked', async () => {
    const saveAsset = vi.fn(async (file: File) => `./note.assets/${file.name}`)
    const { editor } = mount('/image', { saveAsset })
    const picker = imagePicker()

    picker.run(editor)
    editor.setDoc('Another note')
    await picker.pick('late.png')
    expect(saveAsset).not.toHaveBeenCalled()
    editor.setDoc('/image')
    picker.run(editor)
    editor.setReadOnly(true)
    await picker.pick('locked.png')
    // Picked while a transition holds the note: nothing is saved until the editor takes edits again.
    expect(saveAsset).not.toHaveBeenCalled()
    editor.setReadOnly(false)
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toBe('![locked](./note.assets/locked.png)'))
    expect(saveAsset.mock.calls.map(([file]) => file.name)).toEqual(['locked.png'])
  })

  it('inserts a picked /image where its position moved to through text typed while the picker is open', async () => {
    const { editor } = mount('ab\n/image')
    const picker = imagePicker()
    picker.run(editor)
    editor.view.dispatch({ changes: { from: 0, insert: 'XYZ\n\n' } })
    await picker.pick('kept.png')
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toContain('kept.png'))
    expect(editor.view.state.doc.toString()).toMatch(/^XYZ\n\nab\n+!\[kept\]\(\.\/note\.assets\/kept\.png\)\n*$/)
  })

  it('setDoc with preserveSelection keeps the cursor on unchanged text', () => {
    const { editor } = mount('alpha\nbeta\ngamma')
    editor.view.dispatch({ selection: { anchor: 13 } }) // inside "gamma"
    editor.setDoc('alpha\nBETA!\ngamma', { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(14)
    editor.setDoc('other')
    expect(editor.view.state.selection.main.head).toBe(0)
  })

  it('setDoc with preserveSelection changes only what differs: the cursor and undo between two changed links stay', () => {
    const { editor } = mount('[a](./a.md) middle [b](./b.md)\n')
    const at = '[a](./a.md) mid'.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    editor.setDoc('[a](../a.md) midXdle [b](../b.md)\n', { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe('[a](../a.md) midX'.length)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe('[a](../a.md) middle [b](../b.md)\n')
  })

  it('setDoc with preserveSelection keeps the cursor and undo between two changed links of a long note', () => {
    const filler = 'Some text that stays as it is.\n'.repeat(200)
    const note = (dir: string, middle: string) => `[a](${dir}a.md)\n${filler}${middle}\n${filler}[b](${dir}b.md)\n`
    const { editor } = mount(note('./', 'middle'))
    const at = `[a](./a.md)\n${filler}mid`.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    editor.setDoc(note('../', 'midXdle'), { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(at + 2)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe(note('../', 'middle'))
  })

  it('setDoc with preserveSelection keeps the cursor and undo between two changed links far apart on one line', () => {
    const filler = 'Some text that stays as it is. '.repeat(40)
    const note = (dir: string, middle: string) => `[a](${dir}a.md) ${filler}${middle} ${filler}[b](${dir}b.md)\n`
    const { editor } = mount(note('./', 'middle'))
    const at = `[a](./a.md) ${filler}mid`.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    editor.setDoc(note('../', 'midXdle'), { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(at + 2)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe(note('../', 'middle'))
  })

  it('setDoc with preserveSelection keeps the cursor and undo between links of a line with more than a thousand rebased characters', () => {
    // 400 links moved three folders deeper: 2400 characters inserted on one line, more than one diff pass takes.
    const links = (dir: string, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `[n${from + i}](${dir}n${from + i}.md)`).join(' · ')
    const note = (dir: string, middle: string) => `${links(dir, 0, 200)} ${middle} ${links(dir, 200, 400)}\n`
    const { editor } = mount(note('./', 'middle'))
    const at = `${links('./', 0, 200)} mid`.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    editor.setDoc(note('../../../', 'midXdle'), { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(`${links('../../../', 0, 200)} midX`.length)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe(note('../../../', 'middle'))
  })

  it('setDoc with preserveSelection of an outside edit that shifts lines keeps undo to the typed text', () => {
    const { editor } = mount('one\ntwo\nthree\nfour\nfive\n')
    const at = 'one\ntwo\nth'.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    // Another editor inserted a line at the top and deleted "five": as many lines, each shifted down one.
    editor.setDoc('zero\none\ntwo\nthXree\nfour\n', { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe('zero\none\ntwo\nthX'.length)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe('zero\none\ntwo\nthree\nfour\n')
  })

  it('setDoc with preserveSelection keeps undo to the typed text when the outside edit shifts lines by more than one line diff pass takes', () => {
    const lines = (prefix: string, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `${prefix} ${from + i}\n`).join('')
    const typed = (prefix: string, line: string) =>
      `${prefix}${lines('line', 0, 500)}${line}\n${lines('line', 501, 900)}`
    const { editor } = mount(`${typed('', 'line 500')}${lines('line', 900, 2000)}`)
    const at = `${lines('line', 0, 500)}line`.length
    editor.view.dispatch({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    // Another editor added 1100 lines at the top and removed the last 1100: 2200 line edits shifting every line.
    editor.setDoc(typed(lines('new', 0, 1100), 'lineX 500'), { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe(`${lines('new', 0, 1100)}${lines('line', 0, 500)}lineX`.length)
    undo(editor.view)
    expect(editor.view.state.doc.toString()).toBe(typed(lines('new', 0, 1100), 'line 500'))
  })

  it('setDoc with preserveSelection takes a CRLF note’s text with the editor’s line breaks, adding no blank lines', () => {
    const { editor, onChange } = mount('a\r\n[b](./b.md)\r\nc')
    editor.view.dispatch({ selection: { anchor: 'a\n[b](./b.md)\nc'.length } })
    editor.setDoc('a\r\n[b](../b.md)\r\nc', { preserveSelection: true })
    expect(editor.view.state.selection.main.head).toBe('a\n[b](../b.md)\nc'.length)
    expect(editor.view.state.doc.toString()).toBe('a\n[b](../b.md)\nc')
    expect(editor.view.state.doc.lines).toBe(3)
    editor.view.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' })
    expect(onChange).toHaveBeenLastCalledWith('Xa\n[b](../b.md)\nc')
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

    // Cursor inside the diagram of a focused editor: the source is editable again, no widget.
    editor.view.dispatch({ selection: { anchor: 15 }, effects: setEditorFocused.of(true) })
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
    editor.view.dispatch({ selection: { anchor: 3 }, effects: setEditorFocused.of(true) })
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

  it('pastes a URL as image markdown with the cursor in the alt text', () => {
    const { editor } = mount('see ')
    editor.view.dispatch({ selection: { anchor: 4 } })
    pasteText(editor, 'https://example.com/cat.png')
    expect(editor.view.state.doc.toString()).toBe('see ![](https://example.com/cat.png)')
    expect(editor.view.state.selection.main.head).toBe(6)
  })

  it('uses the selected text as alt text when a URL is pasted over it', () => {
    const { editor } = mount('a [cat] here')
    editor.view.dispatch({ selection: { anchor: 2, head: 7 } })
    pasteText(editor, ' https://example.com/a_(b)\n', '<a href="https://example.com/a_(b)">x</a>')
    const expected = 'a ![\\[cat\\]](<https://example.com/a_(b)>) here'
    expect(editor.view.state.doc.toString()).toBe(expected)
    expect(editor.view.state.selection.main.head).toBe(expected.length - ' here'.length)
  })

  it('keeps a pasted URL plain in a link destination, in code and next to other text', () => {
    const { editor } = mount('`x`\n\n[a]()')
    // From the end of the doc backwards, so each paste leaves the earlier positions in place.
    for (const [anchor, text] of [
      [9, 'https://example.com'],
      [2, 'https://example.com'],
      [0, 'see https://example.com'],
    ] as const) {
      editor.view.dispatch({ selection: { anchor } })
      pasteText(editor, text)
    }
    expect(editor.view.state.doc.toString()).toBe(
      'see https://example.com`xhttps://example.com`\n\n[a](https://example.com)',
    )
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
