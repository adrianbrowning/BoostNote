/** A replacement of `from`..`to` (positions in the old document) by `insert`. */
export interface DocChange {
  from: number
  to: number
  insert: string
}

/**
 * Most characters the character diff inserts and deletes together; beyond that the differing middle is replaced as
 * one span. Its cost grows with this times the text's length, not with how far apart the edits are.
 */
const MAX_EDITS = 1024

/**
 * The changes that turn document `from` into `to`, ascending and in `from`'s positions, changing only the
 * characters that differ: the selection and undo history then map through all the text the two share (two links
 * a relocation rebased keep the text between them, and the cursor there). With as many lines in both (relocations
 * and link rewrites change text within lines), each changed line is diffed on its own, so a long note stays cheap.
 */
export function docChanges(from: string, to: string): DocChange[] {
  const changes: DocChange[] = []
  const fromLines = from.split('\n')
  const toLines = to.split('\n')
  if (fromLines.length !== toLines.length) {
    characterChanges(from, to, 0, changes)
    return changes
  }
  let offset = 0
  for (const [index, line] of fromLines.entries()) {
    const next = toLines[index] ?? ''
    if (line !== next) characterChanges(line, next, offset, changes)
    offset += line.length + 1
  }
  return changes
}

/**
 * Adds to `changes` the changes that turn `from` into `to` (at `offset` in the document): their common start and
 * end are kept, and between them the fewest characters are inserted and deleted (Myers' diff).
 */
function characterChanges(from: string, to: string, offset: number, changes: DocChange[]): void {
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++
  const n = from.length - start - end
  const m = to.length - start - end
  if (n === 0 && m === 0) return
  const span = { from: offset + start, to: offset + start + n, insert: to.slice(start, start + m) }
  if (n === 0 || m === 0) {
    changes.push(span)
    return
  }
  const same = (x: number, y: number) => from.charCodeAt(start + x) === to.charCodeAt(start + y)
  // `ends[k + limit + 1]`: how far into `from`'s middle the furthest path on diagonal `k` (x - y) reached.
  const limit = Math.min(n + m, MAX_EDITS)
  const ends = new Int32Array(2 * limit + 3)
  const at = (k: number) => ends[k + limit + 1] ?? 0
  /** `ends` as each round started: round `d` reads them to step back from where it got. */
  const rounds: Int32Array[] = []
  let edits = -1
  for (let d = 0; d <= limit && edits < 0; d++) {
    rounds.push(ends.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1
      let y = x - k
      while (x < n && y < m && same(x, y)) {
        x++
        y++
      }
      ends[k + limit + 1] = x
      if (x >= n && y >= m) {
        edits = d
        break
      }
    }
  }
  if (edits < 0) {
    changes.push(span)
    return
  }
  // Steps back from the end, one insert or delete per round, then joins the adjacent ones.
  const steps: DocChange[] = []
  let x = n
  let y = m
  for (let d = edits; d > 0; d--) {
    const before = rounds[d]
    const ended = (k: number) => before?.[k + limit + 1] ?? 0
    const k = x - y
    const down = k === -d || (k !== d && ended(k - 1) < ended(k + 1))
    const previous = down ? k + 1 : k - 1
    x = ended(previous)
    y = x - previous
    const position = offset + start + x
    steps.push(
      down
        ? { from: position, to: position, insert: to.charAt(start + y) }
        : { from: position, to: position + 1, insert: '' },
    )
  }
  let last: DocChange | undefined
  for (const step of steps.reverse()) {
    if (last && last.to === step.from) {
      last.to = step.to
      last.insert += step.insert
    } else {
      last = step
      changes.push(step)
    }
  }
}
