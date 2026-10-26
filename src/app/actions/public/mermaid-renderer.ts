// The hidden window that lays out mermaid diagrams for export (`src/main/export.ts`). Mermaid needs a
// real DOM to measure text, so the main process loads this page in an invisible window and calls
// `window.boostRenderMermaid(source)` via `executeJavaScript`. It renders exactly like the editor.
import { renderMermaid } from '../../../editor/render/mermaid.ts'

declare global {
  interface Window {
    boostRenderMermaid?: (source: string) => Promise<string>
  }
}

window.boostRenderMermaid = async (source) => {
  const result = await renderMermaid(source, 'light')
  if ('error' in result) throw new Error(result.error)
  return result.svg
}
