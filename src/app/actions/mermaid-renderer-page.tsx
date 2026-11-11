import { ImportMap } from 'remix/component/server'
import { getContext } from 'remix/middleware/async-context'
import { getCspNonce } from 'remix/middleware/csp'

import { mermaidRendererEntry } from '../assets.ts'
import { vendorImportMap } from '../vendor.ts'

/**
 * `GET /export/mermaid`: an empty page whose only script defines `window.boostRenderMermaid`. The
 * main process loads it in a hidden window to lay out diagrams for export (`src/main/export.ts`).
 */
export function MermaidRendererPage() {
  return () => {
    const { href, importMap, preloads } = mermaidRendererEntry
    // `render()` stamps the nonce on the import map; these authored tags need it here.
    const nonce = getCspNonce(getContext())
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <title>Mermaid renderer</title>
          <ImportMap value={{ ...importMap, imports: { ...importMap.imports, ...vendorImportMap.imports } }} />
          {preloads.map((preloadHref) => (
            <link key={preloadHref} rel="modulepreload" href={preloadHref} nonce={nonce} />
          ))}
          <script type="module" src={href} nonce={nonce}></script>
        </head>
        <body></body>
      </html>
    )
  }
}
