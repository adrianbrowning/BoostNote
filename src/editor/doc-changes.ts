/** A replacement of `from`..`to` (positions in the old document) by `insert`. */
export interface DocChange {
  from: number
  to: number
  insert: string
}

/**
 * Most characters one pass of the character diff inserts and deletes together. A pass that needs more keeps the
 * path that got furthest and diffs the rest in another pass, so a pass costs at most this squared plus the shared
 * text it walks, and no unchanged text ever ends up inside a replaced span.
 */
const MAX_EDITS = 1024

/**
 * The changes that turn document `from` into `to`, ascending and in `from`'s positions, changing only the
 * characters that differ: the selection and undo history then map through all the text the two share (two links
 * a relocation rebased keep the text between them, and the cursor there). The lines are diffed first, so a line
 * that moved (an outside edit added or removed lines above it) maps to itself, and only the runs of changed lines
 * are diffed character by character.
 */
export function docChanges(from: string, to: string): DocChange[] {
  const changes: DocChange[] = []
  const fromLines = from.split('\n')
  const toLines = to.split('\n')
  const fromStarts = lineStarts(fromLines)
  const toStarts = lineStarts(toLines)
  for (const [fromLine, fromEndLine, toLine, toEndLine] of lineHunks(fromLines, toLines)) {
    // A run that reaches the end of a document takes the line break before it, so lines added or removed at the
    // end bring their break with them.
    const back = fromLine === fromLines.length || toLine === toLines.length ? 1 : 0
    const start = (fromStarts[fromLine] ?? 0) - back
    const toStart = (toStarts[toLine] ?? 0) - back
    const end = back ? from.length : (fromStarts[fromEndLine] ?? 0)
    const toEnd = back ? to.length : (toStarts[toEndLine] ?? 0)
    characterChanges(from.slice(start, end), to.slice(toStart, toEnd), start, changes)
  }
  return changes
}

/** Where each of `lines` starts in their text, and one past the end of it (as if it ended in a line break). */
function lineStarts(lines: string[]): number[] {
  const starts = [0]
  for (const line of lines) starts.push((starts.at(-1) ?? 0) + line.length + 1)
  return starts
}

/**
 * The runs of lines that differ between `from` and `to`, as `[fromStart, fromEnd, toStart, toEnd]` line indexes,
 * ascending: Myers' diff over whole lines, one pass of at most `MAX_EDITS` line inserts and deletes at a time (as the
 * character diff), so every unchanged line it finds maps straight through however many lines changed around it.
 */
function lineHunks(from: string[], to: string[]): [number, number, number, number][] {
  const hunks: [number, number, number, number][] = []
  let start = 0
  let toStart = 0
  let fromEnd = from.length
  let toEnd = to.length
  while (fromEnd > 0 && toEnd > 0 && from[fromEnd - 1] === to[toEnd - 1]) {
    fromEnd--
    toEnd--
  }
  for (;;) {
    while (start < fromEnd && toStart < toEnd && from[start] === to[toStart]) {
      start++
      toStart++
    }
    const n = fromEnd - start
    const m = toEnd - toStart
    if (n === 0 && m === 0) return hunks
    if (n === 0 || m === 0) {
      addHunk(hunks, [start, fromEnd, toStart, toEnd])
      return hunks
    }
    const [x, y] = linePass(from, to, start, toStart, n, m, hunks)
    start += x
    toStart += y
  }
}

/**
 * One pass of Myers' diff between `from`'s `n` lines at `start` and `to`'s `m` at `toStart`: adds the runs of
 * changed lines of the shortest path to their ends, or of the path that got furthest within `MAX_EDITS`, and
 * returns how far into each that path got.
 */
function linePass(
  from: string[],
  to: string[],
  start: number,
  toStart: number,
  n: number,
  m: number,
  hunks: [number, number, number, number][],
): [number, number] {
  const limit = Math.min(n + m, MAX_EDITS)
  const ends = new Int32Array(2 * limit + 3)
  const at = (k: number) => ends[k + limit + 1] ?? 0
  const rounds: Int32Array[] = []
  let edits = limit
  let finished: number | undefined
  for (let d = 0; d <= limit && finished === undefined; d++) {
    rounds.push(ends.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1
      let y = x - k
      while (x < n && y < m && from[start + x] === to[toStart + y]) {
        x++
        y++
      }
      ends[k + limit + 1] = x
      if (x >= n && y >= m) {
        edits = d
        finished = k
        break
      }
    }
  }
  let last = finished ?? 0
  if (finished === undefined) {
    // Out of edits: the path of the last round that got furthest into both, of those that stayed within them.
    let furthest = -1
    for (let k = -limit; k <= limit; k += 2) {
      const x = at(k)
      if (x <= n && x - k <= m && x - k >= 0 && 2 * x - k > furthest) {
        furthest = 2 * x - k
        last = k
      }
    }
  }
  let x = at(last)
  let y = x - last
  const end: [number, number] = [x, y]
  // Steps back from where it got, collecting the runs of equal lines (as where they end and how long they are).
  const equal: [number, number, number][] = [[x, y, 0]]
  for (let d = edits; d > 0; d--) {
    const before = rounds[d]
    const ended = (k: number) => before?.[k + limit + 1] ?? 0
    const k = x - y
    const previous = k === -d || (k !== d && ended(k - 1) < ended(k + 1)) ? k + 1 : k - 1
    const previousX = ended(previous)
    const previousY = previousX - previous
    // The step moves one line right or down from (previousX, previousY); the equal lines run from there.
    const length = previous === k + 1 ? x - previousX : y - previousY
    if (length > 0) equal.push([x, y, length])
    x = previousX
    y = previousY
  }
  if (x > 0) equal.push([x, y, x])
  let fromAt = 0
  let toAt = 0
  for (const [endX, endY, length] of equal.reverse()) {
    if (endX - length > fromAt || endY - length > toAt) {
      addHunk(hunks, [start + fromAt, start + endX - length, toStart + toAt, toStart + endY - length])
    }
    fromAt = endX
    toAt = endY
  }
  return end
}

/** Adds `hunk` to `hunks`, joined to the last one when they touch (a pass stopped inside a run of changed lines). */
function addHunk(hunks: [number, number, number, number][], hunk: [number, number, number, number]): void {
  const last = hunks.at(-1)
  if (last && last[1] === hunk[0] && last[3] === hunk[2]) {
    last[1] = hunk[1]
    last[3] = hunk[3]
  } else {
    hunks.push(hunk)
  }
}

/**
 * Adds to `changes` the changes that turn `from` into `to` (at `offset` in the document): their common start and
 * end are kept, and between them the fewest characters are inserted and deleted (Myers' diff), one pass of at most
 * `MAX_EDITS` at a time.
 */
function characterChanges(from: string, to: string, offset: number, changes: DocChange[]): void {
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let toStart = start
  let fromEnd = from.length
  let toEnd = to.length
  while (fromEnd > start && toEnd > start && from.charCodeAt(fromEnd - 1) === to.charCodeAt(toEnd - 1)) {
    fromEnd--
    toEnd--
  }
  for (;;) {
    while (start < fromEnd && toStart < toEnd && from.charCodeAt(start) === to.charCodeAt(toStart)) {
      start++
      toStart++
    }
    const n = fromEnd - start
    const m = toEnd - toStart
    if (n === 0 && m === 0) return
    if (n === 0 || m === 0) {
      add(changes, { from: offset + start, to: offset + fromEnd, insert: to.slice(toStart, toEnd) })
      return
    }
    const [x, y] = pass(from, to, start, toStart, n, m, offset, changes)
    start += x
    toStart += y
  }
}

/**
 * One pass of Myers' diff between `from`'s `n` characters at `start` and `to`'s `m` at `toStart`: adds the changes
 * of the shortest path to their ends, or of the path that got furthest within `MAX_EDITS`, and returns how far into
 * each that path got.
 */
function pass(
  from: string,
  to: string,
  start: number,
  toStart: number,
  n: number,
  m: number,
  offset: number,
  changes: DocChange[],
): [number, number] {
  const same = (x: number, y: number) => from.charCodeAt(start + x) === to.charCodeAt(toStart + y)
  // `ends[k + limit + 1]`: how far into `from`'s part the furthest path on diagonal `k` (x - y) reached.
  const limit = Math.min(n + m, MAX_EDITS)
  const ends = new Int32Array(2 * limit + 3)
  const at = (k: number) => ends[k + limit + 1] ?? 0
  /** `ends` as each round started: round `d` reads them to step back from where it got. */
  const rounds: Int32Array[] = []
  let edits = limit
  /** The diagonal of the path that reached both ends, once one has. */
  let finished: number | undefined
  for (let d = 0; d <= limit && finished === undefined; d++) {
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
        finished = k
        break
      }
    }
  }
  let last = finished ?? 0
  if (finished === undefined) {
    // Out of edits: the path of the last round that got furthest into both texts (x + y is 2x - k), of those that
    // stayed within them (a step past one's end is never part of a path).
    let furthest = -1
    for (let k = -limit; k <= limit; k += 2) {
      const x = at(k)
      if (x <= n && x - k <= m && x - k >= 0 && 2 * x - k > furthest) {
        furthest = 2 * x - k
        last = k
      }
    }
  }
  let x = at(last)
  let y = x - last
  const end: [number, number] = [x, y]
  // Steps back from where it got, one insert or delete per round, then joins the adjacent ones.
  const steps: DocChange[] = []
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
        ? { from: position, to: position, insert: to.charAt(toStart + y) }
        : { from: position, to: position + 1, insert: '' },
    )
  }
  for (const step of steps.reverse()) add(changes, step)
  return end
}

/** Adds `change` to `changes`, joined to the last one when they touch. */
function add(changes: DocChange[], change: DocChange): void {
  const last = changes.at(-1)
  if (last && last.to === change.from) {
    last.to = change.to
    last.insert += change.insert
  } else {
    changes.push(change)
  }
}
