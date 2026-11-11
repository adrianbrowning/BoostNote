import type { Handle, RemixNode } from 'remix/component'

import { baseStylesHref, scriptEntry } from '../assets.ts'
import { EntryHead } from './entry-head.tsx'

export interface DocumentProps {
  children?: RemixNode
  head?: RemixNode
  title?: string
}

/** The HTML shell every page renders through: base styles, import map and the browser entry. */
export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, head, title = 'Boostnote' } = handle.props

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{title}</title>
          <link rel="stylesheet" href={baseStylesHref} />
          {head}
          <EntryHead entry={scriptEntry} />
        </head>
        <body>{children}</body>
      </html>
    )
  }
}
