import type { Handle } from 'remix/component'
import { css, on, ref, unsafeHTML } from 'remix/component'

import { DARK_SCHEME, pageTheme } from '../../../../editor/index.ts'
import { mermaidNodes, renderMermaid } from '../../../../editor/render/mermaid.ts'
import { client } from './api.ts'
import type { WorkspaceModel } from './model.ts'
import { button } from './styles.ts'
import type { ReaderTab } from './tabs.ts'

/**
 * The active reader tab: an outside `.md` shown read-only, with a banner naming the file (its base
 * name only), an "Add to vault…" button (main imports the file and its images into a folder of the
 * open vault and the tab becomes the new note's tab; disabled, with the reason, without an open
 * vault), an "Open folder as vault" button (main opens the file's folder as the vault and the tab
 * becomes the note's tab) and a Close button that closes the tab and so revokes its ticket. The
 * HTML was rendered and sanitised by `src/markdown/render.ts` in main. http(s) links open in the
 * browser as in notes; every other link (relative `.md` files, anchors into other files) is inert.
 * Mermaid code blocks become diagrams in the page, rendered as in the editor (`renderDiagrams`).
 */
export function ReaderPane(handle: Handle<{ model: WorkspaceModel; tab: ReaderTab }>) {
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link) return
    // Never let the page itself navigate away.
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) void handle.props.model.attempt(() => client.openExternal(href))
  }
  let article: HTMLElement | undefined

  return () => {
    const { model, tab } = handle.props
    const reader = model.reader?.ticket === tab.ticket ? model.reader.document : null
    const noVault = model.data.vault === null
    // A render that changes the HTML puts its code blocks back, so every render upgrades them.
    if (reader) handle.queueTask(() => article && renderDiagrams(article))
    return (
      <section mix={paneStyle} aria-label={`${tab.name} (read only)`} data-reader>
        <div role="note" mix={bannerStyle} data-reader-banner>
          <span>{tab.name} is not in a vault</span>
          {noVault ? (
            <small id={`reader-add-reason-${tab.key}`} data-reader-add-reason>
              Open a vault to add this file to it
            </small>
          ) : null}
          <button
            type="button"
            disabled={noVault}
            aria-describedby={noVault ? `reader-add-reason-${tab.key}` : undefined}
            mix={[button, on('click', () => void model.addReaderToVault(tab.key))]}
            data-reader-add
          >
            Add to vault…
          </button>
          <button
            type="button"
            mix={[button, on('click', () => void model.openReaderFolder(tab.key))]}
            data-reader-open-folder
          >
            Open folder as vault
          </button>
          <button type="button" mix={[button, on('click', () => void model.closeTab(tab.key))]} data-reader-close>
            Close
          </button>
        </div>
        {reader ? (
          <article
            mix={[
              articleStyle,
              on<HTMLElement, 'click'>('click', onClick),
              ref((node, signal) => {
                if (!(node instanceof HTMLElement)) return
                article = node
                window.matchMedia(DARK_SCHEME).addEventListener('change', () => renderDiagrams(node), { signal })
              }),
            ]}
            innerHTML={unsafeHTML(reader.html)}
            data-reader-body
          />
        ) : null}
      </section>
    )
  }
}

/**
 * Replaces the mermaid code blocks of the reader's HTML (`src/markdown/render.ts` leaves them as
 * code) with their diagrams, in the page's colour scheme, and renders again the diagrams drawn in
 * another scheme (each keeps its source and theme). A diagram that fails keeps its code block, or
 * its earlier drawing.
 */
function renderDiagrams(article: HTMLElement): void {
  const theme = pageTheme()
  const draw = (source: string, target: Element, insert: (nodes: DocumentFragment) => void) =>
    void renderMermaid(source, theme).then((result) => {
      if (!target.isConnected || !('svg' in result)) return
      // The colour scheme changed while this rendered: drop it; the render started by the change
      // draws the diagram in the new scheme.
      if (pageTheme() !== theme) return
      insert(mermaidNodes(result.svg))
    })
  for (const code of article.querySelectorAll('pre > code.language-mermaid')) {
    const block = code.parentElement
    if (!block) continue
    const source = code.textContent ?? ''
    draw(source, block, (nodes) => {
      const diagram = document.createElement('div')
      diagram.className = 'mermaid-diagram'
      diagram.dataset.source = source
      diagram.dataset.theme = theme
      diagram.append(nodes)
      block.replaceWith(diagram)
    })
  }
  for (const diagram of article.querySelectorAll<HTMLElement>('.mermaid-diagram[data-source]')) {
    if (diagram.dataset.theme === theme) continue
    draw(diagram.dataset.source ?? '', diagram, (nodes) => {
      diagram.dataset.theme = theme
      diagram.replaceChildren(nodes)
    })
  }
}

const paneStyle = css({ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 })

const bannerStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 16px',
  background: 'var(--warning-bg)',
  borderBottom: '1px solid var(--warning-border)',
  '& > span': { flex: 1 },
})

const articleStyle = css({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: '24px 32px 64px',
  fontSize: 'var(--editor-font-size)',
  lineHeight: 1.65,
  '& > *': { maxWidth: 'var(--editor-max-width)', marginLeft: 'auto', marginRight: 'auto' },
  '& h1, & h2, & h3, & h4, & h5, & h6': { lineHeight: 1.25, margin: '1.4em auto 0.6em' },
  '& p, & ul, & ol, & blockquote, & pre, & table, & .math-block, & .mermaid-diagram': { marginBottom: '1em' },
  '& a': { color: 'var(--accent)' },
  '& img': { maxWidth: '100%' },
  '& blockquote': { paddingLeft: '1em', borderLeft: '3px solid var(--border)', color: 'var(--text-muted)' },
  '& code, & pre': { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' },
  '& pre': { padding: '12px 16px', overflowX: 'auto', background: 'var(--bg-hover)', borderRadius: '6px' },
  '& :not(pre) > code': { padding: '0.1em 0.3em', background: 'var(--bg-hover)', borderRadius: '4px' },
  '& table': { borderCollapse: 'collapse' },
  '& th, & td': { padding: '4px 10px', border: '1px solid var(--border)' },
  '& .task-list-item': { listStyle: 'none' },
  '& .math-block': { overflowX: 'auto' },
  '& .mermaid-diagram': { textAlign: 'center' },
  '& .mermaid-diagram svg': { maxWidth: '100%', height: 'auto' },
})
