import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createMcpServer, noteUri } from '../../src/cli/mcp.ts'
import { openVault, type Vault } from '../../src/vault/index.ts'

let root: string
let vault: Vault
let client: Client

async function put(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

/** Calls a tool; returns its text and whether it failed. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const [content] = result.content
  return { text: content?.type === 'text' ? content.text : '', isError: result.isError === true }
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON output
async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { text, isError } = await call(name, args)
  expect(isError, text).toBe(false)
  return JSON.parse(text)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'boost-mcp-'))
  await put('work/todo.md', '---\ntags: [work]\nowner: me # keep\n---\n# Todo\n\n- [ ] ship\n')
  await put('ideas/space notes.md', '# Space\n\nRockets and stars.\n')
  vault = await openVault(root)
  const server = createMcpServer(vault)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)
})

afterEach(async () => {
  await client.close()
  await vault.close()
  await rm(root, { recursive: true, force: true })
})

describe('MCP server', () => {
  it('lists the tools with input schemas and tells agents to pass baseHash', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'append_to_note',
      'create_note',
      'list_folders',
      'list_notes',
      'list_tags',
      'move_note',
      'read_note',
      'rename_note',
      'restore_note',
      'search_notes',
      'task_progress',
      'trash_note',
      'update_properties',
      'write_note',
    ])
    const write = tools.find((tool) => tool.name === 'write_note')
    expect(write?.description).toMatch(/Read the note first and pass its hash as baseHash/)
    expect(write?.inputSchema.required).toEqual(['id', 'body'])
    expect(Object.keys(write?.inputSchema.properties ?? {})).toEqual(['id', 'body', 'baseHash'])
    expect(client.getInstructions()).toMatch(/read_note before changing a note/)
  })

  it('searches, reads, writes with baseHash and creates notes', async () => {
    expect(await callJson('search_notes', { query: 'rockets' })).toEqual([
      { id: 'ideas/space notes.md', title: 'space notes', excerpt: 'Rockets and stars.', score: 1 },
    ])
    const note = await callJson('read_note', { id: 'todo' })
    expect(note).toMatchObject({
      id: 'work/todo.md',
      tags: ['work'],
      frontmatter: { owner: 'me' },
      body: '# Todo\n\n- [ ] ship\n',
    })

    const written = await callJson('write_note', { id: note.id, body: '# Todo\n\n- [x] ship\n', baseHash: note.hash })
    expect(written).toEqual({ id: 'work/todo.md', title: 'todo', hash: expect.any(String) })
    const raw = await readFile(path.join(root, 'work/todo.md'), 'utf8')
    expect(raw).toContain('owner: me # keep\n')
    expect(raw.endsWith('---\n# Todo\n\n- [x] ship\n')).toBe(true)
    expect(await callJson('task_progress', { id: 'work/todo.md' })).toMatchObject({
      total: 1,
      completed: 1,
      percent: 100,
    })

    const created = await callJson('create_note', {
      folder: 'ideas',
      name: 'Moon',
      body: 'Craters.\n',
      tags: ['space'],
    })
    expect(created.id).toBe('ideas/Moon.md')
    expect((await callJson('list_notes', { tag: 'space' })).map((meta: { id: string }) => meta.id)).toEqual([
      'ideas/Moon.md',
    ])
  })

  it('reports a conflict when baseHash is stale, without writing', async () => {
    const note = await callJson('read_note', { id: 'work/todo.md' })
    // Someone else (the app, an editor) changes the note after the agent read it.
    await put('work/todo.md', '# Todo\n\nedited elsewhere\n')
    const result = await call('write_note', { id: 'work/todo.md', body: 'agent version', baseHash: note.hash })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^CONFLICT: Note changed since it was read: work\/todo\.md/)
    expect(await readFile(path.join(root, 'work/todo.md'), 'utf8')).toBe('# Todo\n\nedited elsewhere\n')
    const current = await callJson('read_note', { id: 'work/todo.md' })
    expect(result.text).toContain(current.hash)
    expect(
      (await call('update_properties', { id: 'work/todo.md', set: { starred: true }, baseHash: note.hash })).isError,
    ).toBe(true)
  })

  it('sees files changed outside the server and reports missing notes', async () => {
    await put('later.md', '# Later\n\nadded by hand\n')
    expect((await callJson('search_notes', { query: 'hand' })).map((hit: { id: string }) => hit.id)).toEqual([
      'later.md',
    ])
    const missing = await call('read_note', { id: 'nope' })
    expect(missing).toEqual({ isError: true, text: 'NOT_FOUND: Note not found: nope' })
  })

  it('updates properties, moves, trashes and restores', async () => {
    const updated = await callJson('update_properties', {
      id: 'work/todo.md',
      set: { starred: true },
      remove: ['tags'],
    })
    expect(updated).toMatchObject({ starred: true, tags: [], frontmatter: { owner: 'me', starred: true } })
    expect(await callJson('move_note', { id: 'work/todo.md', folder: 'ideas' })).toMatchObject({
      id: 'ideas/todo.md',
      linksUpdated: 0,
    })
    const trashed = await callJson('trash_note', { id: 'ideas/todo.md' })
    expect(await callJson('restore_note', { trashId: trashed.trashId })).toEqual({ id: 'ideas/todo.md', kind: 'note' })
    expect(await callJson('list_tags')).toEqual([])
    expect((await callJson('list_folders')).folders.map((folder: { id: string }) => folder.id)).toEqual([
      'ideas',
      'work',
    ])
  })

  it('exposes notes as resources', async () => {
    const { resources } = await client.listResources()
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'boostnote://note/ideas/space%20notes.md',
      'boostnote://note/work/todo.md',
    ])
    const { contents } = await client.readResource({ uri: noteUri('ideas/space notes.md') })
    expect(contents).toEqual([
      {
        uri: 'boostnote://note/ideas/space%20notes.md',
        mimeType: 'text/markdown',
        text: '# Space\n\nRockets and stars.\n',
      },
    ])
  })
})
