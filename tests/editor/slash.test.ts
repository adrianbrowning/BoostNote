import { CompletionContext } from '@codemirror/autocomplete'
import { describe, expect, it } from 'vitest'

import {
  filterSlashCommands,
  slashCommands,
  slashCommandTransaction,
  slashCompletionSource,
} from '../../src/editor/slash.ts'
import { docWithSelection, markdownState } from './helpers.ts'

const command = (id: string) => {
  const found = slashCommands.find((candidate) => candidate.id === id)
  if (!found || found.template === 'image') throw new Error(`no template command ${id}`)
  return found.template
}

/** Runs `/query` ending at the cursor through the slash command with `id`. */
const run = (doc: string, id: string) => {
  const state = markdownState(doc)
  const to = state.selection.main.head
  const from = state.sliceDoc(0, to).lastIndexOf('/')
  return docWithSelection(state.update(slashCommandTransaction(state, from, to, command(id))).state)
}

const complete = (doc: string) => {
  const state = markdownState(doc)
  return slashCompletionSource(new CompletionContext(state, state.selection.main.head, false))
}

describe('slash commands', () => {
  it('filters by label, id and keywords', () => {
    expect(filterSlashCommands('').length).toBe(slashCommands.length)
    expect(filterSlashCommands('head').map((c) => c.id)).toEqual(['h1', 'h2', 'h3'])
    expect(filterSlashCommands('flowchart').map((c) => c.id)).toEqual(['mermaid'])
    expect(filterSlashCommands('todo').map((c) => c.id)).toEqual(['task'])
    expect(filterSlashCommands('nothing-matches')).toEqual([])
  })

  it('converts an empty paragraph in place', () => {
    expect(run('Intro\n\n/h2‸\n\nOutro', 'h2')).toBe('Intro\n\n## ‸\n\nOutro')
    expect(run('/task‸', 'task')).toBe('- [ ] ‸')
    expect(run('/code‸', 'code')).toBe('```\n‸\n```')
    expect(run('/table‸', 'table')).toBe('| ‸Column 1 | Column 2 |\n| --- | --- |\n|  |  |')
  })

  it('inserts a mermaid starter with the cursor on the diagram source', () => {
    expect(run('/mermaid‸', 'mermaid')).toBe(
      '```mermaid\n‸flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```',
    )
  })

  it('inserts a new block after the current block when the line has other text', () => {
    expect(run('Some text /h1‸ here\nsecond line\n\nNext', 'h1')).toBe('Some text  here\nsecond line\n\n# ‸\n\nNext')
    expect(run('Last paragraph /divider‸', 'divider')).toBe('Last paragraph \n\n---\n‸')
    expect(run('- item one\n- item /quote‸\n\nAfter', 'quote')).toBe('- item one\n- item \n\n> ‸\n\nAfter')
  })

  it('opens at line start or after whitespace, outside code', () => {
    expect(complete('/‸')?.options.length).toBe(slashCommands.length)
    expect(complete('text /hea‸')?.options.map((o) => o.displayLabel)).toEqual(['Heading 1', 'Heading 2', 'Heading 3'])
    expect(complete('and/or‸')).toBeNull()
    expect(complete('```\n/‸\n```')).toBeNull()
    expect(complete('`/‸`')).toBeNull()
    expect(complete('/zzz‸')).toBeNull()
  })
})
