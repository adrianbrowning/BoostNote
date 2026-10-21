import type { Handle } from 'remix/component'
import { clientEntry, css, on, ref } from 'remix/component'

import { routes } from '../../../routes.ts'
import { EditorPane } from './editor-pane.tsx'
import { ImportDialog } from './import-dialog.tsx'
import { PANE_LIMITS } from './layout.ts'
import { type Connection, WorkspaceModel } from './model.ts'
import { NoteList } from './note-list.tsx'
import type { SaveState } from './note-session.ts'
import { ContextMenuView, DialogView, NoticeView } from './overlays.tsx'
import { PreferencesDialog } from './preferences-dialog.tsx'
import { isReservedShortcut } from './shortcuts.ts'
import { Sidebar } from './sidebar.tsx'
import { button, emptyState, emptyTitle, muted, primaryButton } from './styles.ts'
import type { MenuEvent, PreferencesState, VaultChangeEvent, WorkspaceData } from './types.ts'

declare global {
  interface Window {
    /** Called by the main process before quitting: saves the open note; `false` when unsaved work remains. */
    boostFlushPendingSave?: () => Promise<boolean>
  }
}

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed',
  conflict: 'Conflict',
  removed: 'Removed on disk',
}

type Pane = keyof typeof PANE_LIMITS

/** Mouse buttons 4 and 5 (`MouseEvent.button` 3/4): back and forward in the active tab. */
const MOUSE_BACK = 3
const MOUSE_FORWARD = 4

/**
 * The whole workspace as one client entry: the panes share live state (selection, tabs, the dirty
 * editor, conflicts), which lives in `WorkspaceModel`. The server renders it with the vault's
 * current lists and the preferences, so the first paint is complete before the browser hydrates it.
 */
export const Workspace = clientEntry(
  import.meta.url,
  function Workspace(handle: Handle<{ initial: WorkspaceData; preferences: PreferencesState }>) {
    const model = new WorkspaceModel(handle.props.initial, handle.props.preferences)
    let layout: HTMLElement | undefined

    model.addEventListener('change', () => void handle.update(), { signal: handle.signal })

    const runMenuCommand = ({ command, index }: MenuEvent) => {
      if (command === 'open-folder') void model.pickVault()
      else if (command === 'import-storage') model.setImportOpen(true)
      else if (command === 'preferences') model.setPreferencesOpen(true)
      else if (command === 'toggle-sidebar') model.togglePane('sidebarCollapsed')
      else if (command === 'toggle-note-list') model.togglePane('listCollapsed')
      else if (command === 'toggle-properties') model.togglePane('propertiesOpen')
      else if (!model.data.vault) return
      else if (command === 'new-note') void model.newNote()
      else if (command === 'new-folder') void model.newFolder()
      else if (command === 'reveal-note') void model.revealNote()
      else if (command === 'close-tab') void model.closeTab()
      else if (command === 'reopen-tab') void model.reopenTab()
      else if (command === 'next-tab') void model.cycleTab(1)
      else if (command === 'previous-tab') void model.cycleTab(-1)
      else if (command === 'select-tab') void model.selectTab(index ?? 0)
      else if (command === 'go-back') void model.goBack()
      else if (command === 'go-forward') void model.goForward()
      else if (command === 'find') model.find()
      else if (command === 'export-html') void model.exportNote('html')
      else if (command === 'export-pdf') void model.exportNote('pdf')
      else if (command === 'export-markdown') void model.exportNote('markdown')
      else if (command === 'print') void model.exportNote('print')
      else if (command === 'export-folder')
        void model.exportFolder(model.selection.kind === 'folder' ? model.selection.id : '')
      else if (command === 'export-vault') void model.exportFolder('')
    }

    // Browser-only wiring; runs after hydration (setup also runs during the server render).
    handle.queueTask(() => {
      const { signal } = handle
      const isMac = /Mac/.test(navigator.platform)
      // A `.md` opened from the OS before or while the window loaded waits in main until taken.
      void model.restoreTabs().then(() => model.takeOpenRequest())

      const source = new EventSource(routes.events.href())
      source.addEventListener('open', () => model.setConnection('connected'))
      source.addEventListener('error', () =>
        model.setConnection(source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting'),
      )
      // Event payloads come from the main process's typed hub (`AppEvent` in src/main/events.ts).
      source.addEventListener('menu', (event) => {
        const menu: MenuEvent = JSON.parse(event.data)
        runMenuCommand(menu)
      })
      source.addEventListener('vault', (event) => {
        const change: VaultChangeEvent = JSON.parse(event.data)
        model.onVaultChange(change)
      })
      source.addEventListener('open-request', () => void model.takeOpenRequest())
      signal.addEventListener('abort', () => source.close(), { once: true })

      window.boostFlushPendingSave = () => model.session.flush()
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') void model.session.flush()
        },
        { signal },
      )
      window.addEventListener(
        'keydown',
        (event) => {
          // Menu accelerators belong to the menu: keep them from the editor (CodeMirror binds
          // Mod-[ / Mod-] / Mod-F too) without `preventDefault`, so the menu still gets them.
          // The hotkey recorder in Preferences takes any combination.
          const recording =
            event.target instanceof Element && event.target.closest('[data-hotkey-record][aria-pressed="true"]')
          if (!recording && isReservedShortcut(event, isMac)) event.stopPropagation()
          else if (event.key === 'Escape' && model.menu) model.closeMenu()
        },
        { signal, capture: true },
      )
      window.addEventListener(
        'mouseup',
        (event) => {
          if (event.button !== MOUSE_BACK && event.button !== MOUSE_FORWARD) return
          event.preventDefault()
          void (event.button === MOUSE_BACK ? model.goBack() : model.goForward())
        },
        { signal },
      )
    })

    const startResize = (pane: Pane) => (event: PointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const start = model.preferences.panes[pane]
      const [min, max] = PANE_LIMITS[pane]
      let width = start
      const drag = new AbortController()
      handle.signal.addEventListener('abort', () => drag.abort(), { signal: drag.signal })
      window.addEventListener(
        'pointermove',
        (move) => {
          width = Math.round(Math.min(max, Math.max(min, start + move.clientX - startX)))
          layout?.style.setProperty(`--${pane}`, `${width}px`)
        },
        { signal: drag.signal },
      )
      window.addEventListener(
        'pointerup',
        () => {
          drag.abort()
          if (width !== start) model.setPanes({ [pane]: width })
        },
        { signal: drag.signal },
      )
    }

    const resizer = (pane: Pane) => (
      <hr
        aria-orientation="vertical"
        aria-label={pane === 'sidebarWidth' ? 'Resize sidebar' : 'Resize note list'}
        mix={[resizerStyle, on<HTMLElement, 'pointerdown'>('pointerdown', startResize(pane))]}
        style={`grid-area: ${pane === 'sidebarWidth' ? 'sidebar' : 'list'}-resizer`}
      />
    )

    const welcome = () => (
      <main mix={welcomeStyle} aria-label="Welcome">
        <div mix={emptyState}>
          <h1 mix={emptyTitle}>No vault open</h1>
          <p mix={muted}>A vault is a folder of Markdown notes. Open one, or import your old Boostnote storage.</p>
          <div mix={welcomeActionsStyle}>
            <button
              type="button"
              mix={[button, primaryButton, on('click', () => void model.pickVault())]}
              data-open-folder
            >
              Open folder…
            </button>
            <button type="button" mix={[button, on('click', () => model.setImportOpen(true))]} data-import>
              Import Boostnote storage…
            </button>
          </div>
          {model.data.recent.length > 0 ? (
            <section mix={recentStyle} aria-label="Recent vaults">
              <h2 mix={muted}>Recent</h2>
              <ul mix={recentListStyle}>
                {model.data.recent.map((vault) => (
                  <li key={vault.root} mix={recentItemStyle}>
                    <button
                      type="button"
                      mix={[recentButtonStyle, on('click', () => void model.openVault(vault.root))]}
                      title={vault.root}
                    >
                      <strong>{vault.name}</strong>
                      <span mix={muted}>{vault.root}</span>
                    </button>
                    <button
                      type="button"
                      mix={[button, on('click', () => void model.forgetVault(vault.root))]}
                      aria-label={`Remove ${vault.name} from the list`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </main>
    )

    return () => {
      const { vault } = model.data
      const state = model.session.note ? model.session.state : undefined
      const { panes, editorFont, fontSize, lineWidth } = model.preferences
      const sidebar = !panes.sidebarCollapsed
      const list = !panes.listCollapsed
      const variables = [
        `--sidebarWidth: ${sidebar ? panes.sidebarWidth : 0}px`,
        `--sidebar-resizer: ${sidebar ? 4 : 0}px`,
        `--listWidth: ${list ? panes.listWidth : 0}px`,
        `--list-resizer: ${list ? 4 : 0}px`,
        `--editor-font-size: ${fontSize}px`,
        `--editor-max-width: ${lineWidth === 0 ? 'none' : `${lineWidth}px`}`,
        ...(editorFont ? [`--editor-font: ${editorFont}`] : []),
      ].join('; ')
      return (
        <div
          mix={[
            layoutStyle,
            ref((node) => {
              if (node instanceof HTMLElement) layout = node
            }),
          ]}
          data-vault={vault ? 'open' : 'none'}
          style={variables}
        >
          {vault ? (
            <>
              {sidebar ? <Sidebar model={model} /> : null}
              {sidebar ? resizer('sidebarWidth') : null}
              {list ? <NoteList model={model} /> : null}
              {list ? resizer('listWidth') : null}
              <EditorPane model={model} />
            </>
          ) : (
            welcome()
          )}
          <footer mix={statusBarStyle} data-connection={model.connection} data-save-state={state ?? ''}>
            <span role="status">{CONNECTION_LABEL[model.connection]}</span>
            <span mix={statusPathStyle} title={vault?.root}>
              {vault ? `${vault.root} · ${model.data.notes.length} notes` : ''}
            </span>
            <output data-save-status>{state ? SAVE_LABEL[state] : ''}</output>
          </footer>
          <ContextMenuView model={model} />
          <DialogView model={model} />
          {model.importOpen ? <ImportDialog model={model} /> : null}
          {model.preferencesOpen ? <PreferencesDialog model={model} /> : null}
          <NoticeView model={model} />
        </div>
      )
    }
  },
)

const layoutStyle = css({
  display: 'grid',
  gridTemplateColumns: 'var(--sidebarWidth) var(--sidebar-resizer) var(--listWidth) var(--list-resizer) minmax(0, 1fr)',
  gridTemplateRows: 'minmax(0, 1fr) auto',
  gridTemplateAreas: '"sidebar sidebar-resizer list list-resizer editor" "status status status status status"',
  height: '100vh',
  '&[data-vault="none"]': { gridTemplateColumns: '1fr', gridTemplateAreas: '"editor" "status"' },
})

const resizerStyle = css({
  height: 'auto',
  margin: 0,
  border: 0,
  cursor: 'col-resize',
  background: 'var(--border)',
  backgroundClip: 'content-box',
  padding: '0 1.5px',
  touchAction: 'none',
  '&:hover': { background: 'var(--accent)', backgroundClip: 'content-box', padding: 0 },
})

const welcomeStyle = css({ gridArea: 'editor', overflow: 'auto' })

const welcomeActionsStyle = css({ display: 'flex', gap: '8px', marginTop: '8px' })

const recentStyle = css({ width: 'min(480px, 100%)', marginTop: '24px', textAlign: 'left' })

const recentListStyle = css({ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: '4px' })

const recentItemStyle = css({ display: 'flex', gap: '6px' })

const recentButtonStyle = css({
  display: 'grid',
  flex: 1,
  minWidth: 0,
  padding: '6px 10px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { background: 'var(--bg-hover)' },
  '& > span': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' },
})

const statusBarStyle = css({
  gridArea: 'status',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '2px 12px',
  fontSize: '12px',
  color: 'var(--text-muted)',
  background: 'var(--bg-statusbar)',
  borderTop: '1px solid var(--border)',
})

const statusPathStyle = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
