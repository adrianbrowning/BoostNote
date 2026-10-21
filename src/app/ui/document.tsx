import type { Handle, RemixNode } from 'remix/component'
import { ImportMap } from 'remix/component/server'
import { getContext } from 'remix/middleware/async-context'

import { baseStylesHref, scriptEntry } from '../assets.ts'
import { CspNonce } from '../middleware/content-security-policy.ts'

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
    // The runtime copies this nonce onto import maps it adds for later client entries.
    const nonce = getContext().get(CspNonce)

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{title}</title>
          <link rel="stylesheet" href={baseStylesHref} />
          {head}
          <ImportMap value={importMap} nonce={nonce} />
          {preloads.map((preloadHref) => (
            <link key={preloadHref} rel="modulepreload" href={preloadHref} />
          ))}
          <script type="module" src={href}></script>
        </head>
        <body>{children}</body>
      </html>
    )
  }
}
