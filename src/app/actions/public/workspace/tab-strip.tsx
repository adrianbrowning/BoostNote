import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import type { WorkspaceModel } from './model.ts'
import { iconButton } from './styles.ts'

/** Drag payload of a tab being reordered (its key). */
const TAB_DRAG_TYPE = 'application/x-boostnote-tab'

/** Middle mouse button (`MouseEvent.button`). */
const MIDDLE_BUTTON = 1

/**
 * Back/forward of the active tab and the tab strip: click activates, middle-click or × closes,
 * drag and drop reorders. Tabs show their note's title (file name when the list doesn't know it).
 */
export function TabStrip(handle: Handle<{ model: WorkspaceModel }>) {
  let dropKey: number | null = null

  const setDropKey = (key: number | null) => {
    if (dropKey === key) return
    dropKey = key
    void handle.update()
  }

  return () => {
    const { model } = handle.props
    const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
    const mod = mac ? '⌘' : 'Ctrl+'
    return (
      <div mix={stripStyle}>
        <button
          type="button"
          mix={[iconButton, on('click', () => void model.goBack())]}
          disabled={!model.tabs.canGoBack()}
          aria-label="Back"
          title={`Back (${mod}[)`}
          data-back
        >
          ←
        </button>
        <button
          type="button"
          mix={[iconButton, on('click', () => void model.goForward())]}
          disabled={!model.tabs.canGoForward()}
          aria-label="Forward"
          title={`Forward (${mod}])`}
          data-forward
        >
          →
        </button>
        <div role="tablist" aria-label="Open notes" mix={tabListStyle}>
          {model.tabs.tabs.map((tab, index) => {
            const title =
              model.data.notes.find((note) => note.id === tab.path)?.title ??
              tab.path.slice(tab.path.lastIndexOf('/') + 1)
            const active = tab.key === model.tabs.activeKey
            return (
              <div
                key={tab.key}
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active ? 'true' : 'false'}
                title={tab.path}
                draggable="true"
                data-tab={tab.path}
                data-drop-target={dropKey === tab.key ? 'true' : undefined}
                mix={[
                  tabStyle,
                  on('click', () => void model.activateTab(tab.key)),
                  on('mousedown', (event) => {
                    // No autoscroll on middle-click.
                    if (event.button === MIDDLE_BUTTON) event.preventDefault()
                  }),
                  on('auxclick', (event) => {
                    if (event.button !== MIDDLE_BUTTON) return
                    event.preventDefault()
                    void model.closeTab(tab.key)
                  }),
                  on<HTMLElement, 'dragstart'>('dragstart', (event) => {
                    event.dataTransfer?.setData(TAB_DRAG_TYPE, String(tab.key))
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                  }),
                  on<HTMLElement, 'dragover'>('dragover', (event) => {
                    if (!event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropKey(tab.key)
                  }),
                  on<HTMLElement, 'dragleave'>('dragleave', () => setDropKey(null)),
                  on<HTMLElement, 'dragend'>('dragend', () => setDropKey(null)),
                  on<HTMLElement, 'drop'>('drop', (event) => {
                    event.preventDefault()
                    setDropKey(null)
                    const key = Number(event.dataTransfer?.getData(TAB_DRAG_TYPE))
                    if (Number.isInteger(key)) model.moveTab(key, index)
                  }),
                ]}
              >
                <span mix={tabTitleStyle}>{title}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  mix={[
                    closeStyle,
                    on('click', (event) => {
                      event.stopPropagation()
                      void model.closeTab(tab.key)
                    }),
                  ]}
                  aria-label={`Close ${title}`}
                  title={`Close tab (${mod}W)`}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}

const stripStyle = css({
  display: 'flex',
  alignItems: 'stretch',
  gap: '2px',
  minHeight: '32px',
  padding: '0 6px',
  background: 'var(--bg-list)',
  borderBottom: '1px solid var(--border)',
  '& > button': { alignSelf: 'center' },
  '& > button:disabled': { opacity: 0.35, cursor: 'default' },
})

const tabListStyle = css({ display: 'flex', flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' })

const tabStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  flex: '0 1 180px',
  minWidth: '80px',
  padding: '0 4px 0 10px',
  borderRight: '1px solid var(--border)',
  fontSize: '12px',
  color: 'var(--text-muted)',
  cursor: 'default',
  userSelect: 'none',
  '&:hover': { background: 'var(--bg-hover)' },
  '&[aria-selected="true"]': {
    background: 'var(--bg)',
    color: 'var(--text)',
    boxShadow: 'inset 0 2px 0 var(--accent)',
  },
  '&[data-drop-target]': { boxShadow: 'inset 2px 0 0 var(--accent)' },
})

const tabTitleStyle = css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })

const closeStyle = css({
  display: 'inline-grid',
  placeItems: 'center',
  width: '18px',
  height: '18px',
  padding: 0,
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  visibility: 'hidden',
  '[aria-selected="true"] > &, *:hover > &': { visibility: 'visible' },
  '&:hover': { background: 'var(--bg-hover)' },
})
