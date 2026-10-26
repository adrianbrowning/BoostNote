import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import CSON from 'cson-parser'

/** Keys as the legacy app generated them: uuid v4 for notes (`keygen(true)`), 20 hex chars for folders. */
export const KEYS = {
  welcome: '0b3e1c2a-4d5f-4a6b-8c7d-9e0f1a2b3c4d',
  welcomeDup: '1c4f2d3b-5e6a-4b7c-9d8e-0f1a2b3c4d5e',
  snippet: '2d5a3e4c-6f7b-4c8d-ae9f-1a2b3c4d5e6f',
  trashed: '3e6b4f5d-7a8c-4d9e-bfa0-2b3c4d5e6f7a',
  plain: '4f7c5a6e-8b9d-4eaf-80b1-3c4d5e6f7a8b',
  orphan: '5a8d6b7f-9cae-4fb0-91c2-4d5e6f7a8b9c',
  frontmatter: '6b9e7c8a-adbf-40c1-a2d3-5e6f7a8b9cad',
  missing: 'ffffffffffffffffffff',
  folderWork: 'a1b2c3d4e5f6a7b8c9d0',
  folderPersonal: 'b2c3d4e5f6a7b8c9d0e1',
  folderWorkDup: 'c3d4e5f6a7b8c9d0e1f2',
  folderEmpty: 'd4e5f6a7b8c9d0e1f2a3',
  folderUnknown: 'e5f6a7b8c9d0e1f2a3b4',
} as const

async function put(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}

/** Writes a note the way legacy `createNote`/`updateNote` did: `CSON.writeFileSync(file, note)`. */
async function note(storage: string, key: string, data: Record<string, unknown>): Promise<void> {
  await put(path.join(storage, 'notes', `${key}.cson`), CSON.stringify(data, null, 2))
}

/** A legacy Boostnote storage exercising every importer path. */
export async function createLegacyStorage(storage: string): Promise<void> {
  await put(
    path.join(storage, 'boostnote.json'),
    JSON.stringify({
      folders: [
        { key: KEYS.folderWork, name: 'Work', color: '#E10051' },
        { key: KEYS.folderPersonal, name: 'Personal', color: '#1278BD' },
        { key: KEYS.folderWorkDup, name: 'work', color: '#30D5C8' },
        { key: KEYS.folderEmpty, name: 'Empty / Folder', color: '#B013A4' },
      ],
      version: '1.0',
    }),
  )
  const created = new Date('2019-03-01T10:00:00.000Z')
  const updated = new Date('2019-04-02T11:30:00.000Z')

  await note(storage, KEYS.welcome, {
    createdAt: created,
    updatedAt: updated,
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderWork,
    title: 'Welcome to Boostnote!',
    tags: ['intro', 'docs', '  ', 3],
    content: [
      '# Welcome to Boostnote!',
      '',
      `![posix](:storage/${KEYS.welcome}/abc123.png)`,
      `![windows](:storage\\${KEYS.welcome}\\def456.jpg)`,
      `<img src=":storage%5C${KEYS.welcome}%5Cdef456.jpg">`,
      `[file](/:storage/${KEYS.welcome}/My%20Doc.pdf)`,
      `See [the duplicate](:note:${KEYS.welcomeDup}) and [trashed](:note:${KEYS.trashed}).`,
      '',
    ].join('\n'),
    linesHighlighted: [1, 2],
    isStarred: true,
    isTrashed: false,
    isPinned: true,
    blog: { blogLink: 'https://example.com/post', blogId: 42 },
  })
  await note(storage, KEYS.welcomeDup, {
    createdAt: new Date('2019-05-01T00:00:00.000Z'),
    updatedAt: new Date('2019-05-02T00:00:00.000Z'),
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderWork,
    title: 'Welcome to Boostnote!',
    tags: [],
    content: `# Welcome to Boostnote!\n\nSecond copy, linking back to [first](:note:${KEYS.welcome}).\n`,
    isStarred: false,
    isTrashed: false,
  })
  await note(storage, KEYS.snippet, {
    createdAt: created,
    updatedAt: updated,
    type: 'SNIPPET_NOTE',
    folder: KEYS.folderPersonal,
    title: 'Snippet note example',
    description: 'Snippet note example\nYou can store a series of snippets as a single note, like Gist.',
    snippets: [
      {
        name: 'example.html',
        mode: 'HTML',
        content: "<html>\n<body>\n<h1 id='hello'>Enjoy Boostnote!</h1>\n</body>\n</html>",
        linesHighlighted: [],
      },
      {
        name: 'example.js',
        mode: 'JavaScript',
        content: 'const s = ```\nnot a fence\n```\nconsole.log(s)',
        linesHighlighted: [2],
      },
      { name: '', mode: 'Plain Text', content: 'plain', linesHighlighted: [] },
      { name: 'c.cpp', mode: 'C++', content: 'int main() {}', linesHighlighted: [] },
    ],
    tags: ['snippets'],
    isStarred: false,
    isTrashed: false,
  })
  await note(storage, KEYS.trashed, {
    createdAt: created,
    updatedAt: updated,
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderPersonal,
    title: 'Old idea',
    tags: [],
    content: `# Old idea\n\n![x](:storage/${KEYS.trashed}/x.png)\n[gone](:note:${KEYS.missing})\n`,
    isStarred: false,
    isTrashed: true,
  })
  await note(storage, KEYS.plain, {
    createdAt: created,
    updatedAt: updated,
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderWorkDup,
    title: 'just some text',
    tags: [],
    content: `just some text\n\n![legacy](:storage/oldimg.png)\n![lost](:storage/${KEYS.plain}/missing.png)\n`,
    isStarred: false,
    isTrashed: false,
  })
  await note(storage, KEYS.orphan, {
    createdAt: created,
    updatedAt: updated,
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderUnknown,
    title: 'Orphan',
    tags: [],
    content: '# Orphan\n',
    isStarred: false,
    isTrashed: false,
  })
  await note(storage, KEYS.frontmatter, {
    createdAt: created,
    updatedAt: updated,
    type: 'MARKDOWN_NOTE',
    folder: KEYS.folderWork,
    title: 'FM title',
    tags: [],
    content: '---\ntitle: FM title\nlayout: post\n---\n# Heading\n\nBody.\n',
    isStarred: false,
    isTrashed: false,
  })
  await put(path.join(storage, 'notes', 'broken.cson'), "type: 'MARKDOWN_NOTE\ncontent: '''\n")
  await put(path.join(storage, 'notes', 'README.txt'), 'not a note')

  await put(path.join(storage, 'attachments', KEYS.welcome, 'abc123.png'), 'PNG-abc')
  await put(path.join(storage, 'attachments', KEYS.welcome, 'def456.jpg'), 'JPG-def')
  await put(path.join(storage, 'attachments', KEYS.welcome, 'My Doc.pdf'), 'PDF')
  await put(path.join(storage, 'attachments', KEYS.welcome, 'unreferenced.txt'), 'extra')
  await put(path.join(storage, 'attachments', KEYS.trashed, 'x.png'), 'PNG-x')
  await put(path.join(storage, 'images', 'oldimg.png'), 'PNG-old')
}
