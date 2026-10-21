/**
 * Boostnote's live-preview markdown editor: one CodeMirror 6 view whose document is the markdown source.
 * Browser-only and framework-agnostic; the host passes a parent element and callbacks.
 *
 * Hosts must also load KaTeX's stylesheet (`katex/dist/katex.min.css`) for math to render correctly.
 */
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { Annotation, Compartment, EditorSelection, EditorState, type Extension, Transaction } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap } from '@codemirror/view'
import { indentListItem, insertLink, outdentListItem, toggleInlineMarker } from './commands.ts'
import { type EditorHost, type EditorTheme, editorHost } from './config.ts'
import { markdownSupport } from './language.ts'
import { openLinkOnModClick } from './links.ts'
import { previewWidgets } from './live-preview/blocks.ts'
import { livePreviewMarkers } from './live-preview/markers.ts'
import { editorFocusTracking, setEditorFocused } from './live-preview/selection.ts'
import { pasteAndDrop } from './paste.ts'
import { slashCommandMenu } from './slash.ts'
import { editorStyles, themeExtension } from './theme.ts'

export type { EditorTheme } from './config.ts'

export interface LivePreviewEditorOptions extends EditorHost {
  parent: HTMLElement
  /** The note body only (the caller strips frontmatter). */
  doc: string
  theme: EditorTheme
  /** Called with the full document after every user edit; the caller debounces. */
  onChange(doc: string): void
}

export interface LivePreviewEditor {
  view: EditorView
  /** Replaces the document. With `preserveSelection` the selection and undo history survive (live reload). */
  setDoc(doc: string, opts?: { preserveSelection?: boolean }): void
  setTheme(theme: EditorTheme): void
  focus(): void
  destroy(): void
}

/** Marks transactions from `setDoc`, which must not be reported back through `onChange`. */
const externalChange = Annotation.define<boolean>()

const WRAP_ON_TYPE: Record<string, true> = { '`': true, '*': true, _: true, '~': true }

/** Typing `` ` ``, `*`, `_` or `~` with text selected wraps the selection instead of replacing it. */
const wrapSelectionOnType = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (!WRAP_ON_TYPE[text] || view.state.selection.ranges.every((range) => range.empty)) return false
  const tr = view.state.changeByRange((range) =>
    range.empty
      ? { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + 1) }
      : {
          changes: [
            { from: range.from, insert: text },
            { from: range.to, insert: text },
          ],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        },
  )
  view.dispatch(view.state.update(tr, { userEvent: 'input.type' }))
  return true
})

const markdownShortcuts = keymap.of([
  { key: 'Mod-b', run: toggleInlineMarker('**'), preventDefault: true },
  { key: 'Mod-i', run: toggleInlineMarker('*'), preventDefault: true },
  { key: 'Mod-e', run: toggleInlineMarker('`'), preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleInlineMarker('~~'), preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  {
    key: 'Tab',
    run: (view) => indentListItem(view) || insertTab(view),
    shift: (view) => outdentListItem(view) || indentLess(view),
  },
])

/** Every editor extension except the per-instance host, theme and change listener. */
function livePreviewExtensions(): Extension {
  return [
    markdownSupport(),
    livePreviewMarkers,
    previewWidgets,
    editorFocusTracking,
    editorStyles,
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    closeBrackets(),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '"'] } }]),
    wrapSelectionOnType,
    search({ top: false }),
    slashCommandMenu(),
    pasteAndDrop,
    openLinkOnModClick,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Note editor' }),
    keymap.of([...closeBracketsKeymap, ...completionKeymap]),
    markdownShortcuts,
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
  ]
}

export function createLivePreviewEditor(opts: LivePreviewEditorOptions): LivePreviewEditor {
  const theme = new Compartment()
  let currentTheme = opts.theme
  const shared = [
    livePreviewExtensions(),
    editorHost.of(opts),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.every((tr) => tr.annotation(externalChange))) {
        opts.onChange(update.state.doc.toString())
      }
    }),
  ]
  const createState = (doc: string) =>
    EditorState.create({ doc, extensions: [shared, theme.of(themeExtension(currentTheme))] })

  const view = new EditorView({ state: createState(opts.doc), parent: opts.parent })

  return {
    view,
    setDoc(doc, setOpts) {
      if (!setOpts?.preserveSelection) {
        view.setState(createState(doc))
        // A new state starts unfocused and setState doesn't re-notify focus, so restore it for a focused view.
        if (view.hasFocus) view.dispatch({ effects: setEditorFocused.of(true) })
        return
      }
      const current = view.state.doc.toString()
      if (current === doc) return
      // Replace only the differing middle so the selection and history map through unchanged text.
      let start = 0
      const max = Math.min(current.length, doc.length)
      while (start < max && current.charCodeAt(start) === doc.charCodeAt(start)) start++
      let end = 0
      while (
        end < max - start &&
        current.charCodeAt(current.length - 1 - end) === doc.charCodeAt(doc.length - 1 - end)
      ) {
        end++
      }
      view.dispatch({
        changes: { from: start, to: current.length - end, insert: doc.slice(start, doc.length - end) },
        // External edits are not undoable; local history maps through them.
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
      })
    },
    setTheme(next) {
      if (next === currentTheme) return
      currentTheme = next
      view.dispatch({ effects: theme.reconfigure(themeExtension(next)) })
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
