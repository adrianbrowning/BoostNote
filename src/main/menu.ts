import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron'

import { COMMANDS, commandLabel, type MenuCommand } from '../shared/commands.ts'

const REPOSITORY_URL = 'https://github.com/adrianbrowning/BoostNote'

export interface MenuTemplateOptions {
  platform: NodeJS.Platform
  appName: string
  send: (command: MenuCommand, index?: number) => void
  checkForUpdates: () => void
  installCommandLineTool: () => void
}

/**
 * Installs the application menu. App commands are forwarded to the renderer as SSE `menu` events;
 * "Check for Updates…" and "Install Command Line Tool…" run in main.
 */
export function installMenu(
  send: MenuTemplateOptions['send'],
  checkForUpdates: () => void,
  installCommandLineTool: () => void,
): void {
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: app.name,
    send,
    checkForUpdates,
    installCommandLineTool,
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({ applicationName: 'Boostnote', applicationVersion: app.getVersion() })
}

/** The application menu: every command item's id, label and accelerator come from `COMMANDS`. */
export function buildMenuTemplate({
  platform,
  appName,
  send,
  checkForUpdates,
  installCommandLineTool,
}: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  const updates: MenuItemConstructorOptions = {
    id: 'check-updates',
    label: 'Check for Updates…',
    click: checkForUpdates,
  }
  // Windows gets the command to run instead of an installed shim.
  const commandLineTool: MenuItemConstructorOptions = {
    id: 'install-cli',
    label: platform === 'win32' ? 'Command Line Tool…' : 'Install Command Line Tool…',
    click: installCommandLineTool,
  }
  const items = new Map<MenuCommand, MenuItemConstructorOptions>()
  const selectTab: MenuItemConstructorOptions & { submenu: MenuItemConstructorOptions[] } = { submenu: [] }
  for (const row of COMMANDS) {
    if ('tabAccelerators' in row) {
      selectTab.label = commandLabel(row.label, platform)
      // Cmd/Ctrl+1–8 pick a tab, the last accelerator picks the last tab (`index` -1).
      row.tabAccelerators.forEach((accelerator, index, all) => {
        const last = index === all.length - 1
        selectTab.submenu.push({
          id: `${row.id}-${index + 1}`,
          label: last ? 'Last Tab' : `Tab ${index + 1}`,
          accelerator,
          click: () => send(row.id, last ? -1 : index),
        })
      })
      continue
    }
    // Ids are the commands, so tests (and anything else) can find an item: `Menu.getApplicationMenu().getMenuItemById(command)`.
    items.set(row.id, {
      id: row.id,
      label: commandLabel(row.label, platform),
      ...('accelerator' in row ? { accelerator: row.accelerator } : {}),
      click: () => send(row.id),
    })
  }
  const item = (name: Exclude<MenuCommand, 'select-tab'>): MenuItemConstructorOptions => {
    const options = items.get(name)
    if (!options) throw new Error(`No command row: ${name}`)
    return options
  }
  const preferences = item('preferences')

  return [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: 'about' },
              updates,
              commandLineTool,
              { type: 'separator' },
              preferences,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('new-note'),
        item('new-folder'),
        { type: 'separator' },
        item('open-folder'),
        item('import-storage'),
        item('rename-from-titles'),
        {
          label: 'Export',
          submenu: [
            item('export-html'),
            item('export-pdf'),
            item('export-markdown'),
            { type: 'separator' },
            item('export-folder'),
            item('export-vault'),
          ],
        },
        item('print'),
        { type: 'separator' },
        item('reveal-note'),
        { type: 'separator' },
        item('close-tab'),
        item('reopen-tab'),
        { type: 'separator' },
        ...(isMac
          ? [{ role: 'close', accelerator: 'CmdOrCtrl+Shift+W' } as const]
          : [preferences, { type: 'separator' } as const, { role: 'quit' } as const]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('find'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('toggle-sidebar'),
        item('toggle-note-list'),
        item('toggle-properties'),
        { type: 'separator' },
        item('go-back'),
        item('go-forward'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        item('next-tab'),
        item('previous-tab'),
        selectTab,
        ...(isMac ? [{ type: 'separator' } as const, { role: 'front' } as const] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Boostnote on GitHub', click: () => void shell.openExternal(REPOSITORY_URL) },
        {
          label: 'Modernisation Notes',
          click: () => void shell.openExternal(`${REPOSITORY_URL}/blob/master/docs/modernisation/PLAN.md`),
        },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPOSITORY_URL}/issues`) },
        ...(isMac ? [] : [{ type: 'separator' } as const, updates, commandLineTool, { role: 'about' } as const]),
      ],
    },
  ]
}
