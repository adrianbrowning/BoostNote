import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { ChangeSet, EditorSelection, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { setEditorFocused } from './live-preview/selection.ts'
import { imageMarkdown, insertSavedImages, trackInsertion } from './paste.ts'

/** A block the slash menu inserts. `cursor` is the offset inside `text` where the cursor lands. */
export interface BlockTemplate {
  text: string
  cursor: number
}

/** The local date/time format an inline command inserts at the `/query`. */
export type DateTimeFormat = 'date' | 'time' | 'datetime'

/** An inline command: its text replaces only the `/query`, computed when the command runs. */
interface InlineCommand {
  inline: DateTimeFormat
}

export interface SlashCommand {
  id: string
  label: string
  keywords: string
  /** Fixed template, an inline date/time command, `'table'` for the size grid or `'image'` for the file picker. */
  template: BlockTemplate | InlineCommand | 'table' | 'image'
}

const template = (text: string, cursor = text.length): BlockTemplate => ({ text, cursor })

/**
 * A GFM table of `columns` columns and `rows` empty body rows, under a `Column 1…N` header and a `---`
 * separator; the cursor lands in the first header cell.
 */
export function tableTemplate(columns: number, rows: number): BlockTemplate {
  const row = (cell: (index: number) => string) =>
    `|${Array.from({ length: columns }, (_, index) => ` ${cell(index)} |`).join('')}`
  const body = Array.from({ length: rows }, () => row(() => ''))
  return template([row((index) => `Column ${index + 1}`), row(() => '---'), ...body].join('\n'), 2)
}

const MERMAID_STARTER =
  '```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```'

export const slashCommands: readonly SlashCommand[] = [
  { id: 'h1', label: 'Heading 1', keywords: 'heading title h1', template: template('# ') },
  { id: 'h2', label: 'Heading 2', keywords: 'heading subtitle h2', template: template('## ') },
  { id: 'h3', label: 'Heading 3', keywords: 'heading h3', template: template('### ') },
  { id: 'bullet', label: 'Bulleted list', keywords: 'bullet list unordered ul', template: template('- ') },
  { id: 'numbered', label: 'Numbered list', keywords: 'numbered ordered list ol', template: template('1. ') },
  { id: 'task', label: 'Task list', keywords: 'task todo checkbox check list', template: template('- [ ] ') },
  { id: 'quote', label: 'Quote', keywords: 'quote blockquote citation', template: template('> ') },
  { id: 'code', label: 'Code block', keywords: 'code fence snippet', template: template('```\n\n```', 4) },
  {
    id: 'mermaid',
    label: 'Mermaid diagram',
    keywords: 'mermaid diagram flowchart chart graph',
    template: template(MERMAID_STARTER, '```mermaid\n'.length),
  },
  { id: 'math', label: 'Math block', keywords: 'math latex katex equation formula', template: template('$$\n\n$$', 3) },
  { id: 'table', label: 'Table', keywords: 'table grid', template: 'table' },
  {
    id: 'divider',
    label: 'Divider',
    keywords: 'divider horizontal rule hr line separator',
    template: template('---\n'),
  },
  { id: 'date', label: 'Date', keywords: 'date today day', template: { inline: 'date' } },
  { id: 'time', label: 'Time', keywords: 'time now clock', template: { inline: 'time' } },
  {
    id: 'datetime',
    label: 'Date and time',
    keywords: 'datetime timestamp now date time',
    template: { inline: 'datetime' },
  },
  { id: 'image', label: 'Image', keywords: 'image picture photo upload file', template: 'image' },
]

/** Commands whose label, id or keywords contain every word of `query`. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return slashCommands.filter((command) => {
    const haystack = `${command.id} ${command.label} ${command.keywords}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `now` in local time as `YYYY-MM-DD`, `HH:mm` or `YYYY-MM-DD HH:mm` (24-hour, zero-padded). */
export function formatSlashDateTime(format: DateTimeFormat, now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return format === 'date' ? date : format === 'time' ? time : `${date} ${time}`
}

/** The transaction for an inline command: `text` replaces the `/query` at `[from, to)`, cursor after it. */
export function slashInlineTransaction(_state: EditorState, from: number, to: number, text: string): TransactionSpec {
  return {
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    scrollIntoView: true,
    userEvent: 'input.slash',
  }
}

const NO_SLASH_NODES: Record<string, true> = {
  FencedCode: true,
  CodeBlock: true,
  InlineCode: true,
  BlockMath: true,
  InlineMath: true,
  HTMLBlock: true,
  Link: true,
  URL: true,
}

/**
 * The transaction for running a slash command whose `/query` text spans `[from, to)` (Hubble semantics):
 * if the rest of the line is empty, the line becomes the block; otherwise the `/query` is removed and the
 * block is inserted as a new block after the current top-level block.
 */
export function slashCommandTransaction(
  state: EditorState,
  from: number,
  to: number,
  block: BlockTemplate,
): TransactionSpec {
  const line = state.doc.lineAt(from)
  const rest = state.sliceDoc(line.from, from) + state.sliceDoc(to, line.to)
  if (rest.trim() === '') {
    return {
      changes: { from: line.from, to: line.to, insert: block.text },
      selection: EditorSelection.cursor(line.from + block.cursor),
      scrollIntoView: true,
      userEvent: 'input.slash',
    }
  }

  const removal = ChangeSet.of({ from, to }, state.doc.length)
  const afterRemoval = state.update({ changes: removal }).state
  const pos = removal.mapPos(from)
  let blockEnd = afterRemoval.doc.lineAt(pos).to
  for (let node = syntaxTree(afterRemoval).resolve(pos, 1); node.parent; node = node.parent) {
    if (node.parent.name === 'Document') {
      blockEnd = Math.max(blockEnd, afterRemoval.doc.lineAt(node.to).to)
      break
    }
  }
  const nextLine = blockEnd < afterRemoval.doc.length ? afterRemoval.doc.lineAt(blockEnd + 1) : undefined
  const suffix = nextLine && nextLine.text.trim() !== '' ? '\n' : ''
  const insert = `\n\n${block.text}${suffix}`
  const insertion = ChangeSet.of({ from: blockEnd, insert }, afterRemoval.doc.length)
  return {
    changes: removal.compose(insertion),
    selection: EditorSelection.cursor(blockEnd + 2 + block.cursor),
    scrollIntoView: true,
    userEvent: 'input.slash',
  }
}

function pickImage(): Promise<File | undefined> {
  const { promise, resolve } = Promise.withResolvers<File | undefined>()
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => resolve(input.files?.[0]), { once: true })
  input.addEventListener('cancel', () => resolve(undefined), { once: true })
  input.click()
  return promise
}

async function runImageCommand(view: EditorView, from: number, to: number): Promise<void> {
  // Remove the `/query` first; the picker is asynchronous and the user may keep typing meanwhile, or switch notes.
  // While the editor is read-only (a transition holds the note) the save and insert wait for it to be editable.
  view.dispatch({ changes: { from, to }, userEvent: 'input.slash' })
  const target = trackInsertion(view, from)
  try {
    const file = await pickImage()
    if (!file) return
    await insertSavedImages(view, target, [file], (at, [path = '']) =>
      view.dispatch(slashCommandTransaction(view.state, at, at, template(imageMarkdown(file.name, path)))),
    )
  } finally {
    target.done()
  }
}

interface TableSize {
  columns: number
  rows: number
}

/** The size grid's limit, in columns and in body rows. */
const MAX_TABLE_SIZE = 10

/**
 * Opens the table size grid at `pos` and focuses it: hover or arrows (clamped at 1 and `MAX_TABLE_SIZE`) move the
 * highlight, click or Enter picks that size. Resolves with the size, or `undefined` on Esc or once the grid loses
 * focus. Picking and Esc return focus to the editor; focus moved elsewhere stays there.
 */
function pickTableSize(view: EditorView, pos: number): Promise<TableSize | undefined> {
  const { promise, resolve } = Promise.withResolvers<TableSize | undefined>()
  const popup = document.createElement('div')
  popup.className = 'cm-tooltip cm-lp-table-size'
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', 'Table size')
  popup.tabIndex = -1
  const cells = document.createElement('div')
  cells.className = 'cm-lp-table-size-cells'
  cells.setAttribute('aria-hidden', 'true')
  for (let rows = 1; rows <= MAX_TABLE_SIZE; rows++) {
    for (let columns = 1; columns <= MAX_TABLE_SIZE; columns++) {
      const cell = document.createElement('div')
      cell.dataset.columns = String(columns)
      cell.dataset.rows = String(rows)
      cells.append(cell)
    }
  }
  const label = document.createElement('div')
  label.className = 'cm-lp-table-size-label'
  label.setAttribute('role', 'status')
  popup.append(cells, label)

  let size: TableSize = { columns: 2, rows: 1 }
  const highlight = (columns: number, rows: number) => {
    size = {
      columns: Math.min(Math.max(columns, 1), MAX_TABLE_SIZE),
      rows: Math.min(Math.max(rows, 1), MAX_TABLE_SIZE),
    }
    for (const cell of cells.children) {
      const { dataset } = cell as HTMLElement
      cell.classList.toggle(
        'cm-lp-table-size-on',
        Number(dataset.columns) <= size.columns && Number(dataset.rows) <= size.rows,
      )
    }
    label.textContent = `${size.columns} × ${size.rows}`
  }
  let closed = false
  const close = (picked: TableSize | undefined, refocus: boolean) => {
    if (closed) return
    closed = true
    if (refocus) {
      view.focus()
      // CodeMirror reports the focus change later; until then the table would render as a widget around the cursor.
      if (view.hasFocus) view.dispatch({ effects: setEditorFocused.of(true) })
    }
    popup.remove()
    resolve(picked)
  }
  const cellSize = (target: EventTarget | null): TableSize | undefined => {
    const dataset = target instanceof HTMLElement ? target.dataset : undefined
    return dataset?.columns && dataset.rows
      ? { columns: Number(dataset.columns), rows: Number(dataset.rows) }
      : undefined
  }

  popup.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') highlight(size.columns + 1, size.rows)
    else if (event.key === 'ArrowLeft') highlight(size.columns - 1, size.rows)
    else if (event.key === 'ArrowDown') highlight(size.columns, size.rows + 1)
    else if (event.key === 'ArrowUp') highlight(size.columns, size.rows - 1)
    else if (event.key === 'Enter') close(size, true)
    else if (event.key === 'Escape') close(undefined, true)
    else return
    event.preventDefault()
    event.stopPropagation()
  })
  popup.addEventListener('mouseover', (event) => {
    const hovered = cellSize(event.target)
    if (hovered) highlight(hovered.columns, hovered.rows)
  })
  // Clicks keep the focus on the grid, so only a click outside it closes it through `focusout`.
  popup.addEventListener('mousedown', (event) => event.preventDefault())
  popup.addEventListener('click', (event) => {
    const clicked = cellSize(event.target)
    if (clicked) close(clicked, true)
  })
  popup.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && popup.contains(event.relatedTarget))) close(undefined, false)
  })

  highlight(size.columns, size.rows)
  const coords = view.coordsAtPos(pos)
  popup.style.left = `${coords?.left ?? 0}px`
  popup.style.top = `${(coords?.bottom ?? 0) + 4}px`
  view.dom.append(popup)
  popup.focus()
  return promise
}

async function runTableCommand(view: EditorView, from: number, to: number): Promise<void> {
  // Remove the `/query` first; the document may change while the grid is open (a live reload), so the table goes
  // where the `/query` maps to. While the editor is read-only (a transition holds the note) the insert waits.
  view.dispatch({ changes: { from, to }, userEvent: 'input.slash' })
  const target = trackInsertion(view, from)
  try {
    const size = await pickTableSize(view, from)
    if (!size) return
    await target.whenEditable()
    const at = target.at()
    if (at === undefined) return
    view.dispatch(slashCommandTransaction(view.state, at, at, tableTemplate(size.columns, size.rows)))
  } finally {
    target.done()
  }
}

function applySlashCommand(view: EditorView, command: SlashCommand, from: number, to: number): void {
  if (command.template === 'image') {
    void runImageCommand(view, from, to).catch((error: unknown) => console.error('Inserting image failed', error))
    return
  }
  if (command.template === 'table') {
    void runTableCommand(view, from, to).catch((error: unknown) => console.error('Inserting table failed', error))
    return
  }
  if ('inline' in command.template) {
    const text = formatSlashDateTime(command.template.inline, new Date())
    view.dispatch(slashInlineTransaction(view.state, from, to, text))
    return
  }
  view.dispatch(slashCommandTransaction(view.state, from, to, command.template))
}

/** Completion source: `/` at the start of a line or after whitespace, outside code, math and links. */
export function slashCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/(?:^|\s)\/[\w-]*$/)
  if (!match) return null
  const slash = match.from + match.text.lastIndexOf('/')
  for (let node: SyntaxNode | null = syntaxTree(context.state).resolveInner(slash, -1); node; node = node.parent) {
    if (NO_SLASH_NODES[node.name]) return null
  }
  const query = context.state.sliceDoc(slash + 1, context.pos)
  const options: Completion[] = filterSlashCommands(query).map((command, index) => ({
    label: `/${command.id}`,
    displayLabel: command.label,
    detail: `/${command.id}`,
    type: 'slash',
    boost: -index,
    apply: (view, _completion, from, to) => applySlashCommand(view, command, from, to),
  }))
  if (options.length === 0) return null
  return { from: slash, to: context.pos, options, filter: false }
}

/** The `/` menu: filter by typing, arrows/Enter to pick, Esc to close. */
export function slashCommandMenu(): Extension {
  return autocompletion({
    override: [slashCompletionSource],
    icons: false,
    defaultKeymap: true,
    closeOnBlur: true,
    tooltipClass: () => 'cm-lp-slash-menu',
  })
}
