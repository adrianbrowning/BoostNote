import { describe, expect, it } from 'vitest'

import { parseNoteText, serializeNoteText } from '../../src/vault/frontmatter.ts'

const NOTE = `---
title: "Hello: world"   # keep this comment
tags: [a, b]
custom:
  nested: 1
  list:
    - x
# a standalone comment
updated: 2020-01-01T00:00:00Z
weird: 'single quoted'
---

# Body

Text.
`

describe('frontmatter', () => {
  it('splits frontmatter and body, keeping key order and unknown keys', () => {
    const text = parseNoteText(NOTE)
    expect(Object.keys(text.frontmatter)).toEqual(['title', 'tags', 'custom', 'updated', 'weird'])
    expect(text.frontmatter).toMatchObject({
      title: 'Hello: world',
      tags: ['a', 'b'],
      custom: { nested: 1, list: ['x'] },
      updated: '2020-01-01T00:00:00Z',
      weird: 'single quoted',
    })
    expect(text.body).toBe('\n# Body\n\nText.\n')
  })

  it('round-trips byte for byte when nothing changed', () => {
    const text = parseNoteText(NOTE)
    expect(serializeNoteText({ ...text.frontmatter }, text.body, text)).toBe(NOTE)
  })

  it('rewrites only the changed key, leaving every other byte alone', () => {
    const text = parseNoteText(NOTE)
    const out = serializeNoteText({ ...text.frontmatter, updated: '2026-10-21T10:00:00.000Z' }, text.body, text)
    expect(out).toBe(NOTE.replace('updated: 2020-01-01T00:00:00Z', 'updated: 2026-10-21T10:00:00.000Z'))
    expect(parseNoteText(out).frontmatter.weird).toBe('single quoted')
  })

  it('removes and appends keys in place', () => {
    const text = parseNoteText(NOTE)
    const { tags: _tags, ...rest } = text.frontmatter
    const out = serializeNoteText({ ...rest, starred: true }, text.body, text)
    expect(out).not.toContain('tags:')
    expect(out).toContain('title: "Hello: world"   # keep this comment\ncustom:')
    expect(out).toContain("weird: 'single quoted'\nstarred: true\n---\n")
    expect(Object.keys(parseNoteText(out).frontmatter)).toEqual(['title', 'custom', 'updated', 'weird', 'starred'])
  })

  it('falls back to the document model for reordered keys and still parses back exactly', () => {
    const text = parseNoteText(NOTE)
    const reordered = { weird: 'changed', ...text.frontmatter }
    reordered.weird = 'changed'
    const out = serializeNoteText(reordered, text.body, text)
    expect(parseNoteText(out).frontmatter).toEqual(reordered)
    expect(parseNoteText(out).body).toBe(text.body)
  })

  it('replaces block values', () => {
    const text = parseNoteText(NOTE)
    const out = serializeNoteText({ ...text.frontmatter, custom: { other: true } }, text.body, text)
    expect(parseNoteText(out).frontmatter.custom).toEqual({ other: true })
    expect(out).toContain('# a standalone comment\nupdated: 2020-01-01T00:00:00Z')
  })

  it('treats files without frontmatter, or with invalid YAML, as all body', () => {
    expect(parseNoteText('# Just text\n')).toMatchObject({ frontmatter: {}, yaml: null, body: '# Just text\n' })
    const broken = '---\ntitle: [unclosed\n---\nbody\n'
    expect(parseNoteText(broken)).toMatchObject({ yaml: null, body: broken })
    const list = '---\n- a\n- b\n---\nbody\n'
    expect(parseNoteText(list).yaml).toBeNull()
  })

  it('adds frontmatter to a plain note and emits only the body for empty frontmatter', () => {
    expect(serializeNoteText({ title: 'T', tags: ['x'] }, 'body\n')).toBe('---\ntitle: T\ntags:\n  - x\n---\nbody\n')
    expect(serializeNoteText({}, 'body\n')).toBe('body\n')
  })

  it('keeps CRLF fences and empty blocks', () => {
    const crlf = '---\r\ntitle: A\r\n---\r\nline\r\n'
    const text = parseNoteText(crlf)
    expect(text.frontmatter).toEqual({ title: 'A' })
    expect(text.body).toBe('line\r\n')
    expect(serializeNoteText({ title: 'A' }, text.body, text)).toBe(crlf)
    const empty = parseNoteText('---\n---\nbody')
    expect(empty).toMatchObject({ frontmatter: {}, yaml: '', body: 'body' })
  })
})
