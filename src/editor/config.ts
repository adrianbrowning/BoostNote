import { Facet } from '@codemirror/state'

export type EditorTheme = 'light' | 'dark'

/** Host callbacks the editor extensions call into. Provided once per editor. */
export interface EditorHost {
  /** Maps a note-relative asset path (`./note.assets/x.png`) to a URL the renderer can load. */
  resolveAssetUrl(relPath: string): string
  /** Stores a pasted/dropped/picked image and returns the note-relative path to reference. */
  saveAsset(file: File): Promise<string>
  /** Opens a link the user Cmd/Ctrl-clicked (or clicked in a rendered widget). */
  onOpenLink(href: string): void
}

const noopHost: EditorHost = {
  resolveAssetUrl: (relPath) => relPath,
  saveAsset: () => Promise.reject(new Error('Saving assets is not supported here')),
  onOpenLink: () => {},
}

export const editorHost = Facet.define<EditorHost, EditorHost>({
  combine: (values) => values[0] ?? noopHost,
})

/** The active colour theme. Widgets that render themed output (mermaid) read it. */
export const editorTheme = Facet.define<EditorTheme, EditorTheme>({
  combine: (values) => values[0] ?? 'light',
})

/** `http:`, `data:`, `blob:`, … and protocol-relative/absolute paths are used as-is; everything else is note-relative. */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('/')
}
