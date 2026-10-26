import { indentUnit } from '@codemirror/language'
import { EditorSelection, type EditorState, type StateCommand, type Transaction } from '@codemirror/state'

/** Number of consecutive `ch` characters ending at `pos` (direction -1) or starting at `pos` (direction 1). */
function runLength(state: EditorState, pos: number, ch: string, direction: 1 | -1): number {
  let count = 0
  const limit = direction === 1 ? state.doc.length : 0
  while (pos !== limit) {
    const next = direction === 1 ? state.sliceDoc(pos, pos + 1) : state.sliceDoc(pos - 1, pos)
    if (next !== ch) break
    count++
    pos += direction
  }
  return count
}

/**
 * A marker run of `run` characters wraps a `marker` of `length` characters: `**` inside `***`, but `*` is
 * not inside `**` (that is bold, not italic).
 */
function wraps(run: number, length: number): boolean {
  return length === 1 ? run === 1 || run >= 3 : run >= length
}

/**
 * Toggles an inline marker (`**`, `*`, `` ` ``, `~~`) around each selection range: unwraps when the range
 * is already wrapped (markers inside or just outside the selection), wraps otherwise. An empty range
 * inserts a marker pair with the cursor between.
 */
export function toggleInlineMarker(marker: string): StateCommand {
  const ch = marker[0] ?? ''
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const { from, to } = range
      const len = marker.length
      const text = state.sliceDoc(from, to)
      if (
        text.length >= 2 * len &&
        text.startsWith(marker) &&
        text.endsWith(marker) &&
        wraps(runLength(state, from, ch, 1), len) &&
        wraps(runLength(state, to, ch, -1), len)
      ) {
        return {
          changes: [
            { from, to: from + len },
            { from: to - len, to },
          ],
          range: EditorSelection.range(from, to - 2 * len),
        }
      }
      if (wraps(runLength(state, from, ch, -1), len) && wraps(runLength(state, to, ch, 1), len)) {
        return {
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          range: EditorSelection.range(from - len, to - len),
        }
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + len, to + len),
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:|www\.)\S+$/i

/**
 * Mod-K: wraps the selection as `[text](url)` with `url` selected. A selected URL becomes the link target
 * with the cursor in the empty label; an empty selection inserts `[](url)` with the cursor in the label.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    if (URL_LIKE.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      }
    }
    if (!text) {
      return {
        changes: { from: range.from, insert: '[](url)' },
        range: EditorSelection.cursor(range.from + 1),
      }
    }
    const urlFrom = range.from + text.length + 3
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)/

/** The selected lines, each once. */
function selectedLines(state: EditorState) {
  const lines = new Map<number, { from: number; text: string; number: number }>()
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos)
      lines.set(line.number, line)
      pos = line.to + 1
    }
  }
  return [...lines.values()]
}

/** Leading whitespace width of the nearest list item above `lineNumber` matching `accept`, if any. */
function previousListItem(state: EditorState, lineNumber: number, accept: (indent: number) => boolean) {
  for (let n = lineNumber - 1; n >= 1; n--) {
    const text = state.doc.line(n).text
    const match = LIST_ITEM.exec(text)
    if (match && accept((match[1] ?? '').length)) return match
    // A non-indented, non-list line ends the list.
    if (!match && text.trim() !== '' && !/^\s/.test(text)) return null
  }
  return null
}

/**
 * Tab on list items nests them under the previous sibling (indent = the sibling's marker width, so `1.`
 * items nest by 3 and `-` items by 2). Shift-Tab moves them back to the parent's indentation.
 * Returns false when no selected line is a list item so other Tab bindings can run.
 */
function shiftListItems(state: EditorState, dispatch: (tr: Transaction) => void, deeper: boolean): boolean {
  const changes: { from: number; to: number; insert: string }[] = []
  const unit = state.facet(indentUnit).length
  for (const line of selectedLines(state)) {
    const match = LIST_ITEM.exec(line.text)
    if (!match) continue
    const indent = (match[1] ?? '').length
    let target: number
    if (deeper) {
      const sibling = previousListItem(state, line.number, (i) => i === indent)
      target = indent + (sibling ? (sibling[2] ?? '').length + (sibling[3] ?? ' ').length : unit)
    } else {
      if (indent === 0) continue
      const parent = previousListItem(state, line.number, (i) => i < indent)
      target = parent ? (parent[1] ?? '').length : Math.max(0, indent - unit)
    }
    changes.push({ from: line.from, to: line.from + indent, insert: ' '.repeat(target) })
  }
  if (changes.length === 0) return false
  dispatch(state.update({ changes, userEvent: deeper ? 'indent' : 'delete.dedent' }))
  return true
}

export const indentListItem: StateCommand = ({ state, dispatch }) => shiftListItems(state, dispatch, true)
export const outdentListItem: StateCommand = ({ state, dispatch }) => shiftListItems(state, dispatch, false)
