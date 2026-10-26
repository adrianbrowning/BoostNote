/**
 * `boostnote mcp`: an MCP server (stdio) exposing the command layer to AI agents. Tools mirror the
 * CLI commands and return the same JSON as `boostnote --json`; notes are also resources
 * (`boostnote://note/<id>`). Nothing is ever deleted for good: trashing moves notes to `.trash/`.
 * stdout carries the protocol, so the server logs to stderr only.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { Vault } from '../vault/index.ts'
import {
  appendToNote,
  createNote,
  folderTree,
  listNotes,
  listTags,
  moveNote,
  noteTasks,
  readNote,
  readRaw,
  renameNote,
  restoreFromTrash,
  SORT_KEYS,
  searchNotes,
  toCommandError,
  trashNote,
  updateProperties,
  writeNote,
} from './commands.ts'

const VERSION = '1.0.0'
const NOTE_URI = 'boostnote://note/'

const INSTRUCTIONS = `Boostnote vault: a folder of markdown notes with YAML frontmatter properties.
Note ids are paths relative to the vault (e.g. "work/todo.md"); a bare name ("todo") works when unique.
Always read_note before changing a note and pass the "hash" it returned as "baseHash" to write_note,
append_to_note or update_properties. A CONFLICT error means the note changed since your read (the user
may be editing it in the app): read it again, reapply your change, and retry with the new hash.
Deleting is not possible; trash_note moves a note to the vault trash and restore_note brings it back.`

const id = z.string().describe('Note id (vault-relative path such as "work/todo.md") or a unique bare note name')
const baseHash = z
  .string()
  .optional()
  .describe(
    'The "hash" from your last read_note of this note. The change fails with CONFLICT if the note changed since.',
  )
const updateLinks = z.boolean().optional().describe('Rewrite links to this note in other notes (default true)')

/** Encodes a note id as a resource URI, segment by segment so `/` stays a separator. */
export function noteUri(noteId: string): string {
  return NOTE_URI + noteId.split('/').map(encodeURIComponent).join('/')
}

/** Builds the server over an open vault; the caller connects a transport. */
export function createMcpServer(vault: Vault): McpServer {
  const server = new McpServer({ name: 'boostnote', version: VERSION }, { instructions: INSTRUCTIONS })

  /** Rescans the vault (the app, git or the user may have changed it), runs `operation`, reports JSON or the error. */
  const respond = async (operation: () => unknown): Promise<CallToolResult> => {
    try {
      await vault.refresh()
      return { content: [{ type: 'text', text: JSON.stringify(await operation(), null, 2) }] }
    } catch (caught) {
      const error = toCommandError(caught)
      const details = error.details ? `\n${JSON.stringify(error.details)}` : ''
      return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${details}` }] }
    }
  }
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const
  const additive = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List notes (id, title, folder, tags, starred, created, updated, excerpt), newest first by default. Filter by folder, tag or starred.',
      inputSchema: {
        folder: z.string().optional().describe('Folder id ("" for the vault root)'),
        recursive: z.boolean().optional().describe('Include notes in subfolders of "folder"'),
        tag: z.string().optional(),
        starred: z.boolean().optional(),
        sort: z.enum(SORT_KEYS).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: readOnly,
    },
    (args) => respond(() => listNotes(vault, args)),
  )

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search over titles, tags and bodies; every word must match, "#tag" matches tags only. Returns id, title, excerpt and score, best first.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().optional() },
      annotations: readOnly,
    },
    ({ query, limit }) => respond(() => searchNotes(vault, query, limit)),
  )

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description:
        'Read a note: title, tags, starred, dates, frontmatter, body and hash. Pass the hash as baseHash to your next change of this note. raw: true returns the whole file as stored instead.',
      inputSchema: { id, raw: z.boolean().optional() },
      annotations: readOnly,
    },
    ({ id, raw }) => respond(async () => (raw ? { raw: await readRaw(vault, id) } : readNote(vault, id))),
  )

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a note in an existing folder. "name" becomes the file name (suffixed when taken). Returns its id and hash.',
      inputSchema: {
        folder: z.string().describe('Existing folder id ("" for the vault root)'),
        name: z.string().optional().describe('Note name (file name without .md); default "Untitled"'),
        body: z.string().optional().describe('Markdown body, without frontmatter'),
        tags: z.array(z.string()).optional(),
      },
      annotations: additive,
    },
    ({ folder, ...options }) => respond(() => createNote(vault, folder, options)),
  )

  server.registerTool(
    'write_note',
    {
      title: 'Replace a note body',
      description:
        'Replace the markdown body of a note; its frontmatter properties are kept. Read the note first and pass its hash as baseHash so a concurrent edit is never overwritten.',
      inputSchema: { id, body: z.string(), baseHash },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ id, body, baseHash }) => respond(() => writeNote(vault, id, body, baseHash)),
  )

  server.registerTool(
    'append_to_note',
    {
      title: 'Append to a note',
      description: 'Add text at the end of a note body, on a line of its own. Returns the new hash.',
      inputSchema: { id, text: z.string().min(1), baseHash },
      annotations: additive,
    },
    ({ id, text, baseHash }) => respond(() => appendToNote(vault, id, text, baseHash)),
  )

  server.registerTool(
    'update_properties',
    {
      title: 'Update note properties',
      description:
        'Set or remove frontmatter properties: tags (list of strings), starred (boolean), title (string) or any other key. Properties not named are left exactly as written. Returns the updated note.',
      inputSchema: {
        id,
        set: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Properties to set, e.g. {"tags": ["a"], "starred": true}'),
        remove: z.array(z.string()).optional().describe('Property names to remove'),
        baseHash,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, set, remove, baseHash }) => respond(() => updateProperties(vault, id, { set, remove }, baseHash)),
  )

  server.registerTool(
    'rename_note',
    {
      title: 'Rename a note',
      description:
        "Rename a note's file (its name); its assets follow and links to it in other notes are updated unless updateLinks is false. Reports how many links changed.",
      inputSchema: { id, name: z.string().min(1).describe('New name, without .md'), updateLinks },
      annotations: additive,
    },
    ({ id, name, updateLinks }) => respond(() => renameNote(vault, id, name, { updateLinks })),
  )

  server.registerTool(
    'move_note',
    {
      title: 'Move a note',
      description:
        'Move a note into another existing folder; links to it in other notes are updated unless updateLinks is false. Reports how many links changed.',
      inputSchema: { id, folder: z.string().describe('Existing folder id ("" for the vault root)'), updateLinks },
      annotations: additive,
    },
    ({ id, folder, updateLinks }) => respond(() => moveNote(vault, id, folder, { updateLinks })),
  )

  server.registerTool(
    'trash_note',
    {
      title: 'Move a note to the trash',
      description: "Move a note to the vault's trash (not deleted). Returns the trashId restore_note takes.",
      inputSchema: { id },
      annotations: additive,
    },
    ({ id }) => respond(() => trashNote(vault, id)),
  )

  server.registerTool(
    'restore_note',
    {
      title: 'Restore from the trash',
      description: 'Put a trashed note back at its original place (suffixed when taken). Returns its id.',
      inputSchema: { trashId: z.string().min(1) },
      annotations: additive,
    },
    ({ trashId }) => respond(() => restoreFromTrash(vault, trashId)),
  )

  server.registerTool(
    'list_tags',
    { title: 'List tags', description: 'All tags with their note counts.', annotations: readOnly },
    () => respond(() => listTags(vault)),
  )

  server.registerTool(
    'list_folders',
    { title: 'Folder tree', description: 'The folder tree with note counts per folder.', annotations: readOnly },
    () => respond(() => folderTree(vault)),
  )

  server.registerTool(
    'task_progress',
    {
      title: 'Task progress',
      description: 'Task list progress of a note: total, completed and percent of "- [ ]" / "- [x]" items.',
      inputSchema: { id },
      annotations: readOnly,
    },
    ({ id }) => respond(() => noteTasks(vault, id)),
  )

  server.registerResource(
    'note',
    new ResourceTemplate(`${NOTE_URI}{+id}`, {
      list: async () => {
        await vault.refresh()
        return {
          resources: vault.index.all().map((meta) => ({
            uri: noteUri(meta.id),
            name: meta.id,
            title: meta.title,
            mimeType: 'text/markdown',
          })),
        }
      },
    }),
    { title: 'Boostnote note', description: 'A note file (markdown with YAML frontmatter)', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const encoded = Array.isArray(variables.id) ? variables.id.join('/') : (variables.id ?? '')
      await vault.refresh()
      const raw = await readRaw(vault, encoded.split('/').map(decodeURIComponent).join('/')).catch((caught) => {
        const error = toCommandError(caught)
        throw new Error(`${error.code}: ${error.message}`)
      })
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: raw }] }
    },
  )

  return server
}

/** Serves `vault` on stdin/stdout until stdin closes. */
export async function serveMcp(vault: Vault): Promise<void> {
  const server = createMcpServer(vault)
  const transport = new StdioServerTransport()
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  transport.onclose = resolve
  process.stdin.once('end', () => void server.close())
  await server.connect(transport)
  console.error(`[boostnote mcp] serving vault ${vault.root}`)
  await closed
  await vault.close()
}
