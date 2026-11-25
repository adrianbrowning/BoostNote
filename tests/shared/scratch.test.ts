import { describe, expect, it } from 'vitest'

import { scratchTitle } from '../../src/shared/scratch.ts'

/** 5 January 2026, 09:07 local time. */
const created = new Date(2026, 0, 5, 9, 7, 42).toISOString()

describe('scratchTitle', () => {
  it.each([
    ['# Plan', 'Plan'],
    ['intro\n\n## Next steps ##\nmore', 'Next steps'],
    ['   ### Indented a little', 'Indented a little'],
    ['```\n# not a heading\n```\n# Real', 'Real'],
    ['~~~~md\n# inside\n~~~\n# still inside\n~~~~\n# After fence', 'After fence'],
    ['#hashtag line\n#\n# Heading', 'Heading'],
  ])('%j → the first heading outside fenced code, %j', (text, title) => {
    expect(scratchTitle(text, created)).toBe(title)
  })

  it.each([
    ['\n\n   first words  \nsecond', 'first words'],
    ['```\n# only fenced\n```', '```'],
    ['    # four spaces is code\n', '# four spaces is code'],
  ])('%j → the first non-blank line trimmed when no heading, %j', (text, title) => {
    expect(scratchTitle(text, created)).toBe(title)
  })

  it.each(['', '   \n\t\n'])('%j → the local creation time', (text) => {
    expect(scratchTitle(text, created)).toBe('Scratch 2026-01-05 09:07')
  })
})
