import { describe, expect, it } from 'vitest'

import {
  COMMANDS,
  type CommandRow,
  commandAccelerators,
  commandLabel,
  commandRow,
  type MenuCommand,
  type MenuEvent,
} from '../../src/shared/commands.ts'

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
    expect(commandAccelerators(commandRow('select-tab'))).toEqual([
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

  it('labels each Select Tab item next to its accelerator', () => {
    expect(commandRow('select-tab').tabAccelerators).toEqual([
      { label: 'Tab 1', accelerator: 'CmdOrCtrl+1' },
      { label: 'Tab 2', accelerator: 'CmdOrCtrl+2' },
      { label: 'Tab 3', accelerator: 'CmdOrCtrl+3' },
      { label: 'Tab 4', accelerator: 'CmdOrCtrl+4' },
      { label: 'Tab 5', accelerator: 'CmdOrCtrl+5' },
      { label: 'Tab 6', accelerator: 'CmdOrCtrl+6' },
      { label: 'Tab 7', accelerator: 'CmdOrCtrl+7' },
      { label: 'Tab 8', accelerator: 'CmdOrCtrl+8' },
      { label: 'Last Tab', accelerator: 'CmdOrCtrl+9' },
    ])
  })

  it('gives a row either its own accelerator or tab items, never both', () => {
    const rows: CommandRow[] = [
      { id: 'a', label: 'A', accelerator: 'CmdOrCtrl+A', needsVault: false },
      { id: 'b', label: 'B', tabAccelerators: [{ label: 'B 1', accelerator: 'CmdOrCtrl+1' }], needsVault: false },
    ]
    expect(rows.flatMap(commandAccelerators)).toEqual(['CmdOrCtrl+A', 'CmdOrCtrl+1'])
    // @ts-expect-error a row with tab items has no accelerator of its own
    const both: CommandRow = {
      id: 'c',
      label: 'C',
      accelerator: 'CmdOrCtrl+C',
      tabAccelerators: [],
      needsVault: false,
    }
    expect(both.id).toBe('c')
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

describe('commandRow', () => {
  it('finds the row for a command', () => {
    expect(commandRow('new-note')).toEqual({
      id: 'new-note',
      label: 'New Note',
      accelerator: 'CmdOrCtrl+N',
      needsVault: true,
    })
  })

  it('throws on an unknown command', () => {
    expect(() => commandRow('check-updates' as MenuCommand)).toThrow('Unknown command: check-updates')
  })
})

describe('MenuEvent', () => {
  it('carries a tab index for select-tab only', () => {
    const events: MenuEvent[] = [
      { type: 'menu', command: 'select-tab', index: -1 },
      { type: 'menu', command: 'new-note' },
      // @ts-expect-error select-tab needs the tab index
      { type: 'menu', command: 'select-tab' },
      // @ts-expect-error only select-tab carries an index
      { type: 'menu', command: 'close-tab', index: 0 },
      // @ts-expect-error not a command
      { type: 'menu', command: 'check-updates' },
    ]
    expect(events.map((event) => event.command)).toEqual([
      'select-tab',
      'new-note',
      'select-tab',
      'close-tab',
      'check-updates',
    ])
  })
})
