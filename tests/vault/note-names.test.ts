import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { noteFileName, noteTitle, openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

const read = (rel: string) => readFile(path.join(root, rel), 'utf8')

async function listing(dir = root, prefix = ''): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`
    names.push(entry.isDirectory() ? `${rel}/` : rel)
    if (entry.isDirectory()) names.push(...(await listing(path.join(dir, entry.name), `${rel}/`)))
  }
  return names.sort()
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-names-'))
})

afterEach(async () => {
  await vault?.close()
  await rm(root, { recursive: true, force: true })
})

describe('noteFileName', () => {
  it('replaces illegal and control characters and collapses whitespace', () => {
    expect(noteFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(noteFileName('tab\there\u0001x')).toBe('tab here-x')
    expect(noteFileName('  lots   of\n space  ')).toBe('lots of space')
    expect(noteFileName('Welcome to Boostnote!')).toBe('Welcome to Boostnote!')
  })

  it('strips leading dots and trailing dots and spaces', () => {
    expect(noteFileName('...hidden')).toBe('hidden')
    expect(noteFileName('. dotted')).toBe('dotted')
    expect(noteFileName('end...  ')).toBe('end')
    expect(noteFileName('pictures.assets')).toBe('pictures')
  })

  it('suffixes Windows device names', () => {
    for (const name of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'lpt9']) expect(noteFileName(name)).toBe(`${name}-`)
    expect(noteFileName('con.txt')).toBe('con-.txt')
    expect(noteFileName('COM0')).toBe('COM0')
    expect(noteFileName('Console')).toBe('Console')
  })

  it('caps the length on a character boundary', () => {
    expect(noteFileName('x'.repeat(300))).toHaveLength(120)
    const emoji = noteFileName('👩‍💻'.repeat(100))
    expect(emoji.length).toBeLessThan(300)
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(200)
    expect(emoji.replaceAll('👩‍💻', '')).toBe('')
    expect(noteFileName(`${'a'.repeat(119)} b`)).toBe('a'.repeat(119))
  })

  it('names empty titles Untitled', () => {
    expect(noteFileName('')).toBe('Untitled')
    expect(noteFileName('  ... ')).toBe('Untitled')
  })
})

describe('note titles', () => {
  it('uses the frontmatter title, else the file name, never the first H1', async () => {
    expect(noteTitle('1-1/Craig.md', {})).toBe('Craig')
    expect(noteTitle('a.md', { title: '  Named  ' })).toBe('Named')
    expect(noteTitle('a.md', { title: '' })).toBe('a')
    expect(noteTitle('a.md', { title: 3 })).toBe('a')

    await put('1-1/Craig.md', '# 2026-09-18\n\nNotes\n')
    vault = await openVault(root)
    expect(vault.index.get('1-1/Craig.md')?.title).toBe('Craig')
    expect(vault.index.search('craig').map((hit) => hit.id)).toEqual(['1-1/Craig.md'])
  })

  it('names new notes Untitled, unique ignoring case', async () => {
    await put('Untitled 2.md', '')
    await put('UNTITLED.assets/x.png', 'x')
    vault = await openVault(root)
    expect((await vault.createNote('')).id).toBe('Untitled 3.md')
    expect((await vault.createNote('', 'Plan: Q1')).id).toBe('Plan- Q1.md')
  })

  it('renames with the same sanitiser and refuses empty names', async () => {
    await put('a.md', 'x')
    vault = await openVault(root)
    expect((await vault.renameNote('a.md', ' Notes: today? ')).id).toBe('Notes- today-.md')
    await expect(vault.renameNote('Notes- today-.md', ' .. ')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })
})

describe('rename files from titles', () => {
  async function seed(): Promise<void> {
    // Imported with slug names (the importer before phase 7).
    await put(
      'Work/welcome-to-boostnote.md',
      '# Welcome to Boostnote!\n\n![shot](./welcome-to-boostnote.assets/a.png)\n',
    )
    await put('Work/welcome-to-boostnote.assets/a.png', 'A')
    await put('Work/welcome-to-boostnote-2.md', '# Welcome to Boostnote!\n\n[first](./welcome-to-boostnote.md#intro)\n')
    await put('Work/q1-plan.md', '---\ntitle: "Q1: plan"\ntags: [x]\n---\nbody\n')
    await put('Work/meeting-notes.md', '---\ntitle: Meeting notes # keep comment\nstarred: true\n---\nbody\n')
    await put('Work/Meeting notes.md', 'already taken\n')
    // Named by the user: H1 differs from the file name, left alone.
    await put('1-1/Craig.md', '# 2026-09-18\n\nCatch-up\n')
    // Already a readable name.
    await put('Inbox.md', '# Inbox\n')
    // Links from elsewhere, plain, encoded, with anchors, into assets, in code.
    await put(
      'index.md',
      [
        '[w](Work/welcome-to-boostnote.md)',
        '[w2](./Work/welcome-to-boostnote-2.md#top)',
        '[enc](Work/welcome%2Dto%2Dboostnote.md)',
        '<a href="Work/meeting-notes.md">m</a>',
        '![img](Work/welcome-to-boostnote.assets/a.png)',
        '[craig](1-1/Craig.md)',
        '`[code](Work/q1-plan.md)`',
        '```',
        '[fenced](Work/q1-plan.md)',
        '```',
        '',
      ].join('\n'),
    )
    await put('1-1/links.md', '[q](../Work/q1-plan.md?x=1#h)\n')
    await put('.trash/Work/old-note.md', '# Old note\n[w](./welcome-to-boostnote.md)\n')
  }

  it('plans renames only for slug-named notes', async () => {
    await seed()
    vault = await openVault(root)
    const before = await listing()
    const plan = await vault.planTitleRenames()
    expect(plan.renames).toEqual([
      { from: 'Work/meeting-notes.md', to: 'Work/Meeting notes 2.md', title: 'Meeting notes' },
      { from: 'Work/q1-plan.md', to: 'Work/Q1- plan.md', title: 'Q1: plan' },
      { from: 'Work/welcome-to-boostnote.md', to: 'Work/Welcome to Boostnote!.md', title: 'Welcome to Boostnote!' },
      { from: 'Work/welcome-to-boostnote-2.md', to: 'Work/Welcome to Boostnote! 2.md', title: 'Welcome to Boostnote!' },
    ])
    expect(plan.skipped.map((skip) => skip.id)).toEqual(['1-1/Craig.md'])
    // A dry run writes nothing.
    expect(await listing()).toEqual(before)
  })

  it('renames files, moves assets, fixes title keys and every incoming link', async () => {
    await seed()
    vault = await openVault(root)
    const report = await vault.applyTitleRenames(await vault.planTitleRenames())
    expect(report.renamed).toHaveLength(4)
    expect(report.skipped).toEqual([])

    expect(await read('Work/Welcome to Boostnote!.md')).toBe(
      '# Welcome to Boostnote!\n\n![shot](./Welcome%20to%20Boostnote!.assets/a.png)\n',
    )
    expect(await read('Work/Welcome to Boostnote!.assets/a.png')).toBe('A')
    expect(await read('Work/Welcome to Boostnote! 2.md')).toBe(
      '# Welcome to Boostnote!\n\n[first](./Welcome%20to%20Boostnote!.md#intro)\n',
    )
    // `title` stays when it differs from the file name, goes when they match (other YAML kept).
    expect(await read('Work/Q1- plan.md')).toBe('---\ntitle: "Q1: plan"\ntags: [x]\n---\nbody\n')
    expect(await read('Work/Meeting notes 2.md')).toBe(
      '---\ntitle: Meeting notes # keep comment\nstarred: true\n---\nbody\n',
    )
    expect(report.titlesRemoved).toBe(0)

    expect(await read('index.md')).toBe(
      [
        '[w](Work/Welcome%20to%20Boostnote!.md)',
        '[w2](./Work/Welcome%20to%20Boostnote!%202.md#top)',
        '[enc](Work/Welcome%20to%20Boostnote!.md)',
        '<a href="Work/Meeting%20notes%202.md">m</a>',
        '![img](Work/Welcome%20to%20Boostnote!.assets/a.png)',
        '[craig](1-1/Craig.md)',
        '`[code](Work/q1-plan.md)`',
        '```',
        '[fenced](Work/q1-plan.md)',
        '```',
        '',
      ].join('\n'),
    )
    expect(await read('1-1/links.md')).toBe('[q](../Work/Q1-%20plan.md?x=1#h)\n')
    expect(report.linksRewritten).toBe(7)
    expect(report.notesUpdated).toBe(3)

    // User-named notes, the trash and taken names are untouched.
    expect(await read('1-1/Craig.md')).toBe('# 2026-09-18\n\nCatch-up\n')
    expect(await read('Work/Meeting notes.md')).toBe('already taken\n')
    expect(await read('.trash/Work/old-note.md')).toBe('# Old note\n[w](./welcome-to-boostnote.md)\n')
    expect(vault.index.get('Work/Welcome to Boostnote!.md')?.title).toBe('Welcome to Boostnote!')
    expect(vault.index.has('Work/welcome-to-boostnote.md')).toBe(false)
    expect((await vault.planTitleRenames()).renames).toEqual([])
  })

  it('removes a frontmatter title that equals the new file name', async () => {
    await put('notes/my-plan.md', '---\ntitle: My plan\ntags: [a]\n---\nbody\n')
    await put('notes/other-plan-3.md', '---\ntags: [b]\ntitle: Other plan\n---\nbody\n')
    vault = await openVault(root)
    const plan = await vault.planTitleRenames()
    expect(plan.renames.map((rename) => rename.to)).toEqual(['notes/My plan.md', 'notes/Other plan.md'])
    const report = await vault.applyTitleRenames(plan)
    expect(report.titlesRemoved).toBe(2)
    expect(await read('notes/My plan.md')).toBe('---\ntags: [a]\n---\nbody\n')
    expect(await read('notes/Other plan.md')).toBe('---\ntags: [b]\n---\nbody\n')
    expect(vault.index.get('notes/My plan.md')?.title).toBe('My plan')
  })

  it('skips renames that no longer apply', async () => {
    await put('a.md', 'x')
    await put('B.md', 'taken')
    vault = await openVault(root)
    const report = await vault.applyTitleRenames({
      renames: [
        { from: 'missing.md', to: 'Missing.md', title: 'Missing' },
        { from: 'a.md', to: 'B.md', title: 'B' },
        { from: 'a.md', to: 'sub/A.md', title: 'A' },
        { from: 'a.md', to: 'A?.md', title: 'A?' },
      ],
    })
    expect(report.renamed).toEqual([])
    expect(report.skipped.map((skip) => skip.id)).toEqual(['missing.md', 'a.md', 'a.md', 'a.md'])
    expect(await read('a.md')).toBe('x')
  })
})
