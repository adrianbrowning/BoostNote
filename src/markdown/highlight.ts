import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightCode, tags as t, tagHighlighter } from '@lezer/highlight'

/**
 * Token classes for exported code blocks. The tag groups and colours (`EXPORT_STYLES`) mirror the
 * editor's highlight style (`src/editor/theme.ts`), so code looks the same in the app and in exports.
 */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], class: 'syn-keyword' },
  { tag: [t.string, t.regexp, t.character], class: 'syn-string' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'syn-number' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'syn-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'syn-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'syn-type' },
  { tag: [t.propertyName, t.attributeName], class: 'syn-property' },
  { tag: [t.tagName, t.angleBracket], class: 'syn-tag' },
  { tag: t.invalid, class: 'syn-invalid' },
])

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The language of a fence info string (`js`, `TypeScript`, `py {.class}`), if CodeMirror knows it. */
export function findLanguage(info: string): LanguageDescription | undefined {
  const name = info.trim().split(/\s+/)[0] ?? ''
  return name === '' ? undefined : (LanguageDescription.matchLanguageName(languages, name, true) ?? undefined)
}

/** Loads the parsers of every language in `infos` (they are loaded lazily, like in the editor). */
export async function loadLanguages(infos: Iterable<string>): Promise<void> {
  const pending = new Set<LanguageDescription>()
  for (const info of infos) {
    const language = findLanguage(info)
    if (language && !language.support) pending.add(language)
  }
  await Promise.all([...pending].map((language) => language.load().catch(() => undefined)))
}

/** Escaped HTML of `code` with `<span class="syn-…">` tokens; plain escaped text for unknown or unloaded languages. */
export function highlight(code: string, info: string): string {
  const support: LanguageSupport | undefined = findLanguage(info)?.support
  if (!support) return escapeHtml(code)
  let html = ''
  highlightCode(
    code,
    support.language.parser.parse(code),
    highlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text)
    },
    () => {
      html += '\n'
    },
  )
  return html
}
