import { openSearchPanel } from '@codemirror/search'
import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'

import { createLivePreviewEditor, type EditorTheme } from '../../../../editor/index.ts'
import { client, vaultAssetUrl } from './api.ts'
import type { WorkspaceModel } from './model.ts'
import { parentOf, resolveNoteLink } from './paths.ts'
import { PropertiesPanel } from './properties.tsx'
import { ReaderPane } from './reader-pane.tsx'
import { button, emptyState, emptyTitle, iconButton, input, muted, primaryButton } from './styles.ts'
import { TabStrip } from './tab-strip.tsx'
import { type TaskProgress, taskProgress } from './tasks.ts'

/**
 * The open note: its name (the file name, or the frontmatter `title` when it has one), renamed in
 * place by clicking it (or F2/Enter), note actions, the conflict bar, and the live-preview editor.
 * The editor is created once and shows whatever note the session holds; it only ever sees the body.
 */
export function EditorPane(handle: Handle<{ model: WorkspaceModel }>) {
  const session = () => handle.props.model.session
  // Task progress of the open note's body; recomputed on each edit, re-rendered only when it moves.
  let progress: TaskProgress = taskProgress(session().body)
  const updateProgress = (body: string) => {
    const next = taskProgress(body)
    if (next.total === progress.total && next.completed === progress.completed) return
    progress = next
    void handle.update()
  }

  const onOpenLink = (href: string) => {
    const { model } = handle.props
    if (/^https?:\/\//i.test(href)) {
      void model.attempt(() => client.openExternal(href))
      return
    }
    const from = session().note?.id
    const target = from === undefined ? undefined : resolveNoteLink(from, href)
    if (target === undefined) return
    if (model.data.notes.some((note) => note.id === target)) void model.openNote(target)
    else model.notify('error', `Note not found: ${target}`)
  }

  const mountEditor = ref((node, signal) => {
    // `data-editor` is a <div>; ref callbacks are typed with the generic `Element`.
    const parent = node as HTMLElement
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const theme = (): EditorTheme => (scheme.matches ? 'dark' : 'light')
    const instance = createLivePreviewEditor({
      parent,
      doc: session().body,
      theme: theme(),
      onChange: (doc) => {
        session().edit(doc)
        updateProgress(doc)
      },
      resolveAssetUrl: (relPath) => {
        const id = session().note?.id
        return id === undefined ? relPath : vaultAssetUrl(id, relPath)
      },
      saveAsset: async (file) => {
        const id = session().note?.id
        if (id === undefined) throw new Error('No note is open')
        return (await client.uploadAsset(id, file)).href
      },
      onOpenLink,
    })
    scheme.addEventListener('change', () => instance.setTheme(theme()), { signal })
    session().addEventListener(
      'doc',
      (event) => {
        instance.setDoc(event.body, { preserveSelection: event.preserveSelection })
        updateProgress(event.body)
      },
      { signal },
    )
    handle.props.model.addEventListener(
      'find',
      () => {
        instance.focus()
        openSearchPanel(instance.view)
      },
      { signal },
    )
    handle.props.model.addEventListener(
      'focus-editor',
      (event) => {
        handle.queueTask(() => {
          if (event.atEnd) instance.view.dispatch({ selection: { anchor: instance.view.state.doc.length } })
          instance.focus()
        })
      },
      { signal },
    )
    // Leaving the editor saves right away instead of waiting for the autosave delay.
    parent.addEventListener(
      'focusout',
      (event) => {
        if (!(event.relatedTarget instanceof Node && parent.contains(event.relatedTarget))) void session().flush()
      },
      { signal },
    )
    signal.addEventListener('abort', () => {
      instance.destroy()
    })
  })

  const noteMenu = (rect: DOMRect) => {
    const { model } = handle.props
    const id = model.openId
    if (!id) return
    model.openMenu(rect.right - 180, rect.bottom + 4, model.noteMenu(id))
  }

  /** Inline rename: the id of the note whose name is being edited, the draft and the last error. */
  let renaming: string | null = null
  let draft = ''
  let renameError = ''

  const startRename = () => {
    const note = session().note
    if (!note) return
    renaming = note.id
    draft = note.title
    renameError = ''
    void handle.update()
  }

  const endRename = async (commit: boolean) => {
    const id = renaming
    if (id === null) return
    renaming = null
    if (!commit || id !== session().note?.id) {
      renameError = ''
      void handle.update()
      return
    }
    void handle.update()
    const error = await handle.props.model.renameOpenNote(draft)
    renameError = error ?? ''
    // Keep editing after a refusal so the name can be fixed.
    if (error !== null) renaming = session().note?.id ?? null
    void handle.update()
  }

  const nameView = (note: { id: string; title: string; frontmatter: Record<string, unknown> }) => {
    const fromTitle = typeof note.frontmatter.title === 'string' && note.frontmatter.title.trim() !== ''
    const hint = fromTitle
      ? 'Name from the frontmatter “title” — editing it changes the title, not the file name'
      : 'Rename (click, F2 or Enter)'
    if (renaming !== note.id) {
      return (
        <h1 mix={titleStyle} data-note-title data-name-source={fromTitle ? 'title' : 'file'}>
          <button
            type="button"
            mix={[
              titleButtonStyle,
              on('click', startRename),
              on('keydown', (event) => {
                if (event.key !== 'F2') return
                event.preventDefault()
                startRename()
              }),
            ]}
            title={hint}
            data-rename-note
          >
            {note.title}
          </button>
        </h1>
      )
    }
    return (
      <input
        aria-label={fromTitle ? 'Note title' : 'Note name'}
        title={hint}
        value={draft}
        aria-invalid={renameError ? 'true' : undefined}
        data-note-title-input
        mix={[
          input,
          titleInputStyle,
          ref((node) => {
            if (!(node instanceof HTMLInputElement) || document.activeElement === node) return
            node.focus()
            node.select()
          }),
          on('input', (event) => {
            // Controlled input: re-render with the new value or Remix restores the old one.
            draft = event.currentTarget.value
            void handle.update()
          }),
          on('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void endRename(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              void endRename(false)
            }
          }),
          on('blur', () => void endRename(true)),
        ]}
      />
    )
  }

  const conflictBar = () => {
    const current = session()
    if (current.state === 'conflict') {
      return (
        <div role="alert" mix={barStyle} data-conflict="changed">
          <span>This note changed on disk while you were editing it.</span>
          <button type="button" mix={[button, primaryButton, on('click', () => void current.keepMine())]}>
            Keep mine
          </button>
          <button type="button" mix={[button, on('click', () => current.loadTheirs())]}>
            Load theirs
          </button>
        </div>
      )
    }
    if (current.state === 'removed') {
      return (
        <div role="alert" mix={barStyle} data-conflict="removed">
          <span>This note was moved or deleted outside Boostnote.</span>
          <button type="button" mix={[button, primaryButton, on('click', () => void current.keepMine())]}>
            Save my copy
          </button>
          <button
            type="button"
            mix={[button, on('click', () => void handle.props.model.closeTab(undefined, { discard: true }))]}
          >
            Close
          </button>
        </div>
      )
    }
    if (current.state === 'error') {
      return (
        <div role="alert" mix={barStyle} data-conflict="error">
          <span>Saving failed: {current.error}</span>
          <button type="button" mix={[button, on('click', () => void current.flush())]}>
            Retry
          </button>
        </div>
      )
    }
    return null
  }

  return () => {
    const { model } = handle.props
    const note = session().note
    const folder = note ? parentOf(note.id) : ''
    const active = model.tabs.active
    const reader = active?.kind === 'reader' ? active : undefined
    return (
      <main mix={paneStyle} aria-label="Editor">
        {model.tabs.tabs.length > 0 ? <TabStrip model={model} /> : null}
        {reader ? <ReaderPane model={model} tab={reader} /> : null}
        {note ? (
          <header mix={headerStyle}>
            <div mix={titleBlockStyle}>
              {nameView(note)}
              {renameError && renaming === note.id ? (
                <div role="alert" mix={renameErrorStyle} data-rename-error>
                  {renameError}
                </div>
              ) : null}
              <div mix={[muted, pathStyle]} title={note.id}>
                {folder === '' ? model.data.vault?.name : folder} · {note.id.slice(note.id.lastIndexOf('/') + 1)}
              </div>
            </div>
            <button
              type="button"
              mix={[iconButton, on('click', () => model.togglePane('propertiesOpen'))]}
              aria-pressed={model.preferences.panes.propertiesOpen ? 'true' : 'false'}
              aria-label="Properties"
              title="Properties (⇧⌘P)"
              data-toggle-properties
            >
              ⓘ
            </button>
            <button
              type="button"
              mix={[iconButton, starButtonStyle, on('click', () => void model.toggleStar())]}
              aria-pressed={note.starred ? 'true' : 'false'}
              aria-label={note.starred ? 'Unstar note' : 'Star note'}
              title={note.starred ? 'Unstar' : 'Star'}
            >
              {note.starred ? '★' : '☆'}
            </button>
            <button
              type="button"
              mix={[iconButton, on('click', (event) => noteMenu(event.currentTarget.getBoundingClientRect()))]}
              aria-label="Note actions"
            >
              ⋯
            </button>
          </header>
        ) : null}
        {note ? conflictBar() : null}
        {note && progress.total > 0 ? (
          <div
            mix={progressStyle}
            role="progressbar"
            aria-label="Tasks done"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.completed}
            aria-valuetext={`${progress.completed} of ${progress.total} tasks done`}
            title={`${progress.completed} of ${progress.total} tasks done`}
            data-task-progress={progress.percent}
          >
            <div mix={progressFillStyle} style={{ width: `${progress.percent}%` }} />
            <span mix={progressTextStyle}>
              {progress.completed}/{progress.total} · {progress.percent}%
            </span>
          </div>
        ) : null}
        {note || reader ? null : (
          <div mix={emptyState}>
            {model.data.notes.length === 0 ? (
              <>
                <h1 mix={emptyTitle}>This vault is empty</h1>
                <p mix={muted}>Create a note to get started.</p>
              </>
            ) : (
              <>
                <h1 mix={emptyTitle}>No note selected</h1>
                <p mix={muted}>Pick a note from the list, or create one.</p>
              </>
            )}
            <button type="button" mix={[button, primaryButton, on('click', () => void model.newNote())]}>
              New note
            </button>
          </div>
        )}
        <div mix={bodyStyle} hidden={note ? undefined : true}>
          <div
            mix={[editorHostStyle, mountEditor]}
            data-rmx-preserve-dom
            data-editor
            hidden={note ? undefined : true}
          />
          {note && model.preferences.panes.propertiesOpen ? <PropertiesPanel model={model} /> : null}
        </div>
      </main>
    )
  }
}

const paneStyle = css({
  gridArea: 'editor',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  background: 'var(--bg)',
})

const headerStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 16px',
  borderBottom: '1px solid var(--border)',
})

const titleBlockStyle = css({ flex: 1, minWidth: 0 })

const titleStyle = css({
  fontSize: '15px',
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const titleButtonStyle = css({
  maxWidth: '100%',
  padding: '0 6px',
  margin: '0 -6px',
  border: '1px solid transparent',
  borderRadius: '4px',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  cursor: 'text',
  '&:hover': { borderColor: 'var(--border)' },
})

const titleInputStyle = css({ fontSize: '15px', fontWeight: 600, padding: '0 6px' })

const renameErrorStyle = css({ color: 'var(--danger)', fontSize: '12px' })

const pathStyle = css({ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })

const starButtonStyle = css({ fontSize: '16px', '&[aria-pressed="true"]': { color: '#e8b923' } })

const progressStyle = css({
  position: 'relative',
  height: '16px',
  background: 'var(--bg-hover)',
  borderBottom: '1px solid var(--border)',
  overflow: 'hidden',
})

const progressFillStyle = css({
  position: 'absolute',
  inset: '0 auto 0 0',
  background: 'var(--accent)',
  opacity: 0.75,
  transition: 'width 150ms ease-out',
})

const progressTextStyle = css({
  position: 'relative',
  display: 'block',
  fontSize: '11px',
  lineHeight: '16px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
})

const barStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 16px',
  background: 'var(--warning-bg)',
  borderBottom: '1px solid var(--warning-border)',
  '& > span': { flex: 1 },
})

const bodyStyle = css({ display: 'flex', flex: 1, minHeight: 0, '&[hidden]': { display: 'none' } })

const editorHostStyle = css({
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  '&[hidden]': { display: 'none' },
  '& .cm-editor': { height: '100%' },
})
