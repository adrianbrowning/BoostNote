import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

import { type EditorTheme, editorTheme } from './config.ts'

/**
 * Colours, scoped to the editor so a light/dark editor stays coherent whatever the page uses. The base
 * values match `src/app/ui/public/base.css`. Hosts tune layout with inherited custom properties:
 * `--editor-font`, `--editor-font-size`, `--editor-line-height`, `--editor-max-width` (line width) and
 * `--editor-padding`.
 *
 * `--lp-code-bg` is a translucent tint, not a solid colour: CodeMirror draws the selection in a layer
 * behind the text, so a solid code-block or inline-code background would hide the selection.
 */
const PALETTES: Record<EditorTheme, Record<string, string>> = {
  light: {
    '--lp-bg': '#ffffff',
    '--lp-text': '#1f2328',
    '--lp-muted': '#656d76',
    '--lp-border': '#d8dee4',
    '--lp-accent': '#1ec38b',
    '--lp-focus': '#0969da',
    '--lp-link': '#0969da',
    '--lp-code-bg': 'rgba(31, 35, 40, 0.05)',
    '--lp-selection': '#b6d7ff',
    '--lp-quote': '#8c959f',
    '--lp-error': '#cf222e',
    '--lp-tooltip-bg': '#ffffff',
    '--lp-tooltip-active': '#e7f0fd',
    '--lp-syn-keyword': '#cf222e',
    '--lp-syn-string': '#0a3069',
    '--lp-syn-number': '#0550ae',
    '--lp-syn-comment': '#6e7781',
    '--lp-syn-function': '#8250df',
    '--lp-syn-type': '#953800',
    '--lp-syn-property': '#0550ae',
    '--lp-syn-tag': '#116329',
  },
  dark: {
    '--lp-bg': '#1e2124',
    '--lp-text': '#e6e8eb',
    '--lp-muted': '#9198a1',
    '--lp-border': '#2f3338',
    '--lp-accent': '#1ec38b',
    '--lp-focus': '#4493f8',
    '--lp-link': '#4493f8',
    '--lp-code-bg': 'rgba(230, 232, 235, 0.04)',
    '--lp-selection': '#264f78',
    '--lp-quote': '#6e7681',
    '--lp-error': '#ff7b72',
    '--lp-tooltip-bg': '#26292d',
    '--lp-tooltip-active': '#1f3a5f',
    '--lp-syn-keyword': '#ff7b72',
    '--lp-syn-string': '#a5d6ff',
    '--lp-syn-number': '#79c0ff',
    '--lp-syn-comment': '#8b949e',
    '--lp-syn-function': '#d2a8ff',
    '--lp-syn-type': '#ffa657',
    '--lp-syn-property': '#79c0ff',
    '--lp-syn-tag': '#7ee787',
  },
}

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace)'

const baseTheme = EditorView.baseTheme({
  '&': {
    backgroundColor: 'var(--lp-bg)',
    color: 'var(--lp-text)',
    fontSize: 'var(--editor-font-size, 16px)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font, var(--font-ui, system-ui, -apple-system, "Segoe UI", sans-serif))',
    lineHeight: 'var(--editor-line-height, 1.65)',
  },
  '.cm-content': {
    maxWidth: 'var(--editor-max-width, 46rem)',
    width: '100%',
    margin: '0 auto',
    padding: 'var(--editor-padding, 32px 24px 40vh)',
    caretColor: 'var(--lp-text)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--lp-text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--lp-selection) !important',
  },
  '.cm-line': { padding: '0 2px' },

  '.cm-lp-heading': { fontWeight: '700', lineHeight: '1.3' },
  '.cm-lp-h1': { fontSize: '1.85em', paddingTop: '0.6em', paddingBottom: '0.15em' },
  '.cm-lp-h2': { fontSize: '1.5em', paddingTop: '0.5em', paddingBottom: '0.1em' },
  '.cm-lp-h3': { fontSize: '1.25em', paddingTop: '0.4em' },
  '.cm-lp-h4': { fontSize: '1.1em', paddingTop: '0.3em' },
  '.cm-lp-h5, .cm-lp-h6': { fontSize: '1em', paddingTop: '0.3em' },
  '.cm-lp-h6': { color: 'var(--lp-muted)' },

  '.cm-lp-link': {
    color: 'var(--lp-link)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-lp-inline-code': {
    fontFamily: MONO,
    fontSize: '0.88em',
    backgroundColor: 'var(--lp-code-bg)',
    borderRadius: '4px',
    padding: '1px 3px',
  },
  '.cm-lp-blockquote': {
    borderLeft: '3px solid var(--lp-border)',
    paddingLeft: '14px !important',
    color: 'var(--lp-muted)',
  },
  '.cm-lp-bullet': { color: 'var(--lp-muted)', display: 'inline-block', width: '0.9em' },
  '.cm-lp-list-mark': { color: 'var(--lp-muted)' },
  '.cm-lp-checkbox': {
    margin: '0 0.45em 0 0',
    verticalAlign: '-0.12em',
    width: '1em',
    height: '1em',
    accentColor: 'var(--lp-accent)',
    cursor: 'pointer',
  },
  '.cm-lp-task-done': { color: 'var(--lp-muted)', textDecoration: 'line-through' },
  '.cm-lp-hr': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
    border: 'none',
    borderTop: '2px solid var(--lp-border)',
    margin: '0',
  },
  '.cm-lp-image': { maxWidth: '100%', verticalAlign: 'bottom', borderRadius: '4px', cursor: 'text' },
  '.cm-lp-image-broken': {
    minWidth: '2em',
    minHeight: '1.2em',
    outline: '1px dashed var(--lp-error)',
  },

  '.cm-lp-codeblock': {
    fontFamily: MONO,
    fontSize: '0.88em',
    backgroundColor: 'var(--lp-code-bg)',
    paddingLeft: '12px !important',
    paddingRight: '12px !important',
  },
  '.cm-lp-codeblock-first': { borderTopLeftRadius: '6px', borderTopRightRadius: '6px', paddingTop: '4px' },
  '.cm-lp-codeblock-last': { borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px', paddingBottom: '4px' },
  '.cm-lp-code-lang': {
    float: 'right',
    fontFamily: 'var(--font-ui, system-ui, sans-serif)',
    fontSize: '0.8em',
    color: 'var(--lp-muted)',
    userSelect: 'none',
  },

  '.cm-lp-math-block': { textAlign: 'center', padding: '0.5em 0', overflowX: 'auto' },
  '.cm-lp-table': { overflowX: 'auto', padding: '0.4em 0' },
  '.cm-lp-table table': { borderCollapse: 'collapse', minWidth: '50%' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid var(--lp-border)', padding: '4px 10px' },
  '.cm-lp-table th': { backgroundColor: 'var(--lp-code-bg)', fontWeight: '600' },
  '.cm-lp-table code': { fontFamily: MONO, fontSize: '0.88em' },
  '.cm-lp-table a': { color: 'var(--lp-link)' },
  '.cm-lp-mermaid': { display: 'flex', justifyContent: 'center', padding: '0.5em 0', overflowX: 'auto' },
  '.cm-lp-mermaid svg': { maxWidth: '100%', height: 'auto' },
  '.cm-lp-mermaid-loading': { color: 'var(--lp-muted)', fontStyle: 'italic' },
  '.cm-lp-mermaid-error': {
    display: 'block',
    color: 'var(--lp-error)',
    border: '1px solid var(--lp-error)',
    borderRadius: '6px',
    padding: '8px 12px',
  },
  '.cm-lp-mermaid-error pre': { margin: '4px 0 0', whiteSpace: 'pre-wrap', fontFamily: MONO, fontSize: '0.85em' },

  '.cm-tooltip': {
    backgroundColor: 'var(--lp-tooltip-bg)',
    color: 'var(--lp-text)',
    border: '1px solid var(--lp-border)',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
  },
  '.cm-tooltip.cm-lp-slash-menu > ul': {
    fontFamily: 'var(--font-ui, system-ui, sans-serif)',
    maxHeight: '18em',
    minWidth: '14em',
  },
  '.cm-tooltip.cm-lp-slash-menu > ul > li': { padding: '4px 10px', lineHeight: '1.5' },
  '.cm-tooltip.cm-lp-slash-menu > ul > li[aria-selected]': {
    backgroundColor: 'var(--lp-tooltip-active)',
    color: 'var(--lp-text)',
  },
  '.cm-lp-slash-menu .cm-completionDetail': { float: 'right', color: 'var(--lp-muted)', fontStyle: 'normal' },
  '.cm-panels': { backgroundColor: 'var(--lp-code-bg)', color: 'var(--lp-text)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--lp-border)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 200, 0, 0.35)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 140, 0, 0.5)' },
})

const highlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: MONO },
  { tag: t.quote, color: 'var(--lp-muted)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--lp-muted)' },
  { tag: t.url, color: 'var(--lp-muted)' },
  { tag: t.link, color: 'var(--lp-link)' },
  { tag: t.special(t.string), fontFamily: MONO, color: 'var(--lp-syn-function)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--lp-syn-keyword)' },
  { tag: [t.string, t.regexp, t.character], color: 'var(--lp-syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--lp-syn-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--lp-syn-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--lp-syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--lp-syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--lp-syn-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--lp-syn-tag)' },
  { tag: t.invalid, color: 'var(--lp-error)' },
])

/** Everything that depends on the active theme; lives in a compartment so `setTheme` can swap it. */
export function themeExtension(theme: EditorTheme): Extension {
  return [editorTheme.of(theme), EditorView.theme({ '&': PALETTES[theme] }, { dark: theme === 'dark' })]
}

export const editorStyles: Extension = [baseTheme, syntaxHighlighting(highlightStyle)]
