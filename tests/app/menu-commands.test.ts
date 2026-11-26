import { readdir } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../src/app/actions/public/workspace/api.ts'
import { type MenuModel, runMenuCommand } from '../../src/app/actions/public/workspace/menu-commands.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { COMMANDS, type MenuEvent } from '../../src/shared/commands.ts'
import { TestApp } from './helpers.ts'

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
  'newScratchNote',
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
    ['new-scratch-note', ['newScratchNote']],
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
    runMenuCommand(event('new-scratch-note'), model)
    runMenuCommand({ type: 'menu', command: 'select-tab', index: 0 }, model)
    expect(calls()).toEqual([['pickVault'], ['togglePane', 'sidebarCollapsed'], ['selectTab', 0], ['newScratchNote']])
  })
})

/** The commands on a real workspace over the in-process router (`createClient` over `TestApp.fetch`). */
describe('runMenuCommand on the workspace', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await TestApp.create()
  })

  afterEach(async () => {
    await app.close()
  })

  /** The workspace as the page builds it, with a memory tab store. */
  async function workspace(): Promise<WorkspaceModel> {
    const api = createClient(app.fetch)
    const snapshots = new Map<string, TabsSnapshot>()
    return new WorkspaceModel(
      await api.workspace(),
      { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
      {
        api,
        store: {
          load: (root) => snapshots.get(root) ?? null,
          save: (root, tabs) => snapshots.set(root, tabs),
          loadScratch: () => null,
          saveScratch: () => {},
        },
      },
    )
  }

  it.each([
    ['with a vault open', true],
    ['with no vault open', false],
  ])('new-scratch-note creates a scratch note and shows it in an active scratch tab, %s', async (_, withVault) => {
    if (withVault) await app.openVault()
    const model = await workspace()
    expect(model.data.vault === null).toBe(!withVault)
    const focus: boolean[] = []
    model.addEventListener('focus-editor', (event) => focus.push(event.atEnd))

    runMenuCommand(event('new-scratch-note'), model)

    await vi.waitFor(() => expect(model.tabs.active?.kind).toBe('scratch'))
    const tab = model.tabs.active
    const id = tab?.kind === 'scratch' ? tab.id : ''
    expect(model.tabs.tabs).toEqual([{ key: tab?.key, kind: 'scratch', id }])
    expect((await readdir(app.scratchDir)).sort()).toEqual([`${id}.json`, `${id}.md`])
    expect(model.session.scratch?.id).toBe(id)
    expect(model.session.body).toBe('')
    expect(model.session.note).toBeNull()
    await vi.waitFor(() => expect(focus).toEqual([true]))
    model.session.close()
  })
})
