import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openVault, type Vault, type VaultEvent } from '../../src/vault/index.ts'

let dir: string
let root: string
let src: string
let vault: Vault

async function put(base: string, rel: string, content: string | Uint8Array): Promise<string> {
  const file = path.join(base, ...rel.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

const read = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const assetName = (content: string, ext: string) => `${sha(Buffer.from(content)).slice(0, 12)}.${ext}`

/** Every file under `base` (relative POSIX paths), hidden ones included. */
async function listFiles(base: string): Promise<string[]> {
  const entries = await readdir(base, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(base, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

async function hashTree(base: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const rel of await listFiles(base)) result[rel] = sha(await readFile(path.join(base, rel)))
  return result
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vault-import-'))
  root = path.join(dir, 'vault')
  src = path.join(dir, 'src')
  await mkdir(root)
  await mkdir(src)
  vault = await openVault(root)
})

afterEach(async () => {
  await vault.close()
  await rm(dir, { recursive: true, force: true })
})

describe('importFiles', () => {
  it('copies a single note byte-for-byte, keeping frontmatter and mtime', async () => {
    const text = '---\ntitle: Kept\ncustom: [1, 2]\n---\n# Hello\r\n\r\nNo links here.\n'
    const file = await put(src, 'Hello World.md', text)
    const mtime = new Date('2020-01-02T03:04:05Z')
    await utimes(file, mtime, mtime)

    const report = await vault.importFiles([file], '')

    expect(report.notes).toEqual([{ source: file, id: 'Hello World.md' }])
    expect(await read('Hello World.md')).toBe(text)
    expect((await stat(path.join(root, 'Hello World.md'))).mtime.getTime()).toBe(mtime.getTime())
    expect(vault.index.get('Hello World.md')?.title).toBe('Kept')
  })

  it('keeps bytes that are not valid UTF-8 when no link changes', async () => {
    const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe, 0x0a])
    const file = await put(src, 'latin1.md', bytes)
    await vault.importFiles([file], '')
    expect(new Uint8Array(await readFile(path.join(root, 'latin1.md')))).toEqual(bytes)
  })

  it('turns .markdown into .md and suffixes names taken in the folder (ignoring case)', async () => {
    await put(root, 'work/notes.md', 'existing')
    await vault.refresh()
    const a = await put(src, 'Notes.markdown', 'a')
    const b = await put(src, 'other/notes.md', 'b')

    const report = await vault.importFiles([a, b], 'work')

    expect(report.notes.map((note) => note.id)).toEqual(['work/Notes 2.md', 'work/notes 3.md'])
    expect(await read('work/notes.md')).toBe('existing')
    expect(await read('work/Notes 2.md')).toBe('a')
    expect(await read('work/notes 3.md')).toBe('b')
  })

  it('copies linked images into the note’s assets folder and rewrites only those links', async () => {
    await put(src, 'my image.png', 'PNG1')
    await put(src, 'img/b.gif', 'GIF')
    const body = [
      '![a](./my%20image.png "t") and ![again](my%20image.png)',
      '<img src="img/b.gif" width="10">',
      '`![code](./my%20image.png)`',
      '```',
      '![fenced](./my%20image.png)',
      '```',
      '[web](https://example.com/x.png) [missing](./nope.png) [up](../outside.png) [anchor](#top)',
      '',
    ].join('\n')
    await put(dir, 'outside.png', 'OUT')
    const file = await put(src, 'Note.md', `---\ntags: [x]\n---\n${body}`)

    const report = await vault.importFiles([file], '')

    const png = assetName('PNG1', 'png')
    const gif = assetName('GIF', 'gif')
    expect(await read('Note.md')).toBe(
      `---\ntags: [x]\n---\n${body
        .replace('](./my%20image.png "t")', `](./Note.assets/${png} "t")`)
        .replace('](my%20image.png)', `](./Note.assets/${png})`)
        .replace('src="img/b.gif"', `src="./Note.assets/${gif}"`)}`,
    )
    expect(await read(`Note.assets/${png}`)).toBe('PNG1')
    expect(await read(`Note.assets/${gif}`)).toBe('GIF')
    expect(report.assets).toBe(2)
    expect(report.links).toBe(3)
    expect(report.unresolved).toEqual([
      { id: 'Note.md', link: 'https://example.com/x.png', reason: 'web link' },
      { id: 'Note.md', link: './nope.png', reason: 'file not found' },
      { id: 'Note.md', link: '../outside.png', reason: 'outside the dropped files' },
    ])
  })

  it('rewrites links between notes dropped together, and reports links to other notes', async () => {
    await put(src, 'Other Note.md', 'other')
    await put(src, 'not dropped.md', 'x')
    const a = await put(src, 'a.md', '[o](./Other%20Note.md#sec) [n](not%20dropped.md)\n')
    const b = path.join(src, 'Other Note.md')
    await put(root, 'Other Note.md', 'already here')
    await vault.refresh()

    const report = await vault.importFiles([a, b], '')

    expect(report.notes.map((note) => note.id)).toEqual(['a.md', 'Other Note 2.md'])
    expect(await read('a.md')).toBe('[o](./Other%20Note%202.md#sec) [n](not%20dropped.md)\n')
    expect(report.unresolved).toEqual([{ id: 'a.md', link: 'not dropped.md', reason: 'note not part of this import' }])
  })

  it('imports a folder with its structure, skipping other files and empty folders', async () => {
    await put(src, 'Project/readme.md', '[sub](sub/deep.md) ![i](assets/pic.jpg)\n')
    await put(src, 'Project/sub/deep.md', '[up](../readme.md) ![i](../assets/pic.jpg)\n')
    await put(src, 'Project/assets/pic.jpg', 'JPG')
    await put(src, 'Project/notes.txt', 'text')
    await put(src, 'Project/empty/data.json', '{}')
    await put(src, 'Project/.git/HEAD.md', 'hidden')
    await put(root, 'Project/existing.md', 'x')
    await vault.refresh()
    const before = await hashTree(src)
    const events: VaultEvent[] = []
    vault.subscribe((event) => events.push(event))

    const report = await vault.importFiles([path.join(src, 'Project')], '')

    const jpg = assetName('JPG', 'jpg')
    expect(report.notes.map((note) => note.id)).toEqual(['Project 2/readme.md', 'Project 2/sub/deep.md'])
    expect(await read('Project 2/readme.md')).toBe(`[sub](sub/deep.md) ![i](./readme.assets/${jpg})\n`)
    expect(await read('Project 2/sub/deep.md')).toBe(`[up](../readme.md) ![i](./deep.assets/${jpg})\n`)
    expect(await listFiles(path.join(root, 'Project 2'))).toEqual([
      `readme.assets/${jpg}`,
      'readme.md',
      `sub/deep.assets/${jpg}`,
      'sub/deep.md',
    ])
    expect(report.skipped.map((skip) => [path.relative(src, skip.source), skip.reason])).toEqual([
      [path.join('Project', 'empty', 'data.json'), 'not a Markdown file'],
      [path.join('Project', 'notes.txt'), 'not a Markdown file'],
    ])
    expect(vault.folders).toEqual(['Project', 'Project 2', 'Project 2/sub'])
    expect(await hashTree(src)).toEqual(before)
    // The vault's own writes are not reported as external changes.
    expect(await vault.refresh()).toEqual([])
    expect(events).toEqual([])
  })

  it('skips non-Markdown files, missing paths and folders without notes', async () => {
    const txt = await put(src, 'a.txt', 'x')
    await put(src, 'Empty/readme.txt', 'x')
    const report = await vault.importFiles([txt, path.join(src, 'gone.md'), path.join(src, 'Empty')], '')
    expect(report.notes).toEqual([])
    expect(report.skipped.map((skip) => skip.reason)).toEqual([
      'not a Markdown file',
      'not found',
      'no Markdown files in this folder',
    ])
    expect(await listFiles(root)).toEqual([])
  })

  it('copies a note of the vault into another folder, but not into its own', async () => {
    await put(root, 'work/todo.md', '![i](./todo.assets/x.png)\n')
    await put(root, 'work/todo.assets/x.png', 'X')
    await mkdir(path.join(root, 'home'))
    await vault.refresh()
    const own = path.join(root, 'work', 'todo.md')

    const same = await vault.importFiles([own], 'work')
    expect(same.notes).toEqual([])
    expect(same.skipped).toEqual([{ source: own, reason: 'already in “work”' }])

    const folderInto = await vault.importFiles([path.join(root, 'work')], 'work')
    expect(folderInto.skipped).toEqual([
      { source: path.join(root, 'work'), reason: 'cannot import a folder into itself' },
    ])

    const copied = await vault.importFiles([own], 'home')
    expect(copied.notes.map((note) => note.id)).toEqual(['home/todo.md'])
    expect(await read('home/todo.md')).toBe(`![i](./todo.assets/${assetName('X', 'png')})\n`)
    expect(await read('work/todo.md')).toBe('![i](./todo.assets/x.png)\n')
  })

  it('writes nothing outside the vault and rejects imports over the limits', async () => {
    const file = await put(src, 'n.md', '![i](../../escape.png)\n')
    await put(dir, 'escape.png', 'E')
    const outside = async () => Object.entries(await hashTree(dir)).filter(([rel]) => !rel.startsWith('vault/'))
    const outsideBefore = await outside()
    await expect(vault.importFiles([file], '../x')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await vault.importFiles([file], '')
    expect(await outside()).toEqual(outsideBefore)
    expect(await listFiles(root)).toEqual(['n.md'])

    await put(src, 'many/a.md', 'a')
    await put(src, 'many/b.md', 'b')
    await expect(vault.importFiles([path.join(src, 'many')], '', { limits: { maxFiles: 1 } })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    await expect(vault.importFiles([path.join(src, 'many')], '', { limits: { maxBytes: 1 } })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    expect(await listFiles(root)).toEqual(['n.md'])
  })
})
