import { EventEmitter } from 'node:events'
import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEditContextMenu, installEditContextMenu } from '../../src/main/context-menu.ts'

const popup = vi.fn()
const buildFromTemplate = vi.fn((_template: MenuItemConstructorOptions[]) => ({ popup }))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => buildFromTemplate(t) } }))

function fakes(enabled = true) {
  const webContents = Object.assign(new EventEmitter(), { replaceMisspelling: vi.fn() })
  const session = { isSpellCheckerEnabled: vi.fn(() => enabled), addWordToSpellCheckerDictionary: vi.fn(() => true) }
  return { webContents, session }
}

const EDIT = [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
const SEVEN = ['the', 'ten', 'tea', 'tech', 'tee', 'tel', 'tex']

function shape(items: MenuItemConstructorOptions[]) {
  return items.map(({ click: _click, ...rest }) => rest)
}

beforeEach(() => {
  popup.mockClear()
  buildFromTemplate.mockClear()
})

describe('buildEditContextMenu', () => {
  it('lists the first 5 suggestions, Add to Dictionary, a separator, then edit roles', () => {
    const { webContents, session } = fakes()
    const menu = buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: SEVEN }, webContents, session)
    expect(shape(menu)).toEqual([
      { label: 'the' },
      { label: 'ten' },
      { label: 'tea' },
      { label: 'tech' },
      { label: 'tee' },
      { label: 'Add to Dictionary' },
      { type: 'separator' },
      ...EDIT,
    ])
  })

  it('replaces the misspelling with the clicked suggestion', () => {
    const { webContents, session } = fakes()
    const menu = buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: SEVEN }, webContents, session)
    menu[2]?.click?.({} as never, undefined, {} as never)
    expect(webContents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith('tea')
  })

  it('adds the misspelled word to the dictionary', () => {
    const { webContents, session } = fakes()
    const menu = buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: SEVEN }, webContents, session)
    const add = menu.find((item) => item.label === 'Add to Dictionary')
    add?.click?.({} as never, undefined, {} as never)
    expect(session.addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith('teh')
  })

  it('shows a disabled "No suggestions" item when there are none', () => {
    const { webContents, session } = fakes()
    const menu = buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: [] }, webContents, session)
    expect(shape(menu)).toEqual([
      { label: 'No suggestions', enabled: false },
      { label: 'Add to Dictionary' },
      { type: 'separator' },
      ...EDIT,
    ])
  })

  it('shows only edit roles on a correct word', () => {
    const { webContents, session } = fakes()
    expect(buildEditContextMenu({ misspelledWord: '', dictionarySuggestions: [] }, webContents, session)).toEqual(EDIT)
  })

  it('shows only edit roles with the spellchecker disabled', () => {
    const { webContents, session } = fakes(false)
    const menu = buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: SEVEN }, webContents, session)
    expect(menu).toEqual(EDIT)
  })
})

describe('installEditContextMenu', () => {
  const window = { id: 1 } as unknown as Electron.BaseWindow

  it('pops up no menu for a non-editable target', () => {
    const { webContents, session } = fakes()
    installEditContextMenu(webContents, session, window)
    webContents.emit('context-menu', {}, { isEditable: false, misspelledWord: '', dictionarySuggestions: [] })
    expect(buildFromTemplate).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  it('pops up the built menu on the window for an editable target', () => {
    const { webContents, session } = fakes()
    installEditContextMenu(webContents, session, window)
    webContents.emit('context-menu', {}, { isEditable: true, misspelledWord: '', dictionarySuggestions: [] })
    expect(buildFromTemplate).toHaveBeenCalledExactlyOnceWith(EDIT)
    expect(popup).toHaveBeenCalledExactlyOnceWith({ window })
  })
})
