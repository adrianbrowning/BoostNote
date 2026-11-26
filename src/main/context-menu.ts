import { type ContextMenuParams, Menu, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron'

const MAX_SUGGESTIONS = 5

/** The parts of `webContents` the menu uses. */
export interface MenuWebContents extends Pick<WebContents, 'replaceMisspelling'> {
  on(event: 'context-menu', listener: (event: unknown, params: ContextMenuParams) => void): unknown
}
/** The parts of `session` the menu uses. */
export type MenuSession = Pick<Session, 'isSpellCheckerEnabled' | 'addWordToSpellCheckerDictionary'>

/**
 * The native menu for an editable target: on a misspelled word (spellchecker enabled) up to 5
 * suggestions (or a disabled "No suggestions"), "Add to Dictionary" and a separator; then Cut,
 * Copy, Paste, Select All.
 */
export function buildEditContextMenu(
  params: Pick<ContextMenuParams, 'misspelledWord' | 'dictionarySuggestions'>,
  webContents: Pick<WebContents, 'replaceMisspelling'>,
  session: MenuSession,
): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions[] = [
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
  ]
  const word = params.misspelledWord
  if (!word || !session.isSpellCheckerEnabled()) return edit
  const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
  const spelling: MenuItemConstructorOptions[] = suggestions.length
    ? suggestions.map((s) => ({ label: s, click: () => webContents.replaceMisspelling(s) }))
    : [{ label: 'No suggestions', enabled: false }]
  return [
    ...spelling,
    { label: 'Add to Dictionary', click: () => session.addWordToSpellCheckerDictionary(word) },
    { type: 'separator' },
    ...edit,
  ]
}

/**
 * Pops up `buildEditContextMenu` on `window` for each `context-menu` event on an editable target;
 * non-editable targets get no native menu (the renderer's own menus stay).
 */
export function installEditContextMenu(
  webContents: MenuWebContents,
  session: MenuSession,
  window: Electron.BaseWindow,
): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    Menu.buildFromTemplate(buildEditContextMenu(params, webContents, session)).popup({ window })
  })
}
