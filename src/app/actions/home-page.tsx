import { css } from 'remix/component'

import { routes } from '../routes.ts'
import { Document } from '../ui/document.tsx'
import { StatusBar } from '../ui/public/status-bar.tsx'

/** The workspace frame: sidebar, note list and editor regions above a status bar. */
export function HomePage() {
  return () => (
    <Document>
      <div mix={layoutStyle}>
        <nav aria-label="Vault" mix={sidebarStyle}>
          <h2 mix={paneHeadingStyle}>Vault</h2>
          <p mix={mutedStyle}>No vault open</p>
        </nav>
        <section aria-label="Notes" mix={listStyle}>
          <h2 mix={paneHeadingStyle}>Notes</h2>
          <p mix={mutedStyle}>Open a vault to see its notes.</p>
        </section>
        <main mix={editorStyle}>
          <div mix={emptyStateStyle}>
            <h1 mix={emptyTitleStyle}>No vault open</h1>
            <p mix={mutedStyle}>A vault is a folder of Markdown notes.</p>
          </div>
        </main>
        <StatusBar eventsHref={routes.events.href()} />
      </div>
    </Document>
  )
}

const layoutStyle = css({
  display: 'grid',
  gridTemplateColumns: '220px 280px minmax(0, 1fr)',
  gridTemplateRows: 'minmax(0, 1fr) auto',
  gridTemplateAreas: '"sidebar list editor" "status status status"',
  height: '100vh',
})

const sidebarStyle = css({
  gridArea: 'sidebar',
  background: 'var(--bg-sidebar)',
  borderRight: '1px solid var(--border)',
  padding: '12px',
  overflow: 'auto',
})

const listStyle = css({
  gridArea: 'list',
  background: 'var(--bg-list)',
  borderRight: '1px solid var(--border)',
  padding: '12px',
  overflow: 'auto',
})

const editorStyle = css({
  gridArea: 'editor',
  display: 'grid',
  placeItems: 'center',
  overflow: 'auto',
})

const paneHeadingStyle = css({
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: '8px',
})

const mutedStyle = css({ color: 'var(--text-muted)' })

const emptyStateStyle = css({ textAlign: 'center' })

const emptyTitleStyle = css({ fontSize: '20px', fontWeight: 600, marginBottom: '4px' })
