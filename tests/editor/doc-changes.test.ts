import { describe, expect, it } from 'vitest'
import { DIFF_ROUNDS, type DocChange, docChanges } from '../../src/editor/doc-changes.ts'

/** `from` with `changes` applied (ascending, in `from`'s positions, not overlapping). */
function apply(from: string, changes: DocChange[]): string {
  let out = ''
  let position = 0
  for (const change of changes) {
    expect(change.from).toBeGreaterThanOrEqual(position)
    expect(change.to).toBeGreaterThanOrEqual(change.from)
    out += from.slice(position, change.from) + change.insert
    position = change.to
  }
  return out + from.slice(position)
}

/** How many characters `changes` delete and insert. */
const edits = (changes: DocChange[]) => changes.reduce((sum, c) => sum + (c.to - c.from) + c.insert.length, 0)

/** The length of the longest common subsequence of `a` and `b`: of their characters, or of their lines. */
function commonLength(a: string | readonly string[], b: string | readonly string[]): number {
  let next = new Array<number>(b.length + 1).fill(0)
  for (let i = a.length - 1; i >= 0; i--) {
    const row = new Array<number>(b.length + 1).fill(0)
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
    next = row
  }
  return next[0] ?? 0
}

/** How many lines of `from` no change touches: none deletes one of its characters, nor inserts strictly inside it. */
function untouchedLines(from: string, changes: DocChange[]): number {
  let count = 0
  let start = 0
  for (const line of from.split('\n')) {
    const end = start + line.length
    const touched = changes.some(
      (change) => Math.max(change.from, start) < Math.min(change.to, end) || (change.from > start && change.from < end),
    )
    if (!touched) count++
    start = end + 1
  }
  return count
}

describe('docChanges', () => {
  it('turns one document into the other, a line with the fewest edits (seeded random documents, few characters)', () => {
    // A fixed linear congruential generator: the same cases on every run.
    let seed = 17
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const text = (alphabet: string) =>
      Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
    // 1-5 lines of 1-6 characters each: no empty line, so every common line has characters a change must leave alone.
    const lines = () =>
      Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        Array.from({ length: 1 + Math.floor(random() * 6) }, () => (random() < 0.5 ? 'a' : 'b')).join(''),
      ).join('\n')
    for (let n = 0; n < 3000; n++) {
      // A pair of single lines is diffed character by character, with the fewest edits. With newlines, lines are
      // matched first, which can cost more characters than the fewest but keeps whole at least as many lines as the
      // longest common subsequence of the two documents' lines.
      const alphabet = n % 2 === 0 ? 'ab' : 'ab\n'
      const from = text(alphabet)
      const to = text(alphabet)
      const changes = docChanges(from, to)
      expect(apply(from, changes)).toBe(to)
      if (!from.includes('\n') && !to.includes('\n')) {
        expect(edits(changes)).toBe(from.length + to.length - 2 * commonLength(from, to))
      }
      expect(untouchedLines(from, changes)).toBeGreaterThanOrEqual(commonLength(from.split('\n'), to.split('\n')))
      // An empty line always counts as untouched (no change can delete a character of it): these pairs have none.
      const fromLines = lines()
      const toLines = lines()
      const lineChanges = docChanges(fromLines, toLines)
      expect(apply(fromLines, lineChanges)).toBe(toLines)
      expect(untouchedLines(fromLines, lineChanges)).toBeGreaterThanOrEqual(
        commonLength(fromLines.split('\n'), toLines.split('\n')),
      )
    }
  })

  it('keeps the text shared between replaced, inserted and deleted runs', () => {
    const rebased = docChanges('[a](./a.md) aaaa [b](./b.md)', '[a](../a.md) aaaa [b](../b.md)')
    // One "." inserted at each link, wherever in its "./" it lands: " aaaa " between them is kept.
    expect(rebased.map((change) => [change.insert, change.to - change.from])).toEqual([
      ['.', 0],
      ['.', 0],
    ])
    expect(rebased[1]?.from).toBeGreaterThanOrEqual('[a](./a.md) aaaa [b]('.length)
    expect(docChanges('keep cut keep', 'keep keep')).toEqual([{ from: 5, to: 9, insert: '' }])
    expect(docChanges('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual([{ from: 4, to: 7, insert: 'TWO' }])
    expect(docChanges('same', 'same')).toEqual([])
  })

  it('keeps the text between links of a line with more edits than the character diff takes at once', () => {
    // 400 links on one line moved three folders deeper: 2400 characters inserted, more than one diff pass takes.
    const names = Array.from({ length: 400 }, (_, i) => `n${i}`)
    const line = (dir: string) => names.map((name) => `[${name}](${dir}${name}.md)`).join(' · ')
    const from = line('./')
    const to = line('../../../')
    const changes = docChanges(from, to)
    expect(apply(from, changes)).toBe(to)
    // Every change lies within one link, so the " · " between links is never replaced.
    const links: [number, number][] = []
    let position = 0
    for (const name of names) {
      const link = `[${name}](./${name}.md)`
      links.push([position, position + link.length])
      position += link.length + ' · '.length
    }
    for (const change of changes) {
      expect(links.some(([start, end]) => start <= change.from && change.to <= end)).toBe(true)
    }
    expect(changes.length).toBeGreaterThanOrEqual(names.length)
  })

  it('turns long, very different documents into each other over several diff passes', () => {
    let seed = 29
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const text = (alphabet: string) =>
      Array.from({ length: 3000 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
    // With line breaks every few characters, more lines differ than one line diff pass takes.
    for (const alphabet of ['abc', 'abc', 'ab\n', 'ab\n']) {
      const from = text(alphabet)
      const to = text(alphabet)
      expect(apply(from, docChanges(from, to))).toBe(to)
    }
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}\n`).join('')
    const from = lines(5000)
    const to = `${lines(5000).replaceAll('5\n', '6\n')}tail`
    expect(apply(from, docChanges(from, to))).toBe(to)
  })

  it('keeps every unchanged line of a 200,000-character note whose outside edit inserted a line and changed every other one', () => {
    const line = (i: number) => `${i}: ${'lorem ipsum '.repeat(17)}`
    const lines = Array.from({ length: 1000 }, (_, i) => line(i))
    const from = lines.join('\n')
    expect(from.length).toBeGreaterThan(200_000)
    // Every other line changed in a few characters, and one line inserted in the middle: the line counts differ.
    const changed = lines.map((text, i) => (i % 2 === 1 ? text.replace('ipsum', 'IPSUM') : text))
    changed.splice(500, 0, 'An inserted line.')
    const to = changed.join('\n')
    const changes = docChanges(from, to)
    expect(apply(from, changes)).toBe(to)
    expect(untouchedLines(from, changes)).toBe(500)
  })

  it('stops diffing finely once the call’s diff budget is spent, and still rebuilds the target', () => {
    // 10k short lines, every other one changed: more line and character diff rounds than one call may run.
    const from = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n')
    const to = Array.from({ length: 10_000 }, (_, i) => (i % 2 === 1 ? `line ${i}!` : `line ${i}`)).join('\n')
    const changes = docChanges(from, to)
    expect(apply(from, changes)).toBe(to)
    // Each change costs at least one round of the budget, but for the rest once it is spent (one change); with no
    // budget there would be one change per changed line, 5000.
    expect(DIFF_ROUNDS + 1).toBeLessThan(5000)
    expect(changes.length).toBeLessThanOrEqual(DIFF_ROUNDS + 1)
  })
})
