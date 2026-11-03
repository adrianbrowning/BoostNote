import { describe, expect, it } from 'vitest'

import {
  isNoteFileName,
  isRelativeLink,
  joinId,
  lastSegment,
  noteDisplayName,
  noteStem,
  parentOf,
  resolveNoteLink,
  safeDecode,
} from '../../src/shared/vault-ids.ts'
import { FROM, LINK_CASES } from './link-cases.ts'

describe('parentOf', () => {
  it.each([
    ['todo.md', ''],
    ['work/todo.md', 'work'],
    ['work/projects/todo.md', 'work/projects'],
    ['work', ''],
    ['work/projects', 'work'],
    ['', ''],
  ])('%j → %j', (id, parent) => {
    expect(parentOf(id)).toBe(parent)
  })
})

describe('lastSegment', () => {
  it.each([
    ['todo.md', 'todo.md'],
    ['work/todo.md', 'todo.md'],
    ['work/projects', 'projects'],
    ['work/projects/', 'projects'],
    ['', ''],
    ['C:\\Users\\me\\a.md', 'a.md'],
    ['/Users/me/notes/', 'notes'],
  ])('%j → %j', (id, last) => {
    expect(lastSegment(id)).toBe(last)
  })
})

describe('isNoteFileName', () => {
  it.each([
    ['a.md', true],
    ['Git cheat sheet.md', true],
    ['a.md.md', true],
    ['.md', false],
    ['B.MD', false],
    ['a.Md', false],
    ['notes.md.bak', false],
    ['a', false],
    ['', false],
  ])('%j → %j', (name, isNote) => {
    expect(isNoteFileName(name)).toBe(isNote)
  })
})

describe('noteStem', () => {
  it.each([
    ['todo.md', 'todo'],
    ['work/todo.md', 'todo'],
    ['work/projects/Git cheat sheet.md', 'Git cheat sheet'],
    ['work/B.MD', 'B.MD'],
    ['a.Md', 'a.Md'],
    ['notes.md.bak', 'notes.md.bak'],
    ['a.md.md', 'a.md'],
    ['.md', '.md'],
    ['work/', 'work'],
  ])('%j → %j', (id, stem) => {
    expect(noteStem(id)).toBe(stem)
  })
})

describe('joinId', () => {
  it.each([
    ['', 'todo.md', 'todo.md'],
    ['work', 'todo.md', 'work/todo.md'],
    ['work/projects', 'a', 'work/projects/a'],
  ])('%j + %j → %j', (folder, name, id) => {
    expect(joinId(folder, name)).toBe(id)
  })
})

describe('noteDisplayName', () => {
  it.each([
    ['1-1/Craig.md', {}, 'Craig'],
    ['a.md', { title: '  Named  ' }, 'Named'],
    ['a.md', { title: '' }, 'a'],
    ['a.md', { title: '   ' }, 'a'],
    ['a.md', { title: 3 }, 'a'],
    ['a.md', { title: null }, 'a'],
    ['work/B.MD', {}, 'B.MD'],
  ])('%j with %j → %j', (id, frontmatter, name) => {
    expect(noteDisplayName(id, frontmatter)).toBe(name)
  })
})

describe('safeDecode', () => {
  it.each([
    ['Git%20cheat%20sheet.md', 'Git cheat sheet.md'],
    ['plain.md', 'plain.md'],
    ['caf%C3%A9.md', 'café.md'],
    ['100%.md', '100%.md'],
    ['%E0%A4%A.md', '%E0%A4%A.md'],
    ['%C3', '%C3'],
    ['', ''],
  ])('%j → %j', (value, decoded) => {
    expect(safeDecode(value)).toBe(decoded)
  })
})

describe('isRelativeLink', () => {
  it.each(LINK_CASES)('$kind: $href', ({ href, relative }) => {
    expect(isRelativeLink(href)).toBe(relative)
  })

  it('rejects a NUL in the decoded path', () => {
    expect(isRelativeLink('a%00.png')).toBe(false)
  })
})

describe('resolveNoteLink', () => {
  it.each(LINK_CASES)('$kind: $href', ({ href, note }) => {
    expect(resolveNoteLink(FROM, href)).toBe(note)
  })

  it('resolves from a note at the vault root', () => {
    expect(resolveNoteLink('index.md', 'Guides/ch3.md')).toBe('Guides/ch3.md')
    expect(resolveNoteLink('index.md', '../ch3.md')).toBeUndefined()
  })
})
