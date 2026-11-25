import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ScratchNote, ScratchSummary, WorkspaceData } from '../../src/app/actions/public/workspace/types.ts'
import { TestApp } from './helpers.ts'

let app: TestApp

beforeEach(async () => {
  app = await TestApp.create()
})

afterEach(async () => {
  await app.close()
})

const HEX_ID = /^[0-9a-f]{32}$/

async function create(options: { vault?: string | null } = {}): Promise<ScratchNote> {
  const response = await app.post('/api/scratch/create', {}, options)
  expect(response.status).toBe(201)
  return response.json()
}

async function write(id: string, text: string): Promise<Response> {
  return app.post('/api/scratch/write', { id, text })
}

async function list(): Promise<ScratchSummary[]> {
  const response = await app.get('/api/scratch')
  expect(response.status).toBe(200)
  return response.json()
}

async function readJson<T>(response: Response): Promise<T> {
  const body: T = await response.json()
  return body
}

/** Sets scratch note `id`'s modification time to `iso`, as if it was last written then. */
async function touch(id: string, iso: string): Promise<void> {
  await utimes(path.join(app.scratchDir, `${id}.md`), new Date(iso), new Date(iso))
}

/** Every file under `dir`, as paths relative to it (`[]` when it does not exist). */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [])
  return entries.sort()
}

describe('/api/scratch', () => {
  it('creates a scratch note under userData/scratch with no vault open', async () => {
    const vaultFolder = path.join(app.dir, 'vault')
    await mkdir(vaultFolder)

    const note = await create({ vault: null })

    expect(note.id).toMatch(HEX_ID)
    expect(note).toEqual({ id: note.id, text: '', title: note.title, created: note.created, updated: note.updated })
    expect(note.title).toMatch(/^Scratch \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(await filesUnder(app.scratchDir)).toEqual([`${note.id}.json`, `${note.id}.md`])
    expect(await filesUnder(vaultFolder)).toEqual([])
  })

  it('reads back what was written, byte for byte, with no temp file left', async () => {
    const created = await create({ vault: null })
    const { id } = created
    const text = '# Plan\n\n- one\n- two\n'

    const written = await write(id, text)
    expect(written.status).toBe(200)
    expect((await readJson<ScratchNote>(written)).text).toBe(text)

    const read = await app.get(`/api/scratch/read?id=${id}`)
    expect(read.status).toBe(200)
    const note: ScratchNote = await read.json()
    expect(note.text).toBe(text)
    expect(note.title).toBe('Plan')
    expect(note.created).toBe(created.created)
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe(text)
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
  })

  it('lists every scratch note by title, newest updated first, and forgets a discarded one', async () => {
    const first = await create()
    const second = await create()
    const third = await create()
    await write(first.id, '# First')
    await write(third.id, 'third line\nmore')
    await write(second.id, '```\n# fenced\n```\n## Second')
    await touch(first.id, '2026-01-01T10:00:00.000Z')
    await touch(third.id, '2026-01-02T10:00:00.000Z')
    await touch(second.id, '2026-01-03T10:00:00.000Z')

    const listed = await list()
    expect(listed.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: second.id, title: 'Second' },
      { id: third.id, title: 'third line' },
      { id: first.id, title: 'First' },
    ])
    expect(listed[0]).toEqual({
      id: second.id,
      title: 'Second',
      created: second.created,
      updated: '2026-01-03T10:00:00.000Z',
    })

    const discarded = await app.post('/api/scratch/discard', { id: third.id })
    expect(discarded.status).toBe(200)
    expect((await list()).map((note) => note.id)).toEqual([second.id, first.id])
    expect(await filesUnder(app.scratchDir)).toEqual(
      [`${first.id}.json`, `${first.id}.md`, `${second.id}.json`, `${second.id}.md`].sort(),
    )
  })

  it.each([
    '../x',
    'ABC',
    `${'a'.repeat(31)}/`,
    `../${'a'.repeat(32)}`,
    'A'.repeat(32),
    'a'.repeat(33),
    '0123456789abcdef0123456789abcdef', // well-formed, no file
  ])('answers 404 for read, write and discard of %j and touches nothing', async (id) => {
    const outside = path.join(app.dir, 'userData', 'x.md')
    await mkdir(app.scratchDir, { recursive: true })
    await writeFile(outside, 'outside')
    await writeFile(path.join(app.dir, `${'a'.repeat(32)}.md`), 'parent')
    const before = await filesUnder(app.dir)

    const responses = [
      await app.get(`/api/scratch/read?${new URLSearchParams({ id })}`),
      await write(id, 'overwritten'),
      await app.post('/api/scratch/discard', { id }),
    ]

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect((await readJson<{ error: string }>(response)).error).toBe('NOT_FOUND')
    }
    expect(await filesUnder(app.dir)).toEqual(before)
    expect(await readFile(outside, 'utf8')).toBe('outside')
    expect(await readFile(path.join(app.dir, `${'a'.repeat(32)}.md`), 'utf8')).toBe('parent')
  })

  it('works while a vault is open and keeps scratch notes out of its notes, search and workspace', async () => {
    const vault = await app.openVault()
    await vault.createNote('', 'Kept')

    const { id } = await create()
    expect((await write(id, '# Zebra scratch\nzebra')).status).toBe(200)
    expect((await app.get(`/api/scratch/read?id=${id}`)).status).toBe(200)
    expect((await list()).map((note) => note.id)).toEqual([id])

    const workspace: WorkspaceData = await (await app.get('/api/workspace')).json()
    expect(workspace.notes.map((note) => note.id)).toEqual(['Kept.md'])
    expect(await (await app.get('/api/search?q=zebra')).json()).toEqual({ ids: [] })
    expect((await filesUnder(vault.root)).filter((file) => file.endsWith('.md'))).toEqual(['Kept.md'])

    expect((await app.post('/api/scratch/discard', { id })).status).toBe(200)
  })
})
