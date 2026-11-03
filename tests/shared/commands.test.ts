import { describe, expect, it } from 'vitest'

import { COMMANDS, commandLabel } from '../../src/shared/commands.ts'

describe('command table', () => {
  it('has one row per application command', () => {
    const ids = COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(
      [
        'new-note',
        'new-folder',
        'open-folder',
        'import-storage',
        'rename-from-titles',
        'reveal-note',
        'close-tab',
        'reopen-tab',
        'next-tab',
        'previous-tab',
        'select-tab',
        'go-back',
        'go-forward',
        'toggle-sidebar',
        'toggle-note-list',
        'toggle-properties',
        'preferences',
        'find',
        'export-html',
        'export-pdf',
        'export-markdown',
        'print',
        'export-folder',
        'export-vault',
      ].sort(),
    )
  })

  it('carries the menu accelerators', () => {
    const accelerators = Object.fromEntries(
      COMMANDS.flatMap((command) => ('accelerator' in command ? [[command.id, command.accelerator]] : [])),
    )
    expect(accelerators).toEqual({
      'new-note': 'CmdOrCtrl+N',
      'new-folder': 'CmdOrCtrl+Shift+N',
      'open-folder': 'CmdOrCtrl+O',
      'reveal-note': 'CmdOrCtrl+Alt+R',
      'close-tab': 'CmdOrCtrl+W',
      'reopen-tab': 'CmdOrCtrl+Shift+T',
      'next-tab': 'Ctrl+Tab',
      'previous-tab': 'Ctrl+Shift+Tab',
      'go-back': 'CmdOrCtrl+[',
      'go-forward': 'CmdOrCtrl+]',
      'toggle-sidebar': 'CmdOrCtrl+Shift+E',
      'toggle-note-list': 'CmdOrCtrl+Shift+J',
      'toggle-properties': 'CmdOrCtrl+Shift+P',
      preferences: 'CmdOrCtrl+,',
      find: 'CmdOrCtrl+F',
      print: 'CmdOrCtrl+P',
    })
    const selectTab = COMMANDS.find((command) => command.id === 'select-tab')
    expect(selectTab && 'tabAccelerators' in selectTab ? selectTab.tabAccelerators : []).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'CmdOrCtrl+5',
      'CmdOrCtrl+6',
      'CmdOrCtrl+7',
      'CmdOrCtrl+8',
      'CmdOrCtrl+9',
    ])
  })

  it('marks the commands that need an open vault', () => {
    const free = COMMANDS.filter((command) => !command.needsVault).map((command) => command.id)
    expect([...free].sort()).toEqual(
      [
        'open-folder',
        'import-storage',
        'preferences',
        'toggle-sidebar',
        'toggle-note-list',
        'toggle-properties',
        'close-tab',
        'next-tab',
        'previous-tab',
        'select-tab',
      ].sort(),
    )
  })

  it('resolves platform labels', () => {
    const label = (id: string, platform: NodeJS.Platform) =>
      commandLabel(COMMANDS.find((command) => command.id === id)?.label ?? '', platform)
    expect(label('preferences', 'darwin')).toBe('Settings…')
    expect(label('preferences', 'win32')).toBe('Preferences…')
    expect(label('preferences', 'linux')).toBe('Preferences…')
    expect(label('reveal-note', 'darwin')).toBe('Reveal in Finder')
    expect(label('reveal-note', 'win32')).toBe('Show in Explorer')
    expect(label('reveal-note', 'linux')).toBe('Show in Folder')
    expect(label('new-note', 'win32')).toBe('New Note')
  })
})
