import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export const setEditorFocused = StateEffect.define<boolean>()

/**
 * Whether the view has focus. Kept in state (not read from the view) so the block-widget state field can
 * depend on it. Starts false: a freshly created view is unfocused, so it first renders fully previewed.
 */
export const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(setEditorFocused)) focused = effect.value
    return focused
  },
})

/** Tracks view focus so an unfocused editor shows every construct rendered, including the one at the cursor. */
export const editorFocusTracking: Extension = [
  editorFocused,
  EditorView.focusChangeEffect.of((_state, focusing) => setEditorFocused.of(focusing)),
]

/**
 * True when any selection range overlaps or touches `[from, to]` (a cursor at either edge counts). An
 * unfocused view has no meaningful selection, so nothing is touched. States without focus tracking (unit
 * tests building decorations directly) count as focused.
 */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  if (state.field(editorFocused, false) === false) return false
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from)
}
