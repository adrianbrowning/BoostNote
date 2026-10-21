import type { EditorState } from '@codemirror/state'

/** True when any selection range overlaps or touches `[from, to]` (a cursor at either edge counts). */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from)
}
