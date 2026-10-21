import type { Handle } from 'remix/component'

import { katexStylesHref } from '../assets.ts'
import { Document } from '../ui/document.tsx'
import type { PreferencesState, WorkspaceData } from './public/workspace/types.ts'
import { Workspace } from './public/workspace/workspace.tsx'

/**
 * The app's only page. The workspace (sidebar, note list, editor, status bar) is one client entry,
 * server-rendered from the vault's current state and hydrated in the browser.
 */
export function HomePage(handle: Handle<{ initial: WorkspaceData; preferences: PreferencesState }>) {
  return () => (
    <Document head={<link rel="stylesheet" href={katexStylesHref} />}>
      <Workspace initial={handle.props.initial} preferences={handle.props.preferences} />
    </Document>
  )
}
