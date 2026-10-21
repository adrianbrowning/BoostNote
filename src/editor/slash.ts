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

import { editorHost } from './config.ts'
import { imageMarkdown } from './paste.ts'

/** A block the slash menu inserts. `cursor` is the offset inside `text` where the cursor lands. */
interface BlockTemplate {
  text: string
  cursor: number
}

export interface SlashCommand {
  id: string
  label: string
  keywords: string
  /** Fixed template, or `'image'` for the file-picker command. */
  template: BlockTemplate | 'image'
}

const template = (text: string, cursor = text.length): BlockTemplate => ({ text, cursor })

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
  {
    id: 'table',
    label: 'Table',
    keywords: 'table grid',
    template: template('| Column 1 | Column 2 |\n| --- | --- |\n|  |  |', 2),
  },
  {
    id: 'divider',
    label: 'Divider',
    keywords: 'divider horizontal rule hr line separator',
    template: template('---\n'),
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
  // Remove the `/query` first; the picker is asynchronous and the user may keep typing meanwhile.
  view.dispatch({ changes: { from, to }, userEvent: 'input.slash' })
  const file = await pickImage()
  if (!file) return
  const path = await view.state.facet(editorHost).saveAsset(file)
  const at = Math.min(from, view.state.doc.length)
  view.dispatch(slashCommandTransaction(view.state, at, at, template(imageMarkdown(file.name, path))))
}

function applySlashCommand(view: EditorView, command: SlashCommand, from: number, to: number): void {
  if (command.template === 'image') {
    void runImageCommand(view, from, to).catch((error: unknown) => console.error('Inserting image failed', error))
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
