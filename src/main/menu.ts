import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron'

import type { MenuCommand } from './events.ts'

const REPOSITORY_URL = 'https://github.com/adrianbrowning/BoostNote'

/** Installs the application menu. App-specific items are forwarded to the renderer as SSE `menu` events. */
export function installMenu(sendCommand: (command: MenuCommand) => void): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('new-note'),
        },
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
