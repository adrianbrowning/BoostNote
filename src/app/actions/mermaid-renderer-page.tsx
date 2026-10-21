import { ImportMap } from 'remix/component/server'
import { getContext } from 'remix/middleware/async-context'

import { mermaidRendererEntry } from '../assets.ts'
import { CspNonce } from '../middleware/content-security-policy.ts'
import { vendorImportMap } from '../vendor.ts'

/**
 * `GET /export/mermaid`: an empty page whose only script defines `window.boostRenderMermaid`. The
 * main process loads it in a hidden window to lay out diagrams for export (`src/main/export.ts`).
 */
export function MermaidRendererPage() {
  return () => {
    const { href, importMap, preloads } = mermaidRendererEntry
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <title>Mermaid renderer</title>
          <ImportMap
            value={{ ...importMap, imports: { ...importMap.imports, ...vendorImportMap.imports } }}
            nonce={getContext().get(CspNonce)}
          />
          {preloads.map((preloadHref) => (
            <link key={preloadHref} rel="modulepreload" href={preloadHref} />
          ))}
          <script type="module" src={href}></script>
        </head>
        <body></body>
      </html>
    )
  }
}
