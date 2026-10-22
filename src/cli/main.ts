/**
 * `boostnote <command>`: the command line over a vault. Parses arguments, runs one operation of
 * src/cli/commands.ts and prints it for people (default) or as JSON (`--json`). `boostnote mcp`
 * serves the same operations to MCP clients over stdio instead.
 */
import { fstatSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import type { NoteMeta, Vault } from '../vault/index.ts'
import { openVault } from '../vault/index.ts'
import {
  appendToNote,
  CommandError,
  createNote,
  EXIT_CODES,
  exitCodeOf,
  type FolderTree,
  folderTree,
  listNotes,
  listTags,
  moveNote,
  type NoteDocument,
  noteTasks,
  type RelocateResult,
  readNote,
  readRaw,
  renameNote,
  restoreFromTrash,
  SORT_KEYS,
  type SortKey,
  searchNotes,
  toCommandError,
  trashNote,
  updateProperties,
  writeNote,
} from './commands.ts'
import { serveMcp } from './mcp.ts'
import { resolveVaultDir } from './vault-dir.ts'

export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
  /** Piped input, or `undefined` when nothing is piped (a terminal). */
  stdin(): Promise<string | undefined>
  env: NodeJS.ProcessEnv
}

type Values = Record<string, string | boolean | string[] | undefined>

interface ParsedArgs {
  command: string | undefined
  args: string[]
  values: Values
}

interface Output {
  data: unknown
  text: string
}

interface Context {
  args: string[]
  values: Values
  io: CliIo
}

interface CommandSpec {
  usage: string
  summary: string
  /** Allowed command options (besides the global ones). */
  options: readonly string[]
  /** Positional argument count range. */
  args: [min: number, max: number]
}

interface OptionSpec {
  type: 'string' | 'boolean'
  /** May be given several times (collected into a list). */
  multiple?: boolean
}

const OPTIONS: Record<string, OptionSpec> = {
  vault: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
  folder: { type: 'string' },
  recursive: { type: 'boolean' },
  tag: { type: 'string', multiple: true },
  starred: { type: 'boolean' },
  sort: { type: 'string' },
  limit: { type: 'string' },
  raw: { type: 'boolean' },
  name: { type: 'string' },
  body: { type: 'string' },
  'base-hash': { type: 'string' },
  unset: { type: 'string', multiple: true },
  'no-update-links': { type: 'boolean' },
}

const GLOBAL_OPTIONS = ['vault', 'json', 'help']

const COMMANDS: Record<string, CommandSpec> = {
  list: {
    usage:
      'list [--folder <id>] [--recursive] [--tag <tag>] [--starred] [--sort updated|created|title|id] [--limit <n>]',
    summary: 'List notes (newest first).',
    options: ['folder', 'recursive', 'tag', 'starred', 'sort', 'limit'],
    args: [0, 0],
  },
  search: {
    usage: 'search <query> [--limit <n>]',
    summary: 'Full-text search (title, tags, body); `#tag` matches tags only.',
    options: ['limit'],
    args: [1, Number.POSITIVE_INFINITY],
  },
  read: {
    usage: 'read <id> [--raw]',
    summary: 'Show a note: properties, hash and body (--raw: the file as stored).',
    options: ['raw'],
    args: [1, 1],
  },
  create: {
    usage: 'create <folder> [--name <name>] [--body <text> | < file] [--tag <tag>]...',
    summary: 'Create a note in an existing folder ("" or / for the vault root).',
    options: ['name', 'body', 'tag'],
    args: [1, 1],
  },
  write: {
    usage: 'write <id> (--body <text> | < file) [--base-hash <hash>]',
    summary: 'Replace the body, keeping the properties. With --base-hash, fails (exit 3) if the note changed.',
    options: ['body', 'base-hash'],
    args: [1, 1],
  },
  append: {
    usage: 'append <id> (<text> | < file) [--base-hash <hash>]',
    summary: 'Add text to the end of the body, on its own line.',
    options: ['base-hash'],
    args: [1, Number.POSITIVE_INFINITY],
  },
  'set-props': {
    usage: 'set-props <id> [key=value]... [--unset <key>]... [--base-hash <hash>]',
    summary: 'Set/remove properties. tags=a,b  starred=true  title=Text  other=<YAML value>.',
    options: ['unset', 'base-hash'],
    args: [1, Number.POSITIVE_INFINITY],
  },
  rename: {
    usage: 'rename <id> <name> [--no-update-links]',
    summary: "Rename a note's file; links to it in other notes are updated.",
    options: ['no-update-links'],
    args: [2, 2],
  },
  move: {
    usage: 'move <id> <folder> [--no-update-links]',
    summary: 'Move a note into another folder; links to it in other notes are updated.',
    options: ['no-update-links'],
    args: [2, 2],
  },
  trash: {
    usage: 'trash <id>',
    summary: "Move a note to the vault's trash (restorable).",
    options: [],
    args: [1, 1],
  },
  restore: {
    usage: 'restore <trashId>',
    summary: 'Put a trashed note back.',
    options: [],
    args: [1, 1],
  },
  tags: { usage: 'tags', summary: 'List tags with note counts.', options: [], args: [0, 0] },
  folders: { usage: 'folders', summary: 'Show the folder tree with note counts.', options: [], args: [0, 0] },
  tasks: { usage: 'tasks <id>', summary: 'Task list progress of a note.', options: [], args: [1, 1] },
  mcp: {
    usage: 'mcp',
    summary: 'Run an MCP server on stdio exposing these operations to AI agents.',
    options: [],
    args: [0, 0],
  },
}

const USAGE = `Usage: boostnote [--vault <dir>] [--json] <command> [args]

Works on a Boostnote vault (a folder of markdown notes). The vault is --vault, else
$BOOSTNOTE_VAULT, else the vault last opened in the app. Note ids are paths relative to the
vault (work/todo.md); a bare name (todo) works when only one note has it.

Commands:
${Object.values(COMMANDS)
  .map((spec) => `  ${spec.usage}\n      ${spec.summary}`)
  .join('\n')}

Options:
  --vault <dir>   vault folder
  --json          print machine-readable JSON
  -h, --help      show this help

Exit codes: 0 ok, 1 error, 2 usage, 3 conflict (note changed), 4 not found.`

/** Runs one command line; returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parse(argv)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun "boostnote --help" for usage.\n`)
    return EXIT_CODES.usage
  }
  const { command, args, values } = parsed
  if (values.help || command === undefined) {
    ;(command === undefined && !values.help ? io.stderr : io.stdout)(`${USAGE}\n`)
    return command === undefined && !values.help ? EXIT_CODES.usage : EXIT_CODES.ok
  }
  const json = values.json === true
  try {
    const vault = await openVault(resolveVaultDir(values.vault as string | undefined, io.env)).catch((error) => {
      throw toCommandError(error)
    })
    if (command === 'mcp') {
      await serveMcp(vault)
      return EXIT_CODES.ok
    }
    try {
      const output = await run(command, { args, values, io }, vault)
      io.stdout(
        json
          ? `${JSON.stringify(output.data, null, 2)}\n`
          : output.text.endsWith('\n')
            ? output.text
            : `${output.text}\n`,
      )
      return EXIT_CODES.ok
    } finally {
      await vault.close()
    }
  } catch (caught) {
    const error = toCommandError(caught)
    if (json) {
      io.stderr(
        `${JSON.stringify({ error: { code: error.code, message: error.message, ...error.details } }, null, 2)}\n`,
      )
    } else {
      io.stderr(`Error: ${error.message}\n`)
      if (error.code === 'USAGE') io.stderr(`Usage: boostnote ${COMMANDS[command]?.usage ?? ''}\n`)
    }
    return exitCodeOf(error)
  }
}

/**
 * Splits argv into the command, its arguments and options. Only `--name`, `--name=value` and `-h`
 * are options, so markdown such as `- [ ] task` stays an argument, and a string option takes the
 * next argument whatever it starts with. `--` ends the options.
 */
function parse(argv: string[]): ParsedArgs {
  const values: Values = {}
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    const match =
      arg === '-h'
        ? { name: 'help', value: undefined }
        : /^--(?<name>[a-z][a-z-]*)(?:=(?<value>[\s\S]*))?$/.exec(arg)?.groups
    if (!match?.name) {
      positionals.push(arg)
      continue
    }
    const { name } = match
    const option = OPTIONS[name]
    if (!option) throw new Error(`Unknown option --${name}`)
    if (option.type === 'boolean') {
      if (match.value !== undefined) throw new Error(`--${name} takes no value`)
      values[name] = true
      continue
    }
    const value = match.value ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    const previous = values[name]
    values[name] = option.multiple ? [...(Array.isArray(previous) ? previous : []), value] : value
  }
  const [command, ...args] = positionals
  if (command === undefined) return { command, args, values }
  const spec = COMMANDS[command]
  if (!spec) throw new Error(`Unknown command: ${command}`)
  for (const name of Object.keys(values)) {
    if (!GLOBAL_OPTIONS.includes(name) && !spec.options.includes(name)) {
      throw new Error(`Option --${name} does not apply to "${command}"`)
    }
  }
  if (!values.help && (args.length < spec.args[0] || args.length > spec.args[1])) {
    throw new Error(`Wrong number of arguments for "${command}". Usage: boostnote ${spec.usage}`)
  }
  return { command, args, values }
}

async function run(command: string, context: Context, vault: Vault): Promise<Output> {
  const { args, values, io } = context
  const [first = '', second = ''] = args
  const baseHash = values['base-hash'] as string | undefined
  const updateLinks = values['no-update-links'] !== true
  switch (command) {
    case 'list': {
      const sort = values.sort as string | undefined
      if (sort !== undefined && !SORT_KEYS.includes(sort as SortKey)) {
        throw new CommandError('USAGE', `--sort must be one of ${SORT_KEYS.join(', ')}`)
      }
      const tags = values.tag as string[] | undefined
      if (tags && tags.length > 1) throw new CommandError('USAGE', 'list takes one --tag')
      const notes = listNotes(vault, {
        folder: values.folder as string | undefined,
        recursive: values.recursive === true,
        tag: tags?.[0],
        starred: values.starred === true,
        sort: sort as SortKey | undefined,
        limit: optionalNumber(values.limit),
      })
      return { data: notes, text: notes.length === 0 ? 'No notes.' : notes.map(noteLine).join('\n') }
    }
    case 'search': {
      const hits = searchNotes(vault, args.join(' '), optionalNumber(values.limit))
      const text = hits
        .map((hit) => `${hit.id} — ${hit.title}  (score ${hit.score})${hit.excerpt ? `\n    ${hit.excerpt}` : ''}`)
        .join('\n')
      return { data: hits, text: hits.length === 0 ? 'No matches.' : text }
    }
    case 'read': {
      if (values.raw) {
        const raw = await readRaw(vault, first)
        return { data: { raw }, text: raw }
      }
      const note = await readNote(vault, first)
      return {
        data: note,
        text: `${note.title}\nid: ${note.id}\n${propertiesText(note)}\nhash: ${note.hash}\n\n${note.body}`,
      }
    }
    case 'create': {
      const body = (values.body as string | undefined) ?? (await io.stdin())
      const note = await createNote(vault, first, {
        name: values.name as string | undefined,
        body,
        tags: values.tag as string[] | undefined,
      })
      return { data: note, text: `Created ${note.id}\nhash: ${note.hash}` }
    }
    case 'write': {
      const body = (values.body as string | undefined) ?? (await io.stdin())
      if (body === undefined) throw new CommandError('USAGE', 'Pass the new body with --body or on stdin')
      const note = await writeNote(vault, first, body, baseHash)
      return { data: note, text: `Wrote ${note.id}\nhash: ${note.hash}` }
    }
    case 'append': {
      const text = args.length > 1 ? args.slice(1).join(' ') : await io.stdin()
      if (text === undefined || text === '')
        throw new CommandError('USAGE', 'Pass the text to append or pipe it on stdin')
      const note = await appendToNote(vault, first, text, baseHash)
      return { data: note, text: `Appended to ${note.id}\nhash: ${note.hash}` }
    }
    case 'set-props': {
      const set: Record<string, unknown> = {}
      for (const pair of args.slice(1)) {
        const equals = pair.indexOf('=')
        if (equals <= 0) throw new CommandError('USAGE', `Expected key=value, got "${pair}"`)
        const key = pair.slice(0, equals).trim()
        set[key] = propertyValue(key, pair.slice(equals + 1))
      }
      const note = await updateProperties(
        vault,
        first,
        { set, remove: (values.unset as string[] | undefined) ?? [] },
        baseHash,
      )
      return { data: note, text: `Updated ${note.id}\n${propertiesText(note)}\nhash: ${note.hash}` }
    }
    case 'rename': {
      const result = await renameNote(vault, first, second, { updateLinks })
      return { data: result, text: relocateText('Renamed', result) }
    }
    case 'move': {
      const result = await moveNote(vault, first, second, { updateLinks })
      return { data: result, text: relocateText('Moved', result) }
    }
    case 'trash': {
      const result = await trashNote(vault, first)
      return {
        data: result,
        text: `Moved ${result.originalPath} to the trash.\nRestore with: boostnote restore ${quoteArg(result.trashId)}`,
      }
    }
    case 'restore': {
      const result = await restoreFromTrash(vault, first)
      return { data: result, text: `Restored ${result.kind} ${result.id}` }
    }
    case 'tags': {
      const tags = listTags(vault)
      return { data: tags, text: tags.length === 0 ? 'No tags.' : tags.map((t) => `#${t.tag}  ${t.count}`).join('\n') }
    }
    case 'folders': {
      const tree = folderTree(vault)
      return { data: tree, text: treeText(tree) }
    }
    case 'tasks': {
      const tasks = await noteTasks(vault, first)
      const text =
        tasks.total === 0
          ? `${tasks.id}: no tasks`
          : `${tasks.id}: ${tasks.completed}/${tasks.total} done (${tasks.percent}%)`
      return { data: tasks, text }
    }
    default:
      throw new CommandError('USAGE', `Unknown command: ${command}`)
  }
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────

function optionalNumber(value: Values[string]): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) throw new CommandError('USAGE', `Not a whole number: ${value}`)
  return number
}

/** `tags` is a comma-separated list, `title` text as typed, `starred` true/false, anything else a YAML value. */
function propertyValue(key: string, text: string): unknown {
  if (key === 'tags') {
    return text
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  }
  if (key === 'title') return text
  if (key === 'starred') {
    if (text !== 'true' && text !== 'false') throw new CommandError('USAGE', 'starred must be true or false')
    return text === 'true'
  }
  try {
    return parseYaml(text) ?? text
  } catch {
    return text
  }
}

// ── Text output ──────────────────────────────────────────────────────────────────────────────

function noteLine(meta: NoteMeta): string {
  const tags = meta.tags.length > 0 ? `  ${meta.tags.map((tag) => `#${tag}`).join(' ')}` : ''
  return `${meta.starred ? '★ ' : ''}${meta.id} — ${meta.title}${tags}  (${meta.updated.slice(0, 10)})`
}

function propertiesText(note: NoteDocument): string {
  const entries = Object.entries(note.frontmatter)
  if (entries.length === 0) return 'properties: (none)'
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
}

function relocateText(verb: string, result: RelocateResult): string {
  const links =
    result.linksNotUpdated !== undefined
      ? `Links not updated: ${result.linksNotUpdated} link(s) still point at ${result.previousId}.`
      : `Updated ${result.linksUpdated} link(s) in ${result.notesUpdated} note(s).`
  return `${verb} ${result.previousId} → ${result.id}\n${links}\nhash: ${result.hash}`
}

function treeText(tree: FolderTree): string {
  const lines = [`${tree.name}/  (${tree.notes} notes)`]
  const walk = (node: FolderTree, depth: number) => {
    for (const child of node.folders) {
      lines.push(`${'  '.repeat(depth)}${child.name}/  (${child.notes})`)
      walk(child, depth + 1)
    }
  }
  walk(tree, 1)
  return lines.join('\n')
}

function quoteArg(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

// ── Process ──────────────────────────────────────────────────────────────────────────────────

/** Reads stdin only when something is piped or redirected in (never waits on a terminal or an idle inherited pipe-less stdin). */
async function readProcessStdin(): Promise<string | undefined> {
  let piped = false
  try {
    const stats = fstatSync(0)
    piped = stats.isFIFO() || stats.isFile()
  } catch {
    return undefined
  }
  if (!piped) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readProcessStdin,
  env: process.env,
}
