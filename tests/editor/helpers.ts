import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension, type Range, type StateCommand } from '@codemirror/state'
import type { Decoration, DecorationSet } from '@codemirror/view'

import { markdownSupport } from '../../src/editor/language.ts'

/**
 * A markdown state. In `doc`, `‸` marks the cursor and `«…»` a selection (default: cursor at the end).
 * Pipes are table syntax, so they can't be the marker.
 */
export function markdownState(docWithCursor: string, extensions: Extension = []): EditorState {
  const anchor = docWithCursor.search(/[‸«]/)
  const doc = docWithCursor.replace(/[‸«»]/g, '')
  const head = docWithCursor.includes('»') ? docWithCursor.indexOf('»') - 1 : anchor
  const state = EditorState.create({
    doc,
    selection: anchor < 0 ? EditorSelection.cursor(doc.length) : EditorSelection.range(anchor, head),
    extensions: [markdownSupport(), extensions],
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}

/** The document with `‸` at the main cursor, or `«…»` around a non-empty main selection. */
export function docWithSelection(state: EditorState): string {
  const { from, to } = state.selection.main
  const doc = state.doc.toString()
  if (from === to) return `${doc.slice(0, from)}‸${doc.slice(from)}`
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`
}

/** Source text covered by replace decorations without a widget (hidden markers). */
export function hiddenTexts(state: EditorState, decorations: readonly Range<Decoration>[]): string[] {
  return decorations
    .filter((range) => range.value.point && range.from < range.to && !range.value.spec.widget)
    .map((range) => state.sliceDoc(range.from, range.to))
}

export function decorationList(set: DecorationSet): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = []
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    ranges.push(value.range(from, to))
  })
  return ranges
}

/** Runs a state command and returns the resulting state (or `undefined` if the command declined). */
export function runCommand(state: EditorState, command: StateCommand): EditorState | undefined {
  let next: EditorState | undefined
  const handled = command({ state, dispatch: (tr) => (next = tr.state) })
  return handled ? (next ?? state) : undefined
}
