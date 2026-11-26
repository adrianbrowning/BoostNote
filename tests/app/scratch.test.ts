import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/app/actions/public/workspace/api.ts'
import type {
  ScratchNote,
  ScratchSaveResult,
  ScratchSummary,
  WorkspaceData,
} from '../../src/app/actions/public/workspace/types.ts'
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

    // Reversed times: no single file order (the ids are random) gives both orders without the sort.
    await touch(first.id, '2026-01-05T10:00:00.000Z')
    await touch(second.id, '2026-01-01T10:00:00.000Z')
    expect((await list()).map((note) => note.id)).toEqual([first.id, third.id, second.id])

    const discarded = await app.post('/api/scratch/discard', { id: third.id })
    expect(discarded.status).toBe(200)
    expect((await list()).map((note) => note.id)).toEqual([first.id, second.id])
    expect(await filesUnder(app.scratchDir)).toEqual(
      [`${first.id}.json`, `${first.id}.md`, `${second.id}.json`, `${second.id}.md`].sort(),
    )
  })

  it('lists no scratch note, with 200, before the scratch folder exists', async () => {
    expect(await filesUnder(path.join(app.dir, 'userData'))).not.toContain('scratch')
    expect(await list()).toEqual([])
  })

  it('answers 400 BAD_REQUEST for a missing or non-string id and touches nothing', async () => {
    const { id } = await create()
    await write(id, 'kept')
    const before = await filesUnder(app.dir)

    const responses = [
      await app.get('/api/scratch/read'),
      await app.post('/api/scratch/write', { text: 'x' }),
      await app.post('/api/scratch/write', { id: 1, text: 'x' }),
      await app.post('/api/scratch/discard', {}),
      await app.post('/api/scratch/discard', { id: 1 }),
    ]

    for (const response of responses) {
      expect(response.status).toBe(400)
      expect((await readJson<{ error: string }>(response)).error).toBe('BAD_REQUEST')
    }
    expect(await filesUnder(app.dir)).toEqual(before)
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('kept')
  })

  it('creates, writes, reads, lists and discards through the page’s client', async () => {
    const client = createClient(app.fetch)

    const { id } = await client.createScratch()
    expect((await client.writeScratch(id, '# T')).text).toBe('# T')
    expect((await client.readScratch(id)).text).toBe('# T')
    expect((await client.listScratch()).map((note) => ({ id: note.id, title: note.title }))).toEqual([
      { id, title: 'T' },
    ])
    await client.discardScratch(id)
    expect(await client.listScratch()).toEqual([])
  })

  it('keeps a scratch note’s creation time once its sidecar is lost, through later writes', async () => {
    const { id } = await create()
    await rm(path.join(app.scratchDir, `${id}.json`))
    const first: ScratchNote = await (await app.get(`/api/scratch/read?id=${id}`)).json()
    // A real pause: the new file's birth time comes from the file system's clock, which fake timers do not move.
    await sleep(20)

    expect((await write(id, '# Later')).status).toBe(200)
    const again: ScratchNote = await (await app.get(`/api/scratch/read?id=${id}`)).json()
    expect(again.created).toBe(first.created)
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
  })

  it('lets no write racing a discard bring the scratch note back, and answers 404 to a write after it', async () => {
    for (let turns = 0; turns < 16; turns++) {
      const { id } = await create()
      const writing = write(id, `text ${turns}`)
      for (let turn = 0; turn < turns; turn++) await nextTurn()
      const discarded = await app.post('/api/scratch/discard', { id })
      const written = await writing

      expect(discarded.status).toBe(200)
      expect([200, 404]).toContain(written.status)
      expect(await filesUnder(app.scratchDir)).toEqual([])
      expect(await list()).toEqual([])

      const late = await write(id, 'late')
      expect(late.status).toBe(404)
      expect((await readJson<{ error: string }>(late)).error).toBe('NOT_FOUND')
      expect(await filesUnder(app.scratchDir)).toEqual([])
    }
  })

  it('discards a scratch note asked ifBlank only when its text is blank, answering whether it did', async () => {
    const blank = await create()
    await write(blank.id, ' \n\t\n')
    const typed = await create()
    await write(typed.id, '  kept\n')

    const removed = await app.post('/api/scratch/discard', { id: blank.id, ifBlank: true })
    expect(removed.status).toBe(200)
    expect(await readJson(removed)).toEqual({ discarded: true })
    const kept = await app.post('/api/scratch/discard', { id: typed.id, ifBlank: true })
    expect(kept.status).toBe(200)
    expect(await readJson(kept)).toEqual({ discarded: false })

    expect(await filesUnder(app.scratchDir)).toEqual([`${typed.id}.json`, `${typed.id}.md`])
    expect((await app.post('/api/scratch/discard', { id: blank.id, ifBlank: true })).status).toBe(404)
    expect((await app.post('/api/scratch/discard', { id: typed.id, ifBlank: 'yes' })).status).toBe(400)
  })

  it.each([
    '../x',
    'ABC',
    `${'a'.repeat(31)}/`,
    `../${'a'.repeat(32)}`,
    'A'.repeat(32),
    'a'.repeat(33),
    '',
    '0123456789abcdef0123456789abcdef', // well-formed, no file
  ])('answers 404 for read, write and discard of %j and touches nothing', async (id) => {
    const outside = path.join(app.dir, 'userData', 'x.md')
    await mkdir(app.scratchDir, { recursive: true })
    await writeFile(outside, 'outside')
    await writeFile(path.join(app.dir, 'userData', `${'a'.repeat(32)}.md`), 'parent')
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
    expect(await readFile(path.join(app.dir, 'userData', `${'a'.repeat(32)}.md`), 'utf8')).toBe('parent')
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

  it.each([
    ['userData', 'the folder that holds the scratch folder'],
    ['.', 'a folder above it'],
  ])('keeps scratch notes out of a vault opened on %j (%s)', async (folder) => {
    const before = await create()
    await write(before.id, '# Zebra before\nzebra')
    const vault = await app.openVault(folder)
    await vault.createNote('', 'Kept')
    const after = await create()
    await write(after.id, '# Zebra after\nzebra')
    await vault.refresh()

    const workspace: WorkspaceData = await (await app.get('/api/workspace')).json()
    expect(workspace.notes.map((note) => note.id)).toEqual(['Kept.md'])
    expect(await (await app.get('/api/search?q=zebra')).json()).toEqual({ ids: [] })
  })
})

describe('/api/scratch/save', () => {
  async function save(id: string, folder: string): Promise<Response> {
    return app.post('/api/scratch/save', { id, folder })
  }

  it('creates the note in the folder from the scratch text, removes the scratch note and answers its id', async () => {
    const vault = await app.openVault()
    await mkdir(path.join(vault.root, 'work'))
    const first = await create()
    await write(first.id, '# Plan\n\n- one\n')
    const second = await create()
    await write(second.id, '---\ntags: [x]\n---\n# Plan\n\nTwo\n')

    const saved = await save(first.id, 'work')
    expect(saved.status).toBe(201)
    const result: ScratchSaveResult = await saved.json()
    expect(result.id).toBe('work/Plan.md')
    expect(result.workspace.notes.map((note) => note.id)).toEqual(['work/Plan.md'])
    const raw = await readFile(path.join(vault.root, 'work', 'Plan.md'), 'utf8')
    expect(raw).toMatch(/^---\ncreated: .+\nupdated: .+\n---\n# Plan\n\n- one\n$/)

    const again: ScratchSaveResult = await (await save(second.id, 'work')).json()
    expect(again.id).toBe('work/Plan 2.md')
    const note = await vault.readNote('work/Plan 2.md')
    expect(note.body).toBe('# Plan\n\nTwo\n')
    expect(note.frontmatter.tags).toEqual(['x'])

    expect(await filesUnder(app.scratchDir)).toEqual([])
    expect(await list()).toEqual([])
  })

  it('answers 409 NO_VAULT with no vault open and keeps the scratch note', async () => {
    const { id } = await create()
    await write(id, 'Keep me')

    const response = await save(id, '')
    expect(response.status).toBe(409)
    expect((await readJson<{ error: string }>(response)).error).toBe('NO_VAULT')
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('Keep me')
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
  })

  it('answers an error for a missing folder and keeps the scratch note, writing no note', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, 'Keep me')

    const response = await save(id, 'gone')
    expect(response.status).toBe(404)
    expect((await readJson<{ error: string }>(response)).error).toBe('NOT_FOUND')
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('Keep me')
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
    expect((await filesUnder(vault.root)).filter((file) => file.endsWith('.md'))).toEqual([])
  })

  it('keeps a valid frontmatter block byte for byte, adding only the created/updated keys it lacks', async () => {
    const vault = await app.openVault()
    const typed = await create()
    const partly = [
      '---',
      'title: "Quoted: value" # kept comment',
      "tags: ['a', b]",
      'created: 2020-01-02T03:04:05.000Z',
      '---',
      '# Partly',
      '',
    ].join('\n')
    await write(typed.id, partly)
    const full = await create()
    const complete = '---\nupdated: "2021-05-06" # typed\ncreated: 2021-05-05\n---\n# Complete\n'
    await write(full.id, complete)

    expect((await app.post('/api/scratch/save', { id: typed.id, folder: '' })).status).toBe(201)
    expect((await app.post('/api/scratch/save', { id: full.id, folder: '' })).status).toBe(201)

    const saved = await readFile(path.join(vault.root, 'Partly.md'), 'utf8')
    const updated = /\nupdated: (.+)\n---\n/.exec(saved)?.[1] ?? ''
    expect(updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(saved).toBe(partly.replace('---\n# Partly', `updated: ${updated}\n---\n# Partly`))
    expect(await readFile(path.join(vault.root, 'Complete.md'), 'utf8')).toBe(complete)
  })

  it('keeps a frontmatter block that appended lines would not extend exactly as typed, adding nothing', async () => {
    const vault = await app.openVault()
    const blocks = {
      Flow: "{title: 'quoted', tags: [a,b]} # kept\n",
      Anchored: '&anchor {}\n',
      Complex: '? [a]\n: 1\n',
      Alias: 'a: &x k\n*x : 2\n',
      Null: '~: 1\n',
    }
    for (const [name, yaml] of Object.entries(blocks)) {
      const { id } = await create()
      const typed = `---\n${yaml}---\n# ${name}\n`
      await write(id, typed)
      expect((await app.post('/api/scratch/save', { id, folder: '' })).status).toBe(201)
      expect(await readFile(path.join(vault.root, `${name}.md`), 'utf8')).toBe(typed)
    }
  })

  it('saves text whose leading block has an unresolved alias as body, adding created/updated', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    const typed = '---\nNote: *important*\n---\nbody'
    await write(id, typed)

    expect((await app.post('/api/scratch/save', { id, folder: '' })).status).toBe(201)
    const files = (await filesUnder(vault.root)).filter((file) => file.endsWith('.md'))
    expect(files).toHaveLength(1)
    const saved = await readFile(path.join(vault.root, files[0] ?? ''), 'utf8')
    expect(saved).toMatch(/^---\ncreated: \S+\nupdated: \S+\n---\n/)
    expect(saved.replace(/^---\ncreated: \S+\nupdated: \S+\n---\n/, '')).toBe(typed)
  })

  it('keeps a block with an integer-like key after another key byte for byte, appending created/updated', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    const typed = "---\nz: 'quoted' # c\ntags: [a,b]\n1: 2\n---\n# Numbered\n"
    await write(id, typed)

    expect((await app.post('/api/scratch/save', { id, folder: '' })).status).toBe(201)

    const saved = await readFile(path.join(vault.root, 'Numbered.md'), 'utf8')
    const stamp = /\ncreated: (\S+)\nupdated: \1\n---\n/.exec(saved)?.[1] ?? ''
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(saved).toBe(
      `---\nz: 'quoted' # c\ntags: [a,b]\n1: 2\ncreated: ${stamp}\nupdated: ${stamp}\n---\n# Numbered\n`,
    )
  })

  it('keeps a block with a ten-digit array-index key after another key byte for byte', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '---\nz: x # c\ntags: [a,b]\n4294967294: 2\n---\n# Big\n')

    expect((await app.post('/api/scratch/save', { id, folder: '' })).status).toBe(201)

    const saved = await readFile(path.join(vault.root, 'Big.md'), 'utf8')
    const stamp = /\ncreated: (\S+)\nupdated: \1\n---\n/.exec(saved)?.[1] ?? ''
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(saved).toBe(`---\nz: x # c\ntags: [a,b]\n4294967294: 2\ncreated: ${stamp}\nupdated: ${stamp}\n---\n# Big\n`)
  })

  it('saves into the vault the request names, not the active one, and answers that vault’s lists', async () => {
    const first = await app.openVault('first')
    const second = await app.openVault('second')
    expect(app.vaults.current?.root).toBe(second.root)
    const { id } = await create()
    await write(id, '# Into first\n')

    const response = await app.post('/api/scratch/save', { id, folder: '' }, { vault: first.root })
    expect(response.status).toBe(201)
    const result: ScratchSaveResult = await response.json()
    expect(result.id).toBe('Into first.md')
    expect(result.workspace.vault?.root).toBe(first.root)
    expect(result.workspace.notes.map((note) => note.id)).toEqual(['Into first.md'])
    expect((await filesUnder(first.root)).filter((file) => file.endsWith('.md'))).toEqual(['Into first.md'])
    expect((await filesUnder(second.root)).filter((file) => file.endsWith('.md'))).toEqual([])
  })

  it('answers 409 NO_VAULT for a vault that is no longer open, even with another one active, and keeps the scratch note', async () => {
    const first = await app.openVault('first')
    const second = await app.openVault('second')
    await app.vaults.close(first.root)
    const { id } = await create()
    await write(id, 'Keep me')

    const response = await app.post('/api/scratch/save', { id, folder: '' }, { vault: first.root })
    expect(response.status).toBe(409)
    expect((await readJson<{ error: string }>(response)).error).toBe('NO_VAULT')
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
    expect((await filesUnder(second.root)).filter((file) => file.endsWith('.md'))).toEqual([])
  })

  it('answers 404 for a scratch note already saved, gone or malformed, writing no note', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '# Once\n')
    expect((await save(id, '')).status).toBe(201)

    for (const gone of [id, 'f'.repeat(32), '../x']) {
      const response = await save(gone, '')
      expect(response.status).toBe(404)
      expect((await readJson<{ error: string }>(response)).error).toBe('NOT_FOUND')
    }
    expect((await filesUnder(vault.root)).filter((file) => file.endsWith('.md'))).toEqual(['Once.md'])
  })

  it('answers 400 BAD_REQUEST without an id or a folder and keeps the scratch note', async () => {
    await app.openVault()
    const { id } = await create()
    await write(id, 'Keep me')

    for (const body of [{ folder: '' }, { id }]) {
      const response = await app.post('/api/scratch/save', body)
      expect(response.status).toBe(400)
      expect((await readJson<{ error: string }>(response)).error).toBe('BAD_REQUEST')
    }
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
  })

  it('waits in the vault queue: a close queued first makes it answer 409 NO_VAULT, keeping the scratch note', async () => {
    const first = await app.openVault('first')
    const { id } = await create()
    await write(id, 'Keep me')

    const closing = app.vaults.close(first.root)
    const response = await app.post('/api/scratch/save', { id, folder: '' }, { vault: first.root })
    await closing

    expect(response.status).toBe(409)
    expect((await readJson<{ error: string }>(response)).error).toBe('NO_VAULT')
    expect(await filesUnder(app.scratchDir)).toEqual([`${id}.json`, `${id}.md`])
    expect((await filesUnder(first.root)).filter((file) => file.endsWith('.md'))).toEqual([])
  })

  it('appends created/updated to a CRLF frontmatter block with CRLF line endings', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '---\r\ntitle: x # c\r\n---\r\n# Crlf\r\n')

    expect((await save(id, '')).status).toBe(201)

    const saved = await readFile(path.join(vault.root, 'Crlf.md'), 'utf8')
    const stamp = /\r\ncreated: (\S+)\r\nupdated: \1\r\n/.exec(saved)?.[1] ?? ''
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(saved).toBe(`---\r\ntitle: x # c\r\ncreated: ${stamp}\r\nupdated: ${stamp}\r\n---\r\n# Crlf\r\n`)
  })

  it.each([
    ['a map', 'a: &a {self: *a}'],
    ['a sequence', 'a: &a [*a]'],
  ])('saves text whose leading block has a recursive alias in %s as body, and the note opens', async (_, yaml) => {
    const vault = await app.openVault()
    const { id } = await create()
    const typed = `---\n${yaml}\n---\n# Loop\n`
    await write(id, typed)

    const response = await save(id, '')
    expect(response.status).toBe(201)
    const { id: note } = await readJson<ScratchSaveResult>(response)
    const saved = await readFile(path.join(vault.root, note), 'utf8')
    expect(saved).toMatch(/^---\ncreated: \S+\nupdated: \S+\n---\n/)
    expect(saved.replace(/^---\ncreated: \S+\nupdated: \S+\n---\n/, '')).toBe(typed)
    expect((await app.get(`/api/notes/read?${new URLSearchParams({ id: note })}`)).status).toBe(200)
  })

  it('keeps the scratch note when the vault’s lists cannot be read after the note was created', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '# Listed\n')
    vi.spyOn(vault, 'listTrash').mockRejectedValueOnce(new Error('EIO: i/o error'))

    // A plain fs error, which the router throws: the request fails.
    const saved = await save(id, '').then(
      (response) => response.ok,
      () => false,
    )
    expect(saved).toBe(false)

    expect((await vault.readNote('Listed.md')).body).toBe('# Listed\n')
    expect((await list()).map((note) => ({ id: note.id, title: note.title }))).toEqual([{ id, title: 'Listed' }])
  })

  it('answers the saved note when the list’s Discard removed the scratch note while the save ran', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '# Raced\n')
    const createNote = vault.createNote.bind(vault)
    vi.spyOn(vault, 'createNote').mockImplementation(async (...args) => {
      const note = await createNote(...args)
      expect((await app.post('/api/scratch/discard', { id })).status).toBe(200)
      return note
    })

    const response = await save(id, '')
    expect(response.status).toBe(201)
    expect((await readJson<ScratchSaveResult>(response)).id).toBe('Raced.md')
    expect(await filesUnder(app.scratchDir)).toEqual([])
  })
})

describe('/api/scratch/save when removing the scratch note fails', () => {
  it('keeps the new note and the scratch note, listed with its text, when its sidecar cannot be removed', async () => {
    const vault = await app.openVault()
    const { id } = await create()
    await write(id, '# Twice\n')
    const sidecar = path.join(app.scratchDir, `${id}.json`)
    const createNote = vault.createNote.bind(vault)
    // Once the note is written, the sidecar becomes a non-empty folder, which removing it as a file fails on.
    vi.spyOn(vault, 'createNote').mockImplementation(async (...args) => {
      const note = await createNote(...args)
      await rm(sidecar)
      await mkdir(path.join(sidecar, 'blocker'), { recursive: true })
      return note
    })

    // A plain fs error, which the router throws: the request fails.
    const saved = await app.post('/api/scratch/save', { id, folder: '' }).then(
      (response) => response.ok,
      () => false,
    )
    expect(saved).toBe(false)
    await rm(sidecar, { recursive: true })

    expect((await vault.readNote('Twice.md')).body).toBe('# Twice\n')
    expect((await list()).map((note) => ({ id: note.id, title: note.title }))).toEqual([{ id, title: 'Twice' }])
    expect(await readFile(path.join(app.scratchDir, `${id}.md`), 'utf8')).toBe('# Twice\n')
  })
})
