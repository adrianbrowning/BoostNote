import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron'

import { ACCELERATORS, TAB_ACCELERATORS } from '../app/actions/public/workspace/shortcuts.ts'
import type { MenuCommand } from './events.ts'

const REPOSITORY_URL = 'https://github.com/adrianbrowning/BoostNote'

/** Installs the application menu. App commands are forwarded to the renderer as SSE `menu` events. */
export function installMenu(send: (command: MenuCommand, index?: number) => void): void {
  const isMac = process.platform === 'darwin'
  const revealLabel = isMac ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in Folder'
  // Ids are the commands, so tests (and anything else) can find an item: `Menu.getApplicationMenu().getMenuItemById(command)`.
  const command = (label: string, name: MenuCommand): MenuItemConstructorOptions => ({
    id: name,
    label,
    click: () => send(name),
  })
  const item = (label: string, name: keyof typeof ACCELERATORS): MenuItemConstructorOptions => ({
    ...command(label, name),
    accelerator: ACCELERATORS[name],
  })
  const preferences = item(isMac ? 'Settings…' : 'Preferences…', 'preferences')

  const selectTab = TAB_ACCELERATORS.map(
    (accelerator, index): MenuItemConstructorOptions => ({
      label: index === 8 ? 'Last Tab' : `Tab ${index + 1}`,
      accelerator,
      click: () => send('select-tab', index === 8 ? -1 : index),
    }),
  )

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
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
        item('New Note', 'new-note'),
        item('New Folder…', 'new-folder'),
        { type: 'separator' },
        item('Open Folder…', 'open-folder'),
        command('Import Boostnote Storage…', 'import-storage'),
        {
          label: 'Export',
          submenu: [
            command('Note as HTML…', 'export-html'),
            command('Note as PDF…', 'export-pdf'),
            command('Note as Markdown…', 'export-markdown'),
            { type: 'separator' },
            command('Folder as HTML…', 'export-folder'),
            command('Vault as HTML…', 'export-vault'),
          ],
        },
        item('Print…', 'print'),
        { type: 'separator' },
        item(revealLabel, 'reveal-note'),
        { type: 'separator' },
        item('Close Tab', 'close-tab'),
        item('Reopen Closed Tab', 'reopen-tab'),
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
        item('Find…', 'find'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Sidebar', 'toggle-sidebar'),
        item('Toggle Note List', 'toggle-note-list'),
        item('Toggle Properties', 'toggle-properties'),
        { type: 'separator' },
        item('Back', 'go-back'),
        item('Forward', 'go-forward'),
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
        item('Next Tab', 'next-tab'),
        item('Previous Tab', 'previous-tab'),
        { label: 'Select Tab', submenu: selectTab },
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
        ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'about' } as const]),
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({ applicationName: 'Boostnote', applicationVersion: app.getVersion() })
}
