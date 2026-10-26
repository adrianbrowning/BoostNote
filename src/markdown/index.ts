/**
 * Markdown → standalone HTML for export, printing and PDF. Plain Node (no Electron); mermaid
 * rendering needs a DOM, so callers inject `renderMermaid` (the app uses a hidden window).
 */
export { htmlDocument, katexStylesheet } from './document.ts'
export { type ExportOptions, exportFolderHtml, exportNoteMarkdown, noteToHtml } from './export.ts'
export { isRelativeUrl, noteLinkToHtml, type RenderedMarkdown, type RenderOptions, renderMarkdown } from './render.ts'
