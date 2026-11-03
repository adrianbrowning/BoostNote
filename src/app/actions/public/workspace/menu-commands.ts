import { COMMANDS, type MenuCommand, type MenuEvent } from '../../../../shared/commands.ts'
import type { WorkspaceModel } from './model.ts'
import type { WorkspaceData } from './types.ts'

/** What the menu commands use of the workspace. */
export type MenuModel = Pick<
  WorkspaceModel,
  | 'selection'
  | 'pickVault'
  | 'setImportOpen'
  | 'setPreferencesOpen'
  | 'togglePane'
  | 'closeTab'
  | 'cycleTab'
  | 'selectTab'
  | 'newNote'
  | 'newFolder'
  | 'setTitleRenamesOpen'
  | 'revealNote'
  | 'reopenTab'
  | 'goBack'
  | 'goForward'
  | 'find'
  | 'exportNote'
  | 'exportFolder'
> & { readonly data: Pick<WorkspaceData, 'vault'> }

type MenuHandlers = {
  [C in MenuCommand]: (model: MenuModel, event: Extract<MenuEvent, { command: C }>) => void
}

/** One handler per command: a table row without one fails the typecheck. */
const HANDLERS = {
  'new-note': (model) => void model.newNote(),
  'new-folder': (model) => void model.newFolder(),
  'open-folder': (model) => void model.pickVault(),
  'import-storage': (model) => model.setImportOpen(true),
  'rename-from-titles': (model) => model.setTitleRenamesOpen(true),
  'export-html': (model) => void model.exportNote('html'),
  'export-pdf': (model) => void model.exportNote('pdf'),
  'export-markdown': (model) => void model.exportNote('markdown'),
  'export-folder': (model) => void model.exportFolder(model.selection.kind === 'folder' ? model.selection.id : ''),
  'export-vault': (model) => void model.exportFolder(''),
  print: (model) => void model.exportNote('print'),
  'reveal-note': (model) => void model.revealNote(),
  'close-tab': (model) => void model.closeTab(),
  'reopen-tab': (model) => void model.reopenTab(),
  preferences: (model) => model.setPreferencesOpen(true),
  find: (model) => model.find(),
  'toggle-sidebar': (model) => model.togglePane('sidebarCollapsed'),
  'toggle-note-list': (model) => model.togglePane('listCollapsed'),
  'toggle-properties': (model) => model.togglePane('propertiesOpen'),
  'go-back': (model) => void model.goBack(),
  'go-forward': (model) => void model.goForward(),
  'next-tab': (model) => void model.cycleTab(1),
  'previous-tab': (model) => void model.cycleTab(-1),
  'select-tab': (model, { index }) => void model.selectTab(index),
} satisfies MenuHandlers

const NEEDS_VAULT = new Set<MenuCommand>(COMMANDS.flatMap((command) => (command.needsVault ? [command.id] : [])))

/** Runs a native-menu command on the workspace; commands that need a vault do nothing until one is open. */
export function runMenuCommand(event: MenuEvent, model: MenuModel): void {
  if (NEEDS_VAULT.has(event.command) && !model.data.vault) return
  // TypeScript cannot correlate `event.command` with its handler's event type; `MenuHandlers` does.
  const handler = HANDLERS[event.command] as (model: MenuModel, event: MenuEvent) => void
  handler(model, event)
}
