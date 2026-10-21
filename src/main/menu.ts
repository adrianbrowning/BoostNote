import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron'

import type { MenuCommand } from './events.ts'

const REPOSITORY_URL = 'https://github.com/adrianbrowning/BoostNote'

/** Installs the application menu. App-specific items are forwarded to the renderer as SSE `menu` events. */
export function installMenu(sendCommand: (command: MenuCommand) => void): void {
  const isMac = process.platform === 'darwin'
  const revealLabel = isMac ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in Folder'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-note') },
        { label: 'New Folder…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendCommand('new-folder') },
        { type: 'separator' },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-folder') },
        { label: 'Import Boostnote Storage…', click: () => sendCommand('import-storage') },
        { type: 'separator' },
        { label: revealLabel, accelerator: 'CmdOrCtrl+Alt+R', click: () => sendCommand('reveal-note') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Boostnote on GitHub',
          click: () => void shell.openExternal(REPOSITORY_URL),
        },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal(`${REPOSITORY_URL}/issues`),
        },
        ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'about' } as const]),
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({ applicationName: 'Boostnote', applicationVersion: app.getVersion() })
}
