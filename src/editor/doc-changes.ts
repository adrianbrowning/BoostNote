/** A replacement of `from`..`to` (positions in the old document) by `insert`. */
export interface DocChange {
  from: number
  to: number
  insert: string
}

/**
 * Most cells (the lengths of the two differing middles multiplied) the character diff may fill; beyond that the
 * middle is replaced as one span. 2^20 keeps the shorter middle at most 1024 long, so a `Uint16Array` holds it.
 */
const DIFF_CELLS = 1 << 20

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
 * end are kept, and between them the characters outside their longest common subsequence change.
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
  if (n === 0 || m === 0 || n * m > DIFF_CELLS) {
    changes.push({ from: offset + start, to: offset + start + n, insert: to.slice(start, start + m) })
    return
  }
  // The longest common subsequence of `from`'s middle from `i` and `to`'s middle from `j`, at `i * width + j`.
  const width = m + 1
  const common = new Uint16Array((n + 1) * width)
  const lcs = (i: number, j: number) => common[i * width + j] ?? 0
  const same = (i: number, j: number) => from.charCodeAt(start + i) === to.charCodeAt(start + j)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      common[i * width + j] = same(i, j) ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) {
      i++
      j++
      continue
    }
    const fromI = i
    const fromJ = j
    while ((i < n || j < m) && !(i < n && j < m && same(i, j))) {
      if (j === m || (i < n && lcs(i + 1, j) >= lcs(i, j + 1))) i++
      else j++
    }
    changes.push({ from: offset + start + fromI, to: offset + start + i, insert: to.slice(start + fromJ, start + j) })
  }
}
