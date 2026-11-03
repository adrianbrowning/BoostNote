import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { buildMenuTemplate } from '../../src/main/menu.ts'

// Only the template builder is under test; Electron's runtime is not available in node.
vi.mock('electron', () => ({ app: {}, Menu: {}, shell: {} }))

const noop = () => {}

function build(platform: NodeJS.Platform, send: (command: string, index?: number) => void = noop) {
  return buildMenuTemplate({
    platform,
    appName: 'Boostnote',
    send,
    checkForUpdates: noop,
    installCommandLineTool: noop,
  })
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])])
}

/** Every item with an id, as `id → [label, accelerator]`. */
function itemsById(template: MenuItemConstructorOptions[]): Record<string, [string?, string?]> {
  return Object.fromEntries(
    flatten(template).flatMap((item) => (item.id ? [[item.id, [item.label, item.accelerator]]] : [])),
  )
}

const COMMON = {
  'new-note': ['New Note', 'CmdOrCtrl+N'],
  'new-folder': ['New Folder…', 'CmdOrCtrl+Shift+N'],
  'open-folder': ['Open Folder…', 'CmdOrCtrl+O'],
  'import-storage': ['Import Boostnote Storage…', undefined],
  'rename-from-titles': ['Rename Files From Titles…', undefined],
  'export-html': ['Note as HTML…', undefined],
  'export-pdf': ['Note as PDF…', undefined],
  'export-markdown': ['Note as Markdown…', undefined],
  'export-folder': ['Folder as HTML…', undefined],
  'export-vault': ['Vault as HTML…', undefined],
  print: ['Print…', 'CmdOrCtrl+P'],
  'close-tab': ['Close Tab', 'CmdOrCtrl+W'],
  'reopen-tab': ['Reopen Closed Tab', 'CmdOrCtrl+Shift+T'],
  find: ['Find…', 'CmdOrCtrl+F'],
  'toggle-sidebar': ['Toggle Sidebar', 'CmdOrCtrl+Shift+E'],
  'toggle-note-list': ['Toggle Note List', 'CmdOrCtrl+Shift+J'],
  'toggle-properties': ['Toggle Properties', 'CmdOrCtrl+Shift+P'],
  'go-back': ['Back', 'CmdOrCtrl+['],
  'go-forward': ['Forward', 'CmdOrCtrl+]'],
  'next-tab': ['Next Tab', 'Ctrl+Tab'],
  'previous-tab': ['Previous Tab', 'Ctrl+Shift+Tab'],
  'select-tab-1': ['Tab 1', 'CmdOrCtrl+1'],
  'select-tab-2': ['Tab 2', 'CmdOrCtrl+2'],
  'select-tab-3': ['Tab 3', 'CmdOrCtrl+3'],
  'select-tab-4': ['Tab 4', 'CmdOrCtrl+4'],
  'select-tab-5': ['Tab 5', 'CmdOrCtrl+5'],
  'select-tab-6': ['Tab 6', 'CmdOrCtrl+6'],
  'select-tab-7': ['Tab 7', 'CmdOrCtrl+7'],
  'select-tab-8': ['Tab 8', 'CmdOrCtrl+8'],
  'select-tab-9': ['Last Tab', 'CmdOrCtrl+9'],
}

describe('native menu template', () => {
  it('has the macOS command items', () => {
    expect(itemsById(build('darwin'))).toEqual({
      ...COMMON,
      'check-updates': ['Check for Updates…', undefined],
      'install-cli': ['Install Command Line Tool…', undefined],
      preferences: ['Settings…', 'CmdOrCtrl+,'],
      'reveal-note': ['Reveal in Finder', 'CmdOrCtrl+Alt+R'],
    })
  })

  it('has the Windows command items', () => {
    expect(itemsById(build('win32'))).toEqual({
      ...COMMON,
      'check-updates': ['Check for Updates…', undefined],
      'install-cli': ['Command Line Tool…', undefined],
      preferences: ['Preferences…', 'CmdOrCtrl+,'],
      'reveal-note': ['Show in Explorer', 'CmdOrCtrl+Alt+R'],
    })
  })

  it('has the Linux command items', () => {
    expect(itemsById(build('linux'))).toEqual({
      ...COMMON,
      'check-updates': ['Check for Updates…', undefined],
      'install-cli': ['Install Command Line Tool…', undefined],
      preferences: ['Preferences…', 'CmdOrCtrl+,'],
      'reveal-note': ['Show in Folder', 'CmdOrCtrl+Alt+R'],
    })
  })

  it('sends the command, and the tab index for Select Tab items', () => {
    const send = vi.fn()
    const items = flatten(build('darwin', send))
    for (const id of ['new-note', 'select-tab-1', 'select-tab-8', 'select-tab-9']) {
      const click = items.find((item) => item.id === id)?.click as () => void
      click()
    }
    expect(send.mock.calls).toEqual([['new-note'], ['select-tab', 0], ['select-tab', 7], ['select-tab', -1]])
  })

  it('orders the command items per menu, with Export and Select Tab nested', () => {
    const ids = (items: MenuItemConstructorOptions[]): unknown[] =>
      items.flatMap((item): unknown[] =>
        Array.isArray(item.submenu)
          ? [{ [String(item.label ?? item.role)]: ids(item.submenu) }]
          : item.id
            ? [item.id]
            : [],
      )
    expect(ids(build('linux'))).toEqual([
      {
        File: [
          'new-note',
          'new-folder',
          'open-folder',
          'import-storage',
          'rename-from-titles',
          { Export: ['export-html', 'export-pdf', 'export-markdown', 'export-folder', 'export-vault'] },
          'print',
          'reveal-note',
          'close-tab',
          'reopen-tab',
          'preferences',
        ],
      },
      { Edit: ['find'] },
      { View: ['toggle-sidebar', 'toggle-note-list', 'toggle-properties', 'go-back', 'go-forward'] },
      {
        Window: [
          'next-tab',
          'previous-tab',
          {
            'Select Tab': [
              'select-tab-1',
              'select-tab-2',
              'select-tab-3',
              'select-tab-4',
              'select-tab-5',
              'select-tab-6',
              'select-tab-7',
              'select-tab-8',
              'select-tab-9',
            ],
          },
        ],
      },
      { help: ['check-updates', 'install-cli'] },
    ])
  })

  it('gives every item a unique id', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const ids = flatten(build(platform)).flatMap((item) => (item.id ? [item.id] : []))
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
