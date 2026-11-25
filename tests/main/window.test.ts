import { expect, it, vi } from 'vitest'

import { createMainWindow } from '../../src/main/window.ts'

const { installEditContextMenu } = vi.hoisted(() => ({ installEditContextMenu: vi.fn() }))
vi.mock('../../src/main/context-menu.ts', () => ({ installEditContextMenu }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events') // vi.mock factories are hoisted above static imports
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { session: { id: 'session' }, setWindowOpenHandler() {} })
    loadURL = async () => {}
  }
  return {
    BrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getAllDisplays: () => [] },
    shell: {},
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    net: {},
  }
})

it('installs the edit context menu on the main window webContents', () => {
  const settings = { read: () => ({}), update() {} } as never
  const window = createMainWindow({ settings, isQuitting: () => false })
  expect(installEditContextMenu).toHaveBeenCalledExactlyOnceWith(window.webContents, window.webContents.session, window)
})
