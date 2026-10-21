import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'

import { FocusEditorEvent, type SortKey, type WorkspaceModel } from './model.ts'
import { NOTE_DRAG_TYPE } from './sidebar.tsx'
import { button, emptyState, formatDate, iconButton, input, muted } from './styles.ts'
import type { NoteSummary } from './types.ts'

const SORT_OPTIONS: Array<[key: SortKey, label: string]> = [
  ['updated', 'Updated'],
  ['created', 'Created'],
  ['title', 'Title'],
]

/** Search, sort and the notes of the current sidebar selection (or the trash). */
export function NoteList(handle: Handle<{ model: WorkspaceModel }>) {
  let listNode: HTMLElement | undefined

  const scrollSelectedIntoView = () => {
    handle.queueTask(() => listNode?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
  }

  const renderNote = (note: NoteSummary) => {
    const { model } = handle.props
    const selected = model.openId === note.id
    return (
      <div
        key={note.id}
        role="option"
        tabIndex={-1}
        aria-selected={selected ? 'true' : 'false'}
        data-note={note.id}
        draggable="true"
        mix={[
          itemStyle,
          on('click', (event) => void model.openNote(note.id, { newTab: event.metaKey || event.ctrlKey })),
          on('mousedown', (event) => {
            // Middle button: no autoscroll, the note opens in a new tab on `auxclick`.
            if (event.button === 1) event.preventDefault()
          }),
          on('auxclick', (event) => {
            if (event.button !== 1) return
            event.preventDefault()
            void model.openNote(note.id, { newTab: true })
          }),
          on('contextmenu', (event) => {
            event.preventDefault()
            model.openMenu(event.clientX, event.clientY, model.noteMenu(note.id))
          }),
          on<HTMLElement, 'dragstart'>('dragstart', (event) => {
            event.dataTransfer?.setData(NOTE_DRAG_TYPE, note.id)
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
          }),
        ]}
      >
        <div mix={itemTitleStyle}>
          {note.starred ? (
            <span mix={starStyle} title="Starred">
              ★
            </span>
          ) : null}
          {note.title}
        </div>
        {note.excerpt ? <div mix={excerptStyle}>{note.excerpt}</div> : null}
        <div mix={metaStyle}>
          <time dateTime={note.updated}>{formatDate(model.sort === 'created' ? note.created : note.updated)}</time>
          {note.tags.map((tag) => (
            <span key={tag} mix={tagStyle}>
              #{tag}
            </span>
          ))}
        </div>
      </div>
    )
  }

  const renderTrash = () => {
    const { model } = handle.props
    const items = model.data.trash
    if (items.length === 0) {
      return (
        <div mix={emptyState}>
          <p mix={muted}>The Trash is empty.</p>
        </div>
      )
    }
    return (
      <ul mix={itemsStyle} aria-label="Trash">
        {items.map((item) => (
          <li key={item.id} data-trash={item.id} mix={[itemStyle, trashItemStyle]}>
            <div mix={itemTitleStyle}>
              {item.kind === 'folder' ? '📁 ' : ''}
              {item.title ?? item.originalPath}
            </div>
            <div mix={metaStyle}>
              <span>{item.originalPath}</span>
              <span>Deleted {formatDate(item.deletedAt)}</span>
            </div>
            <div>
              <button type="button" mix={[button, on('click', () => void model.restore(item.id))]}>
                Restore
              </button>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return () => {
    const { model } = handle.props
    const inTrash = model.selection.kind === 'trash'
    const notes = inTrash ? [] : model.visibleNotes
    return (
      <section aria-label="Notes" mix={paneStyle}>
        <header mix={headerStyle}>
          <div mix={titleRowStyle}>
            <h2 mix={titleStyle}>{model.selectionTitle}</h2>
            {inTrash ? (
              <button
                type="button"
                mix={[button, on('click', () => void model.emptyTrash())]}
                disabled={model.data.trash.length === 0}
              >
                Empty Trash
              </button>
            ) : (
              <button
                type="button"
                mix={[iconButton, on('click', () => void model.newNote())]}
                aria-label="New note"
                title="New note (⌘N)"
                data-new-note
              >
                ✎
              </button>
            )}
          </div>
          {inTrash ? null : (
            <div mix={toolsStyle}>
              <input
                type="search"
                placeholder="Search notes"
                aria-label="Search notes"
                value={model.query}
                mix={[input, on('input', (event) => model.setQuery(event.currentTarget.value))]}
              />
              <select
                aria-label="Sort notes"
                mix={[
                  input,
                  sortStyle,
                  on('change', (event) => {
                    const value = event.currentTarget.value
                    const option = SORT_OPTIONS.find(([key]) => key === value)
                    if (option) model.setSort(option[0])
                  }),
                ]}
                disabled={model.hits !== null}
                title={model.hits !== null ? 'Search results are sorted by relevance' : undefined}
              >
                {SORT_OPTIONS.map(([key, label]) => (
                  <option key={key} value={key} selected={model.sort === key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </header>
        {inTrash ? (
          renderTrash()
        ) : notes.length === 0 ? (
          <div mix={emptyState}>
            <p mix={muted}>{model.hits !== null ? 'No matching notes.' : 'No notes here yet.'}</p>
            {model.hits === null ? (
              <button type="button" mix={[button, on('click', () => void model.newNote())]}>
                New note
              </button>
            ) : null}
          </div>
        ) : (
          <div
            role="listbox"
            aria-label={`Notes in ${model.selectionTitle}`}
            tabIndex={0}
            mix={[
              itemsStyle,
              ref((node) => {
                if (node instanceof HTMLElement) listNode = node
              }),
              on('keydown', (event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  model.moveSelection(event.key === 'ArrowDown' ? 1 : -1)
                  scrollSelectedIntoView()
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  model.dispatchEvent(new FocusEditorEvent(false))
                }
              }),
            ]}
          >
            {notes.map(renderNote)}
          </div>
        )}
      </section>
    )
  }
}

const paneStyle = css({
  gridArea: 'list',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  background: 'var(--bg-list)',
})

const headerStyle = css({
  display: 'grid',
  gap: '6px',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
})

const titleRowStyle = css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' })

const titleStyle = css({
  fontSize: '13px',
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const toolsStyle = css({ display: 'flex', gap: '6px' })

const sortStyle = css({ width: 'auto', flex: 'none' })

const itemsStyle = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  overflow: 'auto',
  flex: 1,
  '&:focus-visible': { outlineOffset: '-2px' },
})

const itemStyle = css({
  display: 'grid',
  gap: '2px',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  cursor: 'default',
  '&:hover': { background: 'var(--bg-hover)' },
  '&[aria-selected="true"]': { background: 'var(--bg-selected)' },
})

const trashItemStyle = css({ gap: '6px' })

const itemTitleStyle = css({
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const starStyle = css({ color: '#e8b923', marginRight: '4px' })

const excerptStyle = css({
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  fontSize: '12px',
  color: 'var(--text-muted)',
})

const metaStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  fontSize: '11px',
  color: 'var(--text-muted)',
})

const tagStyle = css({ color: 'var(--accent-strong)' })
