import type { Handle, RemixNode } from 'remix/component'
import { ImportMap } from 'remix/component/server'
import { getContext } from 'remix/middleware/async-context'
import { getCspNonce } from 'remix/middleware/csp'

import { baseStylesHref, scriptEntry } from '../assets.ts'
import { vendorImportMap } from '../vendor.ts'

export interface DocumentProps {
  children?: RemixNode
  head?: RemixNode
  title?: string
}

/** The HTML shell every page renders through: base styles, import map and the browser entry. */
export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, head, title = 'Boostnote' } = handle.props
    const { href, importMap, preloads } = scriptEntry
    // `render()` stamps the nonce on the import map and its own tags; these authored ones need it here.
    const nonce = getCspNonce(getContext())

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{title}</title>
          <link rel="stylesheet" href={baseStylesHref} />
          {head}
          <ImportMap value={{ ...importMap, imports: { ...importMap.imports, ...vendorImportMap.imports } }} />
          {preloads.map((preloadHref) => (
            <link key={preloadHref} rel="modulepreload" href={preloadHref} nonce={nonce} />
          ))}
          <script type="module" src={href} nonce={nonce}></script>
        </head>
        <body>{children}</body>
      </html>
    )
  }
}
