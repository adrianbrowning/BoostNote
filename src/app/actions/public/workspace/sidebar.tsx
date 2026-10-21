import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import type { MenuEntry, Selection, WorkspaceModel } from './model.ts'
import { iconButton, muted, paneHeading } from './styles.ts'
import type { FolderSummary } from './types.ts'

/** Drag payload types: a note id from the list, a folder id from the tree. */
export const NOTE_DRAG_TYPE = 'application/x-boostnote-note'
export const FOLDER_DRAG_TYPE = 'application/x-boostnote-folder'

function isSelected(selection: Selection, other: Selection): boolean {
  return JSON.stringify(selection) === JSON.stringify(other)
}

/** Vault switcher, smart lists, folder tree (drop target for notes and folders), tags and trash. */
export function Sidebar(handle: Handle<{ model: WorkspaceModel }>) {
  let dropTarget: string | null = null

  const vaultMenu = (rect: DOMRect) => {
    const { model } = handle.props
    const current = model.data.vault?.root
    const recent: MenuEntry[] = model.data.recent
      .filter((vault) => vault.root !== current)
      .map((vault) => ({ kind: 'action', label: vault.name, run: () => void model.openVault(vault.root) }))
    model.openMenu(rect.left, rect.bottom + 4, [
      ...recent,
      ...(recent.length > 0 ? [{ kind: 'separator' } as const] : []),
      { kind: 'action', label: 'Open Folder…', run: () => void model.pickVault() },
      { kind: 'action', label: 'Import Boostnote Storage…', run: () => model.setImportOpen(true) },
      { kind: 'separator' },
      { kind: 'action', label: 'Close Vault', run: () => void model.closeVault() },
    ])
  }

  const folderMenu = (folder: FolderSummary, x: number, y: number) => {
    const { model } = handle.props
    const isRoot = folder.id === ''
    model.openMenu(x, y, [
      { kind: 'action', label: 'New Note', run: () => void model.newNote(folder.id) },
      { kind: 'action', label: 'New Folder…', run: () => void model.newFolder(folder.id) },
      { kind: 'action', label: 'Export as HTML…', run: () => void model.exportFolder(folder.id) },
      ...(isRoot
        ? []
        : ([
            { kind: 'separator' },
            { kind: 'action', label: 'Rename…', run: () => void model.renameFolder(folder.id) },
            { kind: 'colors', current: folder.color, pick: (color) => void model.setFolderColor(folder.id, color) },
            { kind: 'separator' },
            { kind: 'action', label: 'Move to Trash', danger: true, run: () => void model.deleteFolder(folder.id) },
          ] satisfies MenuEntry[])),
    ])
  }

  const setDropTarget = (id: string | null) => {
    if (dropTarget === id) return
    dropTarget = id
    void handle.update()
  }

  /** Drag-over/drop handlers that make a folder row accept notes and other folders. */
  const dropHandlers = (folderId: string) => [
    on<HTMLElement, 'dragover'>('dragover', (event) => {
      const types = event.dataTransfer?.types ?? []
      if (!types.includes(NOTE_DRAG_TYPE) && !types.includes(FOLDER_DRAG_TYPE)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      setDropTarget(folderId)
    }),
    on<HTMLElement, 'dragleave'>('dragleave', () => setDropTarget(null)),
    on<HTMLElement, 'drop'>('drop', (event) => {
      event.preventDefault()
      setDropTarget(null)
      const { model } = handle.props
      const note = event.dataTransfer?.getData(NOTE_DRAG_TYPE)
      const folder = event.dataTransfer?.getData(FOLDER_DRAG_TYPE)
      if (note) void model.moveNote(note, folderId)
      else if (folder) void model.moveFolder(folder, folderId)
    }),
  ]

  const renderFolder = (folder: FolderSummary, depth: number) => {
    const { model } = handle.props
    const isRoot = folder.id === ''
    const expanded = isRoot || model.expanded.has(folder.id)
    const selection: Selection = { kind: 'folder', id: folder.id }
    const count = model.data.notes.filter((note) => note.folder === folder.id).length
    return (
      <li key={folder.id}>
        <div
          mix={[
            rowStyle,
            folderRowStyle,
            ...dropHandlers(folder.id),
            on('contextmenu', (event) => {
              event.preventDefault()
              folderMenu(folder, event.clientX, event.clientY)
            }),
            on<HTMLElement, 'dragstart'>('dragstart', (event) => {
              if (isRoot || !event.dataTransfer) return
              event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id)
              event.dataTransfer.effectAllowed = 'move'
            }),
          ]}
          style={`--depth: ${depth}`}
          data-folder={folder.id}
          data-selected={isSelected(model.selection, selection) ? 'true' : undefined}
          data-drop-target={dropTarget === folder.id ? 'true' : undefined}
          draggable={isRoot ? undefined : 'true'}
        >
          {folder.folders.length > 0 && !isRoot ? (
            <button
              type="button"
              mix={[twistyStyle, on('click', () => model.toggleExpanded(folder.id))]}
              aria-label={`${folder.name} subfolders`}
              aria-expanded={expanded ? 'true' : 'false'}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span mix={twistyStyle} />
          )}
          <button
            type="button"
            mix={[rowButtonStyle, on('click', () => model.select(selection))]}
            title={isRoot ? 'Notes at the top of the vault' : folder.id}
          >
            <span
              mix={swatchStyle}
              style={folder.color ? `background: ${folder.color}` : undefined}
              aria-hidden="true"
            />
            <span mix={labelStyle}>{folder.name}</span>
            <span mix={countStyle}>{count}</span>
          </button>
          <button
            type="button"
            mix={[iconButton, hoverOnlyStyle, on('click', (event) => folderMenu(folder, event.clientX, event.clientY))]}
            aria-label={`Folder actions for ${folder.name}`}
          >
            ⋯
          </button>
        </div>
        {expanded && folder.folders.length > 0 ? (
          <ul mix={treeStyle}>{folder.folders.map((child) => renderFolder(child, isRoot ? depth : depth + 1))}</ul>
        ) : null}
      </li>
    )
  }

  const smartRow = (label: string, selection: Selection, count: number, icon: string) => {
    const { model } = handle.props
    return (
      <li key={label}>
        <div mix={rowStyle} data-selected={isSelected(model.selection, selection) ? 'true' : undefined}>
          <button
            type="button"
            mix={[rowButtonStyle, on('click', () => model.select(selection))]}
            data-sidebar={selection.kind}
          >
            <span mix={iconStyle} aria-hidden="true">
              {icon}
            </span>
            <span mix={labelStyle}>{label}</span>
            <span mix={countStyle}>{count}</span>
          </button>
        </div>
      </li>
    )
  }

  return () => {
    const { model } = handle.props
    const { vault, tree, notes, trash } = model.data
    const tags = model.tags
    return (
      <nav aria-label="Vault" mix={sidebarStyle}>
        <button
          type="button"
          mix={[vaultButtonStyle, on('click', (event) => vaultMenu(event.currentTarget.getBoundingClientRect()))]}
          title={vault?.root}
          data-vault-switcher
        >
          <span mix={labelStyle}>{vault?.name}</span>
          <span aria-hidden="true">▾</span>
        </button>
        <ul mix={listStyle}>
          {smartRow('All notes', { kind: 'all' }, notes.length, '≡')}
          {smartRow('Starred', { kind: 'starred' }, notes.filter((note) => note.starred).length, '★')}
        </ul>
        <div mix={sectionHeaderStyle}>
          <h2 mix={paneHeading}>Folders</h2>
          <button
            type="button"
            mix={[iconButton, on('click', () => void model.newFolder(''))]}
            aria-label="New folder"
            title="New folder"
          >
            +
          </button>
        </div>
        {tree ? (
          <ul aria-label="Folders" mix={listStyle}>
            {renderFolder(tree, 0)}
          </ul>
        ) : null}
        {tags.length > 0 ? (
          <>
            <div mix={sectionHeaderStyle}>
              <h2 mix={paneHeading}>Tags</h2>
            </div>
            <ul mix={listStyle} aria-label="Tags">
              {tags.map(([tag, count]) => (
                <li key={`tag:${tag}`}>
                  <div
                    mix={rowStyle}
                    data-selected={isSelected(model.selection, { kind: 'tag', tag }) ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      mix={[rowButtonStyle, on('click', () => model.select({ kind: 'tag', tag }))]}
                      data-tag={tag}
                    >
                      <span mix={iconStyle} aria-hidden="true">
                        #
                      </span>
                      <span mix={labelStyle}>{tag}</span>
                      <span mix={countStyle}>{count}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <ul mix={[listStyle, trashListStyle]}>{smartRow('Trash', { kind: 'trash' }, trash.length, '🗑')}</ul>
        {notes.length === 0 && tree?.folders.length === 0 ? <p mix={[muted, hintStyle]}>This vault is empty.</p> : null}
      </nav>
    )
  }
}

const sidebarStyle = css({
  gridArea: 'sidebar',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0,
  padding: '8px',
  overflow: 'auto',
  background: 'var(--bg-sidebar)',
  userSelect: 'none',
})

const vaultButtonStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  padding: '6px 8px',
  marginBottom: '6px',
  border: 0,
  borderRadius: '6px',
  background: 'transparent',
  fontWeight: 600,
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { background: 'var(--bg-hover)' },
})

const listStyle = css({ listStyle: 'none', margin: 0, padding: 0 })
const treeStyle = css({ listStyle: 'none', margin: 0, padding: 0 })
const trashListStyle = css({ marginTop: 'auto', paddingTop: '8px' })

const sectionHeaderStyle = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 8px 2px',
})

const rowStyle = css({
  display: 'flex',
  alignItems: 'center',
  borderRadius: '6px',
  '&:hover': { background: 'var(--bg-hover)' },
  '&[data-selected]': { background: 'var(--bg-selected)' },
  '&[data-drop-target]': { outline: '2px dashed var(--accent)', outlineOffset: '-2px' },
})

const folderRowStyle = css({ paddingLeft: 'calc(var(--depth) * 14px)' })

const rowButtonStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flex: 1,
  minWidth: 0,
  padding: '3px 6px',
  border: 0,
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
})

const twistyStyle = css({
  display: 'inline-grid',
  placeItems: 'center',
  width: '16px',
  flex: 'none',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'var(--text-muted)',
  fontSize: '10px',
  cursor: 'pointer',
})

const swatchStyle = css({
  width: '10px',
  height: '10px',
  flex: 'none',
  borderRadius: '3px',
  border: '1px solid var(--border)',
})

const iconStyle = css({ width: '14px', flex: 'none', textAlign: 'center', color: 'var(--text-muted)' })

const labelStyle = css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })

const countStyle = css({ flex: 'none', fontSize: '11px', color: 'var(--text-muted)' })

const hoverOnlyStyle = css({ visibility: 'hidden', '*:hover > &': { visibility: 'visible' } })

const hintStyle = css({ padding: '4px 8px', fontSize: '12px' })
