import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Typography of exported notes; colours are the editor's light palette (`src/editor/theme.ts`). */
const EXPORT_STYLES = `
:root { color-scheme: light; }
body { margin: 0; background: #ffffff; color: #1f2328;
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
.note { max-width: 46rem; margin: 0 auto; padding: 32px 24px 64px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; font-weight: 700; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h6 { color: #656d76; }
p, ul, ol, blockquote, pre, table, .math-block, .mermaid-diagram { margin: 0 0 1em; }
a { color: #0969da; }
img { max-width: 100%; }
hr { border: 0; border-top: 2px solid #d8dee4; margin: 1.5em 0; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #d8dee4; color: #656d76; }
code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: #f4f5f7; border-radius: 4px; padding: 0.1em 0.3em; }
pre { background: #f4f5f7; border-radius: 6px; padding: 12px 16px; overflow-x: auto; line-height: 1.5; }
table { border-collapse: collapse; }
th, td { border: 1px solid #d8dee4; padding: 4px 10px; }
th { background: #f4f5f7; font-weight: 600; }
.task-list-item { list-style: none; }
.task-list-item-checkbox { margin: 0 0.4em 0 -1.3em; accent-color: #1ec38b; }
.math-block { overflow-x: auto; }
.mermaid-diagram { text-align: center; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
.mermaid-error { border: 1px solid #cf222e; border-radius: 6px; padding: 8px 12px; }
.mermaid-error p { color: #cf222e; margin: 0 0 0.5em; }
.footnotes { font-size: 0.9em; color: #656d76; }
.syn-keyword { color: #cf222e; } .syn-string { color: #0a3069; } .syn-number { color: #0550ae; }
.syn-comment { color: #6e7781; font-style: italic; } .syn-function { color: #8250df; }
.syn-type { color: #953800; } .syn-property { color: #0550ae; } .syn-tag { color: #116329; }
.syn-invalid { color: #cf222e; }
.index ul { padding-left: 1.2em; }
@media print {
  .note { max-width: none; padding: 0; }
  pre, table, .math-block, .mermaid-diagram, img { break-inside: avoid; }
}
`

let katexStyles: Promise<string> | undefined

/**
 * KaTeX's stylesheet with its WOFF2 fonts inlined as `data:` URIs (the other formats dropped), so
 * exported files render math without network or file access.
 */
export function katexStylesheet(): Promise<string> {
  katexStyles ??= (async () => {
    const cssFile = fileURLToPath(import.meta.resolve('katex/dist/katex.min.css'))
    const css = await readFile(cssFile, 'utf8')
    const fonts = new Map<string, string>()
    for (const [, name] of css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)) {
      if (name && !fonts.has(name)) {
        const data = await readFile(path.join(path.dirname(cssFile), 'fonts', name))
        fonts.set(name, `data:font/woff2;base64,${data.toString('base64')}`)
      }
    }
    return css.replace(/src:url\(fonts\/([\w-]+\.woff2)\) format\("woff2"\)[^;}]*/g, (_whole, name: string) => {
      return `src:url(${fonts.get(name)}) format("woff2")`
    })
  })()
  return katexStyles
}

export interface HtmlDocumentInput {
  title: string
  /** Sanitised body HTML (`renderMarkdown().html`). */
  body: string
  /** Inline KaTeX's stylesheet and fonts. */
  math: boolean
  /** Extra class on the content wrapper (`index` for folder indexes). */
  className?: string
}

/**
 * A standalone HTML page: inline styles only and a CSP that forbids scripts and remote fetches other
 * than images, so an exported note renders the same offline, in a browser or in the PDF printer.
 */
export async function htmlDocument({ title, body, math, className }: HtmlDocumentInput): Promise<string> {
  const csp = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data:"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="generator" content="Boostnote">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_STYLES}</style>
${math ? `<style>${await katexStylesheet()}</style>\n` : ''}</head>
<body>
<main class="note${className ? ` ${className}` : ''}">
${body}</main>
</body>
</html>
`
}
