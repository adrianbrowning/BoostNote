import { mermaidRendererEntry } from '../assets.ts'
import { EntryHead } from '../ui/entry-head.tsx'

/**
 * `GET /export/mermaid`: an empty page whose only script defines `window.boostRenderMermaid`. The
 * main process loads it in a hidden window to lay out diagrams for export (`src/main/export.ts`).
 */
export function MermaidRendererPage() {
  return () => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Mermaid renderer</title>
        <EntryHead entry={mermaidRendererEntry} />
      </head>
      <body></body>
    </html>
  )
}
