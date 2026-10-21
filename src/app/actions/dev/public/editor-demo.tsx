import type { Handle } from 'remix/component'
import { clientEntry, css, on, ref } from 'remix/component'

import { createLivePreviewEditor, type EditorTheme, type LivePreviewEditor } from '../../../../editor/index.ts'

/** Mounts the editor with in-memory callbacks and shows the markdown source it produces. */
export const EditorDemo = clientEntry(import.meta.url, function EditorDemo(handle: Handle<{ doc: string }>) {
  let theme: EditorTheme = 'light'
  let source = handle.props.doc
  let lastLink = 'none'
  let editor: LivePreviewEditor | undefined
  let renderTimer: number | undefined

  const mountEditor = ref((node, signal) => {
    editor = createLivePreviewEditor({
      parent: node as HTMLElement,
      doc: source,
      theme,
      // Debounced like a real caller (autosave); also keeps bursts of keystrokes to one render.
      onChange(doc) {
        source = doc
        clearTimeout(renderTimer)
        renderTimer = window.setTimeout(() => handle.update(), 100)
      },
      resolveAssetUrl: (relPath) => relPath,
      // In-memory stand-in for the vault: the image lives as long as the page.
      saveAsset: async (file) => URL.createObjectURL(file),
      onOpenLink(href) {
        lastLink = href
        handle.update()
      },
    })
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(renderTimer)
        editor?.destroy()
      },
      { once: true },
    )
  })

  const toggleTheme = () => {
    theme = theme === 'light' ? 'dark' : 'light'
    editor?.setTheme(theme)
    handle.update()
  }

  return () => (
    <div mix={layoutStyle} data-theme={theme}>
      <header mix={toolbarStyle}>
        <strong>Editor demo</strong>
        <button type="button" mix={on('click', toggleTheme)}>
          Theme: {theme}
        </button>
        <span>
          Last opened link: <output data-testid="last-link">{lastLink}</output>
        </span>
      </header>
      <div mix={[editorStyle, mountEditor]} data-rmx-preserve-dom data-testid="editor" />
      <pre mix={sourceStyle} data-testid="source">
        {source}
      </pre>
    </div>
  )
})

const layoutStyle = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
  gridTemplateRows: 'auto minmax(0, 1fr)',
  height: '100%',
})

const toolbarStyle = css({
  gridColumn: '1 / -1',
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  padding: '6px 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: '12px',
})

const editorStyle = css({ overflow: 'hidden', minHeight: 0 })

const sourceStyle = css({
  margin: 0,
  padding: '12px',
  overflow: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  borderLeft: '1px solid var(--border)',
  background: 'var(--bg-list)',
})
