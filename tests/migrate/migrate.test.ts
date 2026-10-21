import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import CSON from 'cson-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findLegacyStorages, MigrationError, migrateStorage } from '../../src/migrate/index.ts'
import { openVault, parseNoteText } from '../../src/vault/index.ts'
import { createLegacyStorage, KEYS } from './fixture.ts'

let work: string
let source: string
let target: string

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'migrate-test-'))
  source = path.join(work, 'Boostnote')
  target = path.join(work, 'vault')
  await createLegacyStorage(source)
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const info = await stat(file)
    result[path.relative(dir, file)] = `${createHash('sha256')
      .update(await readFile(file))
      .digest('hex')}@${info.mtimeMs}`
  }
  return result
}

const readTarget = (rel: string) => readFile(path.join(target, rel), 'utf8')

describe('migrateStorage', () => {
  it('converts a legacy storage into a vault', async () => {
    const before = await snapshot(source)
    const report = await migrateStorage(source, target)
    expect(await snapshot(source)).toEqual(before)

    expect(report.counts).toEqual({
      folders: 5,
      notes: 7,
      markdownNotes: 6,
      snippetNotes: 1,
      trashedNotes: 1,
      attachments: 6,
      noteLinks: 3,
      skippedNotes: 1,
    })
    expect(report.skipped[0]?.file).toMatch(/broken\.cson$/)

    // Folders: names kept, duplicates and invalid characters renamed, colours and order in config.
    const config = JSON.parse(await readTarget('.boostnote/config.json'))
    expect(config.folderOrder).toEqual(['Work', 'Personal', 'work 2', 'Empty - Folder', 'Unknown 1'])
    expect(config.folders).toEqual({
      Work: { color: '#E10051' },
      Personal: { color: '#1278BD' },
      'work 2': { color: '#30D5C8' },
      'Empty - Folder': { color: '#B013A4' },
    })
    expect(report.renamed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'folder', name: 'work', path: 'work 2' }),
        expect.objectContaining({ kind: 'folder', name: 'Empty / Folder', path: 'Empty - Folder' }),
        expect.objectContaining({
          kind: 'note',
          key: KEYS.welcomeDup,
          path: 'Work/Welcome to Boostnote! 2.md',
          reason: 'duplicate file name',
        }),
      ]),
    )
    expect(report.warnings.some((warning) => warning.includes(KEYS.folderUnknown))).toBe(true)

    // Markdown note: readable file name, frontmatter (no `title`: the file name says it), attachments
    // with every separator style, note links.
    const welcome = parseNoteText(await readTarget('Work/Welcome to Boostnote!.md'))
    expect(welcome.frontmatter).toEqual({
      tags: ['intro', 'docs'],
      starred: true,
      pinned: true,
      created: '2019-03-01T10:00:00.000Z',
      updated: '2019-04-02T11:30:00.000Z',
      boostnote: { key: KEYS.welcome, folder: KEYS.folderWork },
    })
    expect(welcome.body).toBe(
      [
        '# Welcome to Boostnote!',
        '',
        '![posix](./Welcome%20to%20Boostnote!.assets/abc123.png)',
        '![windows](./Welcome%20to%20Boostnote!.assets/def456.jpg)',
        '<img src="./Welcome%20to%20Boostnote!.assets/def456.jpg">',
        '[file](./Welcome%20to%20Boostnote!.assets/My%20Doc.pdf)',
        'See [the duplicate](./Welcome%20to%20Boostnote!%202.md) and [trashed](../Personal/Old%20idea.md).',
        '',
      ].join('\n'),
    )
    expect((await readdir(path.join(target, 'Work/Welcome to Boostnote!.assets'))).sort()).toEqual([
      'My Doc.pdf',
      'abc123.png',
      'def456.jpg',
      'unreferenced.txt',
    ])
    expect(await readTarget('Work/Welcome to Boostnote!.assets/abc123.png')).toBe('PNG-abc')
    expect((await stat(path.join(target, 'Work/Welcome to Boostnote!.md'))).mtime.toISOString()).toBe(
      '2019-04-02T11:30:00.000Z',
    )
    expect(await readTarget('Work/Welcome to Boostnote! 2.md')).toContain('[first](./Welcome%20to%20Boostnote!.md)')

    // Snippet note → markdown with one fenced block per snippet.
    const snippet = parseNoteText(await readTarget('Personal/Snippet note example.md'))
    expect(snippet.frontmatter.title).toBeUndefined()
    expect(snippet.frontmatter.tags).toEqual(['snippets'])
    expect(snippet.body).toBe(
      [
        '# Snippet note example',
        '',
        'Snippet note example\nYou can store a series of snippets as a single note, like Gist.',
        '',
        '## example.html',
        '',
        "```html\n<html>\n<body>\n<h1 id='hello'>Enjoy Boostnote!</h1>\n</body>\n</html>\n```",
        '',
        '## example.js',
        '',
        '````javascript\nconst s = ```\nnot a fence\n```\nconsole.log(s)\n````',
        '',
        '## Snippet 3',
        '',
        '```text\nplain\n```',
        '',
        '## c.cpp',
        '',
        '```cpp\nint main() {}\n```',
        '',
      ].join('\n'),
    )

    // Note without a heading: the file name is its title; legacy images/ refs resolve.
    const plain = parseNoteText(await readTarget('work 2/just some text.md'))
    expect(plain.frontmatter.title).toBeUndefined()
    expect(plain.body).toContain('![legacy](./just%20some%20text.assets/oldimg.png)')
    expect(await readTarget('work 2/just some text.assets/oldimg.png')).toBe('PNG-old')
    expect(report.unresolvedAttachments).toEqual([
      { note: 'work 2/just some text.md', reference: `:storage/${KEYS.plain}/missing.png` },
    ])

    // Content that already had frontmatter: merged, not doubled.
    const fm = await readTarget('Work/FM title.md')
    expect(fm.match(/^---$/gm)).toHaveLength(2)
    expect(parseNoteText(fm).frontmatter).toMatchObject({ title: 'FM title', layout: 'post' })
    expect(parseNoteText(fm).body).toBe('# Heading\n\nBody.\n')

    // Trashed note → .trash with a restore entry; its attachments move with it.
    expect(await readTarget('.trash/Personal/Old idea.assets/x.png')).toBe('PNG-x')
    expect(JSON.parse(await readTarget('.trash/.index.json')).entries).toEqual({
      'Personal/Old idea.md': {
        kind: 'note',
        originalPath: 'Personal/Old idea.md',
        deletedAt: '2019-04-02T11:30:00.000Z',
      },
    })
    expect(report.unresolvedLinks).toEqual([{ note: 'Personal/Old idea.md', reference: `:note:${KEYS.missing}` }])

    // The report is saved, and the result opens as a vault.
    expect(JSON.parse(await readTarget('.boostnote/migration-report.json')).counts.notes).toBe(7)
    const vault = await openVault(target)
    expect(vault.tree().folders.map((folder) => folder.id)).toEqual([
      'Work',
      'Personal',
      'work 2',
      'Empty - Folder',
      'Unknown 1',
    ])
    expect(vault.index.get('Work/Welcome to Boostnote!.md')).toMatchObject({
      title: 'Welcome to Boostnote!',
      starred: true,
      tags: ['intro', 'docs'],
    })
    expect(vault.index.get('Unknown 1/Orphan.md')?.title).toBe('Orphan')
    const trash = await vault.listTrash()
    expect(trash.map((item) => item.title)).toEqual(['Old idea'])
    expect(await vault.restore('Personal/Old idea.md')).toBe('Personal/Old idea.md')
    expect(await vault.assetPath('Personal/Old idea.md', './Old%20idea.assets/x.png')).toBe(
      path.join(vault.root, 'Personal', 'Old idea.assets', 'x.png'),
    )
    await vault.close()
  })

  it('writes nothing on a dry run', async () => {
    const report = await migrateStorage(source, target, { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.counts.notes).toBe(7)
    expect(report.notes.map((item) => item.path)).toContain('Work/Welcome to Boostnote!.md')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a non-empty target unless forced, and never overwrites', async () => {
    await mkdir(path.join(target, 'Work'), { recursive: true })
    await writeFile(path.join(target, 'Work', 'mine.md'), 'mine')
    await writeFile(path.join(target, '.DS_Store'), '')
    await expect(migrateStorage(source, target)).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' })
    expect(await readdir(target)).toEqual(['.DS_Store', 'Work'])

    const report = await migrateStorage(source, target, { force: true })
    expect(await readTarget('Work/mine.md')).toBe('mine')
    expect(report.notes.find((item) => item.key === KEYS.welcome)?.path).toBe('Work 2/Welcome to Boostnote!.md')
  })

  it('rejects a target inside the source and a source without boostnote.json', async () => {
    await expect(migrateStorage(source, path.join(source, 'out'))).rejects.toMatchObject({ code: 'INVALID_TARGET' })
    await expect(migrateStorage(target, path.join(work, 'x'))).rejects.toBeInstanceOf(MigrationError)
    await mkdir(target)
    await expect(migrateStorage(target, path.join(work, 'x'))).rejects.toMatchObject({ code: 'NOT_A_LEGACY_STORAGE' })
  })

  it('reads pre-1.0 storages (notes in <folder>/data.json) without converting them in place', async () => {
    const old = path.join(work, 'old')
    await mkdir(path.join(old, 'f1'), { recursive: true })
    await writeFile(
      path.join(old, 'boostnote.json'),
      JSON.stringify({ folders: [{ key: 'f1', name: 'Old', color: '#000' }] }),
    )
    await writeFile(
      path.join(old, 'f1', 'data.json'),
      JSON.stringify({
        notes: [{ key: 'n1', type: 'MARKDOWN_NOTE', title: 'Ancient', content: '# Ancient\n', tags: [] }],
      }),
    )
    const report = await migrateStorage(old, target)
    expect(report.notes.map((item) => item.path)).toEqual(['Old/Ancient.md'])
    expect(JSON.parse(await readFile(path.join(old, 'boostnote.json'), 'utf8')).version).toBeUndefined()
  })

  it('keeps the legacy title in frontmatter only when the file name cannot spell it', async () => {
    const old = path.join(work, 'names')
    await mkdir(path.join(old, 'f1'), { recursive: true })
    await writeFile(path.join(old, 'boostnote.json'), JSON.stringify({ folders: [{ key: 'f1', name: 'F' }] }))
    const note = (key: string, title: string, content: string, createdAt: string) => ({
      key,
      type: 'MARKDOWN_NOTE',
      title,
      content,
      tags: [],
      createdAt,
    })
    await writeFile(
      path.join(old, 'f1', 'data.json'),
      JSON.stringify({
        notes: [
          note('a', 'Q1: plan / review?', '# Q1: plan / review?\n', '2020-01-01T00:00:00Z'),
          note('b', 'Meeting notes', '# Meeting notes\n', '2020-01-02T00:00:00Z'),
          note('c', 'meeting NOTES', 'x\n', '2020-01-03T00:00:00Z'),
          note('d', '', '', '2020-01-04T00:00:00Z'),
          note('e', 'CON', 'device\n', '2020-01-05T00:00:00Z'),
        ],
      }),
    )
    const report = await migrateStorage(old, target)
    expect(report.notes.map((item) => item.path)).toEqual([
      'F/Q1- plan - review-.md',
      'F/Meeting notes.md',
      'F/meeting NOTES 2.md',
      'F/Untitled.md',
      'F/CON-.md',
    ])
    const title = async (rel: string) => parseNoteText(await readTarget(rel)).frontmatter.title
    expect(await title('F/Q1- plan - review-.md')).toBe('Q1: plan / review?')
    expect(await title('F/Meeting notes.md')).toBeUndefined()
    expect(await title('F/meeting NOTES 2.md')).toBeUndefined()
    expect(await title('F/Untitled.md')).toBeUndefined()
    expect(await title('F/CON-.md')).toBe('CON')
    expect(report.renamed.map((item) => [item.path, item.reason])).toEqual([
      ['F/Q1- plan - review-.md', 'title is not a valid file name'],
      ['F/meeting NOTES 2.md', 'duplicate file name'],
      ['F/Untitled.md', 'empty title'],
      ['F/CON-.md', 'title is not a valid file name'],
    ])
  })
})

describe('findLegacyStorages', () => {
  it('finds ~/Boostnote and storages listed in the legacy app’s localStorage', async () => {
    const home = path.join(work, 'home')
    await createLegacyStorage(path.join(home, 'Boostnote'))
    const extra = path.join(work, 'Dropbox', 'Notes "quoted"')
    await createLegacyStorage(extra)
    const appData = path.join(work, 'appData')
    const storages = JSON.stringify([
      { key: 'k1', type: 'FILESYSTEM', name: 'Synced', path: extra, isOpen: true },
      { key: 'k2', type: 'FILESYSTEM', name: 'Gone', path: path.join(work, 'gone'), isOpen: false },
    ])
    await mkdir(path.join(appData, 'Local Storage', 'leveldb'), { recursive: true })
    // Chromium stores localStorage values as UTF-16LE (prefix byte 0) or Latin-1 (prefix byte 1).
    await writeFile(
      path.join(appData, 'Local Storage', 'leveldb', '000003.log'),
      Buffer.concat([Buffer.from('_file://\0\x01storages'), Buffer.from([0]), Buffer.from(storages, 'utf16le')]),
    )
    const found = await findLegacyStorages({ home, appDataDir: appData })
    expect(found).toEqual([{ path: path.join(home, 'Boostnote') }, { path: extra, name: 'Synced' }])
    expect(await findLegacyStorages({ home: path.join(work, 'nobody'), appDataDir: path.join(work, 'none') })).toEqual(
      [],
    )
  })
})

describe('legacy CSON', () => {
  it('parses multi-line strings the way the legacy writer produced them', () => {
    const text = CSON.stringify({ content: 'a\n  b\n"q"', tags: [] }, null, 2)
    expect(CSON.parse(text)).toEqual({ content: 'a\n  b\n"q"', tags: [] })
  })
})
