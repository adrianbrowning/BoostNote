import { describe, expect, it } from 'vitest'

import { joinId, lastSegment, noteDisplayName, noteStem, parentOf, safeDecode } from '../../src/shared/vault-ids.ts'

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
