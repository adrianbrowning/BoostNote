// Ambient declarations for browser modules imported by paths their packages don't type.

declare module 'mermaid/dist/mermaid.esm.min.mjs' {
  import type { Mermaid } from 'mermaid'

  const mermaid: Mermaid
  export default mermaid
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
  export const highlightedCodeBlock: TurndownService.Plugin
}
