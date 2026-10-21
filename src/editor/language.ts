import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorSelection, type Extension, Prec, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'

import { mathExtension } from './syntax/math.ts'

const continueNestedMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })
const EMPTY_TOP_LEVEL_ITEM = /^(?:[-*+]|\d+[.)])(?: \[[ xX]\])?\s*$/

/**
 * Enter continues list items, task items and blockquotes. On an empty top-level item it ends the list:
 * the marker goes and a blank line separates the list from what follows (without it, the next line
 * would be a lazy continuation of the last item). Empty nested items move out one level.
 */
export const continueMarkup: StateCommand = (target) => {
  const { state } = target
  const cursor = state.selection.main
  const line = state.doc.lineAt(cursor.head)
  if (
    state.selection.ranges.length === 1 &&
    cursor.empty &&
    cursor.head === line.to &&
    line.number > 1 &&
    EMPTY_TOP_LEVEL_ITEM.test(line.text) &&
    state.doc.line(line.number - 1).text.trim() !== ''
  ) {
    target.dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: '\n' },
        selection: EditorSelection.cursor(line.from + 1),
        scrollIntoView: true,
        userEvent: 'input',
      }),
    )
    return true
  }
  return continueNestedMarkup(target)
}

/**
 * GFM markdown (tables, task lists, strikethrough, autolinks) plus `$…$`/`$$…$$` math. Fenced code is
 * highlighted with the matching `@codemirror/language-data` language, loaded lazily on first use.
 * Backspace right after list/quote markup deletes one level of it.
 */
export function markdownSupport(): Extension {
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [mathExtension],
      addKeymap: false,
      completeHTMLTags: false,
    }),
    Prec.high(
      keymap.of([
        { key: 'Enter', run: continueMarkup },
        { key: 'Backspace', run: deleteMarkupBackward },
      ]),
    ),
  ]
}
