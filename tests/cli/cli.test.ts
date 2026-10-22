import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/cli/main.ts'
import { resolveVaultDir } from '../../src/cli/vault-dir.ts'

let root: string

const TODO = `---
tags: [work, todo]
starred: true
priority: high # keep me
status: draft
created: 2024-01-01T00:00:00.000Z
---
# Todo

- [x] write the CLI
- [ ] write the docs
- [ ] ship it
`

const FILES: Record<string, string> = {
  'index.md': '# Index\n\nSee [the todo list](work/todo.md) and [plan](work/plan.md).\n',
  'work/todo.md': TODO,
  'work/plan.md': '---\ntags: [work]\n---\nThe plan: finish [todo](todo.md) then [again](./todo.md#top).\n',
  'personal/todo.md': '# Personal todo\n\nbuy milk\n',
  'archive/.keep/x.md': 'hidden',
}

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

const read = (rel: string) => readFile(path.join(root, rel), 'utf8')

interface Run {
  code: number
  stdout: string
  stderr: string
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON output
  json: () => any
}

/** Runs the CLI on the test vault, with `stdin` as piped input. */
async function cli(args: string[], stdin?: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const code = await runCli(['--vault', root, ...args], {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    stdin: async () => stdin,
    env,
  })
  return { code, stdout, stderr, json: () => JSON.parse(stdout) }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'boost-cli-'))
  for (const [rel, content] of Object.entries(FILES)) await put(rel, content)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('reading', () => {
  it('lists notes with filters, sort and limit', async () => {
    const all = await cli(['list', '--json', '--sort', 'id'])
    expect(all.code).toBe(0)
    const notes = all.json()
    expect(notes.map((note: { id: string }) => note.id)).toEqual([
      'index.md',
      'personal/todo.md',
      'work/plan.md',
      'work/todo.md',
    ])
    expect(Object.keys(notes[3]).sort()).toEqual(
      ['created', 'excerpt', 'folder', 'id', 'starred', 'tags', 'title', 'updated'].sort(),
    )
    expect(notes[3]).toMatchObject({ id: 'work/todo.md', folder: 'work', title: 'todo', starred: true })

    expect(
      (await cli(['list', '--json', '--tag', 'work', '--sort', 'id'])).json().map((n: { id: string }) => n.id),
    ).toEqual(['work/plan.md', 'work/todo.md'])
    expect((await cli(['list', '--json', '--starred'])).json().map((n: { id: string }) => n.id)).toEqual([
      'work/todo.md',
    ])
    expect((await cli(['list', '--json', '--folder', ''])).json().map((n: { id: string }) => n.id)).toEqual([
      'index.md',
    ])
    expect((await cli(['list', '--json', '--folder', '/', '--recursive'])).json()).toHaveLength(4)
    expect((await cli(['list', '--json', '--folder', 'work', '--limit', '1'])).json()).toHaveLength(1)
    const text = await cli(['list', '--folder', 'work', '--sort', 'title'])
    expect(text.stdout).toMatch(/^work\/plan\.md — plan {2}#work/)
    expect(text.stdout).toContain('★ work/todo.md — todo  #work #todo')
    expect((await cli(['list', '--folder', 'nope'])).code).toBe(4)
    expect((await cli(['list', '--sort', 'size'])).code).toBe(2)
  })

  it('searches the index', async () => {
    const run = await cli(['search', 'milk', '--json'])
    expect(run.code).toBe(0)
    expect(run.json()).toEqual([{ id: 'personal/todo.md', title: 'todo', excerpt: 'buy milk', score: 1 }])
    expect((await cli(['search', '#work', '--json'])).json()).toHaveLength(2)
    expect((await cli(['search', 'zebra'])).stdout).toBe('No matches.\n')
  })

  it('reads a note as a document, as text and raw', async () => {
    const run = await cli(['read', 'work/todo.md', '--json'])
    const note = run.json()
    expect(note).toMatchObject({
      id: 'work/todo.md',
      title: 'todo',
      tags: ['work', 'todo'],
      starred: true,
      frontmatter: {
        tags: ['work', 'todo'],
        starred: true,
        priority: 'high',
        status: 'draft',
        created: '2024-01-01T00:00:00.000Z',
      },
      body: TODO.slice(TODO.indexOf('# Todo')),
    })
    expect(note.hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await cli(['read', 'work/todo'])).stdout).toContain(`hash: ${note.hash}\n\n# Todo\n`)
    expect((await cli(['read', 'work/todo.md', '--raw'])).stdout).toBe(TODO)
  })

  it('lists tags, folders and task progress', async () => {
    expect((await cli(['tags', '--json'])).json()).toEqual([
      { tag: 'todo', count: 1 },
      { tag: 'work', count: 2 },
    ])
    const tree = (await cli(['folders', '--json'])).json()
    expect(tree).toMatchObject({ id: '', notes: 1 })
    expect(tree.folders.map((folder: { id: string; notes: number }) => [folder.id, folder.notes])).toEqual([
      ['archive', 0],
      ['personal', 1],
      ['work', 2],
    ])
    expect((await cli(['tasks', 'work/todo.md', '--json'])).json()).toEqual({
      id: 'work/todo.md',
      title: 'todo',
      total: 3,
      completed: 1,
      percent: 33,
    })
    expect((await cli(['tasks', 'index.md'])).stdout).toBe('index.md: no tasks\n')
  })
})

describe('note ids', () => {
  it('accepts a unique bare name and lists the matches of an ambiguous one', async () => {
    expect((await cli(['read', 'plan', '--json'])).json().id).toBe('work/plan.md')
    expect((await cli(['read', 'PLAN', '--json'])).json().id).toBe('work/plan.md')
    const ambiguous = await cli(['read', 'todo'])
    expect(ambiguous.code).toBe(1)
    expect(ambiguous.stderr).toContain('"todo" matches 2 notes: personal/todo.md, work/todo.md')
    const json = await cli(['read', 'todo', '--json'])
    expect(JSON.parse(json.stderr).error).toMatchObject({
      code: 'AMBIGUOUS',
      matches: ['personal/todo.md', 'work/todo.md'],
    })
  })

  it('exits 4 for missing notes and 2 for usage errors', async () => {
    const missing = await cli(['read', 'nothing-here'])
    expect(missing.code).toBe(4)
    expect(missing.stderr).toBe('Error: Note not found: nothing-here\n')
    expect((await cli(['read', '../outside.md'])).code).toBe(4)
    expect((await cli(['frobnicate'])).code).toBe(2)
    expect((await cli(['read'])).code).toBe(2)
    expect((await cli(['read', 'a', '--name', 'x'])).code).toBe(2)
    expect((await cli(['write', 'work/plan.md'])).code).toBe(2)
    expect((await cli([])).code).toBe(2)
    expect((await cli(['--help'])).code).toBe(0)
  })
})

describe('writing', () => {
  it('creates notes from --body or stdin, with tags', async () => {
    const run = await cli(['create', 'work', '--name', 'Meeting notes', '--tag', 'meeting', '--json'], 'Agenda\n')
    expect(run.code).toBe(0)
    const created = run.json()
    expect(created).toEqual({ id: 'work/Meeting notes.md', title: 'Meeting notes', hash: expect.any(String) })
    const raw = await read('work/Meeting notes.md')
    expect(raw).toMatch(/^---\ntags:\n {2}- meeting\ncreated: .+\nupdated: .+\n---\nAgenda\n$/)
    expect((await cli(['create', '/', '--body', 'Root note', '--json'])).json().id).toBe('Untitled.md')
    expect((await cli(['create', 'missing-folder'])).code).toBe(4)
  })

  it('replaces the body keeping the frontmatter, and refuses a stale base hash', async () => {
    const { hash } = (await cli(['read', 'work/todo.md', '--json'])).json()
    const written = await cli(['write', 'work/todo.md', '--base-hash', hash, '--json'], '# Todo\n\nAll done.\n')
    expect(written.code).toBe(0)
    const raw = await read('work/todo.md')
    expect(raw).toContain('priority: high # keep me\n')
    expect(raw.endsWith('---\n# Todo\n\nAll done.\n')).toBe(true)
    expect(written.json().hash).not.toBe(hash)

    const stale = await cli(['write', 'work/todo.md', '--base-hash', hash, '--body', 'overwrite'])
    expect(stale.code).toBe(3)
    expect(stale.stderr).toContain('changed since it was read')
    expect(await read('work/todo.md')).toBe(raw)
    const staleJson = await cli(['append', 'work/todo.md', 'more', '--base-hash', hash, '--json'])
    expect(staleJson.code).toBe(3)
    expect(JSON.parse(staleJson.stderr).error).toMatchObject({ code: 'CONFLICT', currentHash: written.json().hash })
  })

  it('appends text on a line of its own', async () => {
    await put('loose.md', 'no newline at end')
    expect((await cli(['append', 'loose', 'next', 'line'])).code).toBe(0)
    expect(await read('loose.md')).toMatch(/no newline at end\nnext line\n$/)
    expect((await cli(['append', 'loose.md'], '- piped\n')).code).toBe(0)
    expect(await read('loose.md')).toMatch(/next line\n- piped\n$/)
    // Markdown that starts with "-" is text, not an option.
    expect((await cli(['append', 'loose.md', '- [ ] a task', '--json'])).code).toBe(0)
    expect(await read('loose.md')).toMatch(/- piped\n- \[ \] a task\n$/)
    expect((await cli(['write', 'loose.md', '--body', '- only item'])).code).toBe(0)
    expect(await read('loose.md')).toMatch(/---\n- only item$/)
    expect((await cli(['append', 'loose.md'])).code).toBe(2)
    expect((await cli(['append', 'loose.md', '--bogus', 'x'])).stderr).toContain('Unknown option --bogus')
  })

  it('sets and removes properties, leaving untouched YAML as written', async () => {
    const run = await cli([
      'set-props',
      'work/todo.md',
      'tags=work, urgent',
      'starred=false',
      'title=Todo list',
      'effort=3',
      '--unset',
      'status',
      '--json',
    ])
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({
      title: 'Todo list',
      tags: ['work', 'urgent'],
      starred: false,
      frontmatter: { priority: 'high', effort: 3, title: 'Todo list' },
    })
    expect(run.json().frontmatter).not.toHaveProperty('status')
    const raw = await read('work/todo.md')
    expect(raw).toContain('priority: high # keep me\n')
    expect(raw).toContain('effort: 3\n')
    expect(raw).not.toContain('status:')
    expect(raw).toContain('created: 2024-01-01T00:00:00.000Z\n')
    expect(raw.endsWith(TODO.slice(TODO.indexOf('# Todo')))).toBe(true)
    expect((await cli(['set-props', 'work/todo.md', 'starred=maybe'])).code).toBe(2)
    expect((await cli(['set-props', 'work/todo.md'])).code).toBe(2)
    expect((await cli(['set-props', 'work/todo.md', 'novalue'])).code).toBe(2)
  })
})

describe('renaming, moving and the trash', () => {
  it('renames a note and updates links to it by default', async () => {
    const run = await cli(['rename', 'work/todo.md', 'Tasks', '--json'])
    expect(run.code).toBe(0)
    expect(run.json()).toMatchObject({
      id: 'work/Tasks.md',
      previousId: 'work/todo.md',
      linksUpdated: 3,
      notesUpdated: 2,
    })
    expect(await read('index.md')).toContain('[the todo list](work/Tasks.md)')
    expect(await read('work/plan.md')).toContain('[todo](Tasks.md) then [again](./Tasks.md#top)')
    expect((await cli(['rename', 'work/Tasks.md', 'Chores'])).stdout).toContain('Updated 3 link(s) in 2 note(s).')
  })

  it('leaves links alone with --no-update-links and says how many', async () => {
    const run = await cli(['rename', 'work/todo.md', 'Tasks', '--no-update-links', '--json'])
    expect(run.json()).toMatchObject({ id: 'work/Tasks.md', linksUpdated: 0, notesUpdated: 0, linksNotUpdated: 3 })
    expect(await read('index.md')).toBe(FILES['index.md'])
  })

  it('moves a note and updates links to it, unless told not to', async () => {
    const run = await cli(['move', 'work/plan.md', 'archive', '--json'])
    expect(run.json()).toMatchObject({ id: 'archive/plan.md', linksUpdated: 1, notesUpdated: 1 })
    expect(await read('index.md')).toContain('[plan](archive/plan.md)')
    // The moved note's own links are re-based on its new place.
    expect(await read('archive/plan.md')).toContain('[todo](../work/todo.md)')

    const skipped = await cli(['move', 'archive/plan.md', 'personal', '--no-update-links'])
    expect(skipped.stdout).toContain('Links not updated: 1 link(s) still point at archive/plan.md.')
    expect(await read('index.md')).toContain('[plan](archive/plan.md)')
    expect((await cli(['move', 'personal/plan.md', 'nowhere'])).code).toBe(4)
  })

  it('trashes a note and restores it', async () => {
    const trashed = await cli(['trash', 'personal/todo.md', '--json'])
    expect(trashed.code).toBe(0)
    expect(trashed.json()).toEqual({
      trashId: 'personal/todo.md',
      originalPath: 'personal/todo.md',
      deletedAt: expect.any(String),
    })
    await expect(stat(path.join(root, 'personal/todo.md'))).rejects.toThrow()
    expect(await readFile(path.join(root, '.trash/personal/todo.md'), 'utf8')).toBe(FILES['personal/todo.md'])
    // Only one "todo" left, so the bare name is unambiguous now.
    expect((await cli(['read', 'todo', '--json'])).json().id).toBe('work/todo.md')

    const restored = await cli(['restore', 'personal/todo.md', '--json'])
    expect(restored.json()).toEqual({ id: 'personal/todo.md', kind: 'note' })
    expect(await read('personal/todo.md')).toBe(FILES['personal/todo.md'])
    expect((await cli(['restore', 'personal/todo.md'])).code).toBe(4)
  })
})

describe('vault selection', () => {
  it('uses --vault, then BOOSTNOTE_VAULT, then the app’s lastVault', async () => {
    const settings = path.join(root, 'settings.json')
    await writeFile(settings, JSON.stringify({ lastVault: '/from/settings' }))
    expect(resolveVaultDir('/from/flag', { BOOSTNOTE_VAULT: '/from/env' }, settings)).toBe(path.resolve('/from/flag'))
    expect(resolveVaultDir(undefined, { BOOSTNOTE_VAULT: '/from/env' }, settings)).toBe(path.resolve('/from/env'))
    expect(resolveVaultDir(undefined, {}, settings)).toBe(path.resolve('/from/settings'))
    expect(() => resolveVaultDir(undefined, {}, path.join(root, 'missing.json'))).toThrow(/No vault: pass --vault/)
  })

  it('reads BOOSTNOTE_VAULT and reports a missing vault folder', async () => {
    const out: string[] = []
    const io = { stdout: (text: string) => out.push(text), stderr: () => {}, stdin: async () => undefined }
    expect(await runCli(['tags'], { ...io, env: { BOOSTNOTE_VAULT: root } })).toBe(0)
    expect(out.join('')).toContain('#work  2')
    expect(await runCli(['tags'], { ...io, env: { BOOSTNOTE_VAULT: path.join(root, 'nope') } })).toBe(1)
  })
})
