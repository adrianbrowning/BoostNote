import { describe, expect, it, vi } from 'vitest'

import { type MenuModel, runMenuCommand } from '../../src/app/actions/public/workspace/menu-commands.ts'
import { COMMANDS, type MenuEvent } from '../../src/shared/commands.ts'

const ACTIONS = [
  'pickVault',
  'setImportOpen',
  'setPreferencesOpen',
  'togglePane',
  'closeTab',
  'cycleTab',
  'selectTab',
  'newNote',
  'newFolder',
  'setTitleRenamesOpen',
  'revealNote',
  'reopenTab',
  'goBack',
  'goForward',
  'find',
  'exportNote',
  'exportFolder',
] as const

/** A workspace with a vault open (unless `vault: null`) and the folder `docs` selected. */
function fakeModel(vault: MenuModel['data']['vault'] = { root: '/vault', name: 'vault' }) {
  const actions = Object.fromEntries(ACTIONS.map((name) => [name, vi.fn(async () => {})]))
  const model = { ...actions, data: { vault }, selection: { kind: 'folder', id: 'docs' } } as unknown as MenuModel
  /** Every workspace action the commands ran, as `[action, ...args]`. */
  const calls = () =>
    Object.entries(actions).flatMap(([name, action]) => action.mock.calls.map((args) => [name, ...args]))
  return { model, calls }
}

const event = (command: Exclude<MenuEvent['command'], 'select-tab'>): MenuEvent => ({ type: 'menu', command })

describe('runMenuCommand', () => {
  it.each([
    ['open-folder', ['pickVault']],
    ['import-storage', ['setImportOpen', true]],
    ['preferences', ['setPreferencesOpen', true]],
    ['toggle-sidebar', ['togglePane', 'sidebarCollapsed']],
    ['toggle-note-list', ['togglePane', 'listCollapsed']],
    ['toggle-properties', ['togglePane', 'propertiesOpen']],
    ['close-tab', ['closeTab']],
    ['next-tab', ['cycleTab', 1]],
    ['previous-tab', ['cycleTab', -1]],
    ['new-note', ['newNote']],
    ['new-folder', ['newFolder']],
    ['rename-from-titles', ['setTitleRenamesOpen', true]],
    ['reveal-note', ['revealNote']],
    ['reopen-tab', ['reopenTab']],
    ['go-back', ['goBack']],
    ['go-forward', ['goForward']],
    ['find', ['find']],
    ['export-html', ['exportNote', 'html']],
    ['export-pdf', ['exportNote', 'pdf']],
    ['export-markdown', ['exportNote', 'markdown']],
    ['print', ['exportNote', 'print']],
    ['export-folder', ['exportFolder', 'docs']],
    ['export-vault', ['exportFolder', '']],
  ] as const)('runs %s as %j', (command, call) => {
    const { model, calls } = fakeModel()
    runMenuCommand(event(command), model)
    expect(calls()).toEqual([call])
  })

  it('passes the select-tab index through, -1 for the last tab', () => {
    const { model, calls } = fakeModel()
    runMenuCommand({ type: 'menu', command: 'select-tab', index: 3 }, model)
    runMenuCommand({ type: 'menu', command: 'select-tab', index: -1 }, model)
    expect(calls()).toEqual([
      ['selectTab', 3],
      ['selectTab', -1],
    ])
  })

  it('exports the whole vault from Folder as HTML when no folder is selected', () => {
    const { model, calls } = fakeModel()
    const all = { ...model, selection: { kind: 'all' } } as MenuModel
    runMenuCommand(event('export-folder'), all)
    expect(calls()).toEqual([['exportFolder', '']])
  })

  it('ignores the commands that need a vault until one is open', () => {
    const { model, calls } = fakeModel(null)
    for (const { id } of COMMANDS.filter((command) => command.needsVault)) {
      runMenuCommand(event(id), model)
    }
    expect(calls()).toEqual([])
  })

  it('runs the other commands without a vault', () => {
    const { model, calls } = fakeModel(null)
    runMenuCommand(event('open-folder'), model)
    runMenuCommand(event('toggle-sidebar'), model)
    runMenuCommand({ type: 'menu', command: 'select-tab', index: 0 }, model)
    expect(calls()).toEqual([['pickVault'], ['togglePane', 'sidebarCollapsed'], ['selectTab', 0]])
  })
})
