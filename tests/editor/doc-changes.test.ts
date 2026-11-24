import { describe, expect, it } from 'vitest'
import { type DocChange, docChanges } from '../../src/editor/doc-changes.ts'

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

/** The fewest characters deleted and inserted to turn `a` into `b`, from their longest common subsequence. */
function fewestEdits(a: string, b: string): number {
  let next = new Array<number>(b.length + 1).fill(0)
  for (let i = a.length - 1; i >= 0; i--) {
    const row = new Array<number>(b.length + 1).fill(0)
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
    next = row
  }
  return a.length + b.length - 2 * (next[0] ?? 0)
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
    for (let n = 0; n < 3000; n++) {
      // Single lines are diffed character by character; with newlines, lines are matched first, which can cost more
      // characters than the fewest but keeps each unchanged line whole.
      const alphabet = n % 2 === 0 ? 'ab' : 'ab\n'
      const from = text(alphabet)
      const to = text(alphabet)
      const changes = docChanges(from, to)
      expect(apply(from, changes)).toBe(to)
      if (!alphabet.includes('\n')) expect(edits(changes)).toBe(fewestEdits(from, to))
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
})
