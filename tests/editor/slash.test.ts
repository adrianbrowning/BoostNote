import { CompletionContext } from '@codemirror/autocomplete'
import { describe, expect, it } from 'vitest'

import {
  filterSlashCommands,
  formatSlashDateTime,
  slashCommands,
  slashCommandTransaction,
  slashCompletionSource,
  slashInlineTransaction,
} from '../../src/editor/slash.ts'
import { docWithSelection, markdownState } from './helpers.ts'

const command = (id: string) => {
  const found = slashCommands.find((candidate) => candidate.id === id)
  if (!found || found.template === 'image' || 'inline' in found.template) throw new Error(`no template command ${id}`)
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

describe('inline date/time slash commands', () => {
  const clock = new Date(2026, 10, 5, 14, 32)

  /** Runs `/query` ending at the cursor through the inline command with `id` at the fixed clock. */
  const runInline = (doc: string, id: string, now = clock) => {
    const state = markdownState(doc)
    const to = state.selection.main.head
    const from = state.sliceDoc(0, to).lastIndexOf('/')
    const found = slashCommands.find((candidate) => candidate.id === id)
    if (!found || found.template === 'image' || !('inline' in found.template)) throw new Error(`no inline ${id}`)
    const spec = slashInlineTransaction(state, from, to, formatSlashDateTime(found.template.inline, now))
    expect(spec.userEvent).toBe('input.slash')
    return docWithSelection(state.update(spec).state)
  }

  it('inserts the date mid-line in place of the /query, keeping following text', () => {
    expect(runInline('Today: /date‸ is here\nnext', 'date')).toBe('Today: 2026-11-05‸ is here\nnext')
  })

  it('inserts time and datetime on an empty line', () => {
    expect(runInline('/time‸', 'time')).toBe('14:32‸')
    expect(runInline('/datetime‸', 'datetime')).toBe('2026-11-05 14:32‸')
  })

  it('zero-pads and uses local time, not UTC', () => {
    const early = new Date(2026, 0, 2, 3, 4)
    expect(formatSlashDateTime('datetime', early)).toBe('2026-01-02 03:04')
    expect(formatSlashDateTime('date', early)).toBe('2026-01-02')
    expect(formatSlashDateTime('time', early)).toBe('03:04')
    const local = {
      getFullYear: () => 2026,
      getMonth: () => 10,
      getDate: () => 5,
      getHours: () => 14,
      getMinutes: () => 32,
      getUTCFullYear: () => 2027,
      getUTCMonth: () => 0,
      getUTCDate: () => 1,
      getUTCHours: () => 1,
      getUTCMinutes: () => 1,
      toISOString: () => '2027-01-01T01:01:00.000Z',
    } as unknown as Date
    expect(formatSlashDateTime('datetime', local)).toBe('2026-11-05 14:32')
  })

  it('finds the commands by keyword', () => {
    expect(filterSlashCommands('today').map((c) => c.id)).toEqual(['date'])
    expect(filterSlashCommands('clock').map((c) => c.id)).toEqual(['time'])
    expect(filterSlashCommands('timestamp').map((c) => c.id)).toEqual(['datetime'])
  })

  it('does not open inside code, math or links', () => {
    expect(complete('`a /date‸`')).toBeNull()
    expect(complete('$a /time‸$')).toBeNull()
    expect(complete('[a /datetime‸](u)')).toBeNull()
  })
})
