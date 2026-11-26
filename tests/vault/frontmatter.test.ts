import { describe, expect, it } from 'vitest'

import { parseNoteText, serializeNoteText, updateYaml } from '../../src/vault/frontmatter.ts'

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
    const alias = '---\nNote: *important*\n---\nbody'
    expect(parseNoteText(alias)).toMatchObject({ frontmatter: {}, yaml: null, body: alias })
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

describe('frontmatter with aliases', () => {
  it.each(['x: *missing', 'a: &a {self: *a}', 'a: &a [*a]'])('treats a leading block with %j as body', (yaml) => {
    const raw = `---\n${yaml}\n---\nbody`
    expect(parseNoteText(raw)).toMatchObject({ frontmatter: {}, yaml: null, body: raw })
  })
})

describe('frontmatter as a flow mapping, on a note save', () => {
  const raw = '---\n{a: 1} # c\n---\nb\n'

  it.each([
    ['adds a key', { a: 1, b: 2 }],
    ['changes a key', { a: 3 }],
    ['drops a key', {}],
    ['adds a value over several lines', { a: 1, b: 'one\ntwo' }],
  ])('%s and parses back as the new frontmatter, keeping the body', (_, after) => {
    const text = serializeNoteText(after, 'b\n', parseNoteText(raw))
    expect(parseNoteText(text)).toMatchObject({ frontmatter: after, body: 'b\n' })
  })

  it('adds a key to a key-only entry', () => {
    const text = serializeNoteText({ a: null, b: 1 }, '', parseNoteText('---\n{a}\n---\n'))
    expect(Object.entries(parseNoteText(text).frontmatter)).toEqual([
      ['a', null],
      ['b', 1],
    ])
  })
})

describe('frontmatter with integer-like keys, on a note save', () => {
  const parsed = (yaml: string) => parseNoteText(`---\n${yaml}---\n`).frontmatter

  it('keeps every line of a mapping with an array-index key and appends the new key', () => {
    const yaml = "z: 'q' # c\ntags: [a,b]\n1: 2\n"
    expect(updateYaml(yaml, parsed(yaml), { ...parsed(yaml), n: 3 })).toBe(`${yaml}n: 3\n`)
  })

  it('moves a key past the array-index range (4294967295) when only the key order changes', () => {
    const yaml = 'a: 1\n4294967295: 2\n'
    const text = updateYaml(yaml, parsed(yaml), { '4294967295': 2, a: 1 })
    expect(Object.keys(parsed(text))).toEqual(['4294967295', 'a'])
    expect(parsed(text)).toEqual({ '4294967295': 2, a: 1 })
  })
})

describe('frontmatter whose keys are reordered on a note save', () => {
  it('writes the block anew when the new order would put an alias before its anchor', () => {
    const yaml = 'a: &x {v: 1}\nb: *x\n'
    const before = parseNoteText(`---\n${yaml}---\n`).frontmatter
    const after = { b: { v: 1 }, a: { v: 1 } }
    const text = updateYaml(yaml, before, after)
    const parsed = parseNoteText(`---\n${text}---\nbody`)
    expect(parsed.frontmatter).toEqual(after)
    expect(Object.keys(parsed.frontmatter)).toEqual(['b', 'a'])
    expect(parsed.body).toBe('body')
  })
})
