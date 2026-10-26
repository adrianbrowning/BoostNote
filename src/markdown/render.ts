import { randomBytes } from 'node:crypto'
import MarkdownIt, { type Env, type StateCore, type Token } from 'markdown-it'
import footnote from 'markdown-it-footnote'
import sanitizeHtml from 'sanitize-html'

import { renderMath } from '../editor/render/math.ts'
import { parseNoteText } from '../vault/frontmatter.ts'
import { highlight, loadLanguages } from './highlight.ts'
import { mathPlugin } from './math.ts'

export interface RenderOptions {
  /**
   * Replacement URL for a relative image `src` as written in the note (`./todo.assets/x.png`),
   * typically a `data:` URI; `undefined` keeps the link.
   */
  resolveImage?(src: string): Promise<string | undefined>
  /** Replacement for a relative link `href` (`other.md#x` → `other.html#x`); `undefined` keeps it. */
  rewriteLink?(href: string): string | undefined
  /** SVG of a mermaid diagram; a rejection is shown as an error box. Without it, diagrams stay code blocks. */
  renderMermaid?(source: string): Promise<string>
}

export interface RenderedMarkdown {
  /** Sanitised HTML of the body. */
  html: string
  /** Whether KaTeX markup is in `html` (the document then needs KaTeX's stylesheet). */
  hasMath: boolean
}

/** Per-render state handed to the markdown-it rules through `env`. */
interface RenderEnv extends Env {
  /** Trusted HTML (KaTeX, highlighted code, mermaid SVG) inserted after sanitising. */
  slots: string[]
  /** Random per render, so a note cannot forge a slot token. */
  nonce: string
  mermaid: Map<string, { svg: string } | { error: string }>
  hasMath: boolean
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function slot(env: RenderEnv, html: string): string {
  env.slots.push(html)
  return `\uE000${env.nonce}:${env.slots.length - 1}\uE001`
}

const fenceLanguage = (token: Token) => token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

/** `- [ ] item` / `- [x] item`: a disabled checkbox and the classes GitHub uses. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]
    const item = tokens[i - 2]
    if (inline?.type !== 'inline' || tokens[i - 1]?.type !== 'paragraph_open' || item?.type !== 'list_item_open') {
      continue
    }
    const match = /^\[([ xX])\](?: |$)/.exec(inline.content)
    const first = inline.children?.[0]
    if (!match || first?.type !== 'text') continue
    first.content = first.content.slice(match[0].length)
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `
    inline.children?.unshift(checkbox)
    item.attrJoin('class', 'task-list-item')
    for (let j = i - 3; j >= 0; j--) {
      const list = tokens[j]
      if ((list?.type === 'bullet_list_open' || list?.type === 'ordered_list_open') && list.level === item.level - 1) {
        if (!String(list.attrGet('class') ?? '').includes('contains-task-list'))
          list.attrJoin('class', 'contains-task-list')
        break
      }
    }
  }
}

/** GitHub-style heading ids (`## Hello, World` → `hello-world`), numbered when repeated. */
function headingIds(state: StateCore): void {
  const seen = new Map<string, number>()
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]
    if (open?.type !== 'heading_open') continue
    const text = (tokens[i + 1]?.children ?? []).map((child) => child.content).join('')
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-') || 'section'
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    open.attrSet('id', count === 0 ? base : `${base}-${count}`)
  }
}

const md = new MarkdownIt({ html: true, linkify: true })
  .use(footnote)
  .use(mathPlugin)
  .use((parser) => {
    parser.core.ruler.after('inline', 'task_lists', taskLists)
    parser.core.ruler.push('heading_ids', headingIds)
  })

// `env` is always the `RenderEnv` that `renderMarkdown` passes to `parse` and `render`.
md.renderer.rules.math_inline = (tokens, index, _options, env) => {
  const token = tokens[index]
  if (!token) return ''
  const state = env as RenderEnv
  state.hasMath = true
  return slot(state, renderMath(token.content, token.markup === '$$'))
}
md.renderer.rules.math_block = (tokens, index, _options, env) => {
  const token = tokens[index]
  if (!token) return ''
  const state = env as RenderEnv
  state.hasMath = true
  return `<div class="math-block">${slot(state, renderMath(token.content, true))}</div>\n`
}
md.renderer.rules.fence = (tokens, index, _options, env) => {
  const token = tokens[index]
  if (!token) return ''
  const state = env as RenderEnv
  const language = fenceLanguage(token)
  if (language === 'math') {
    state.hasMath = true
    return `<div class="math-block">${slot(state, renderMath(token.content, true))}</div>\n`
  }
  const diagram = language === 'mermaid' ? state.mermaid.get(token.content) : undefined
  if (diagram && 'svg' in diagram) return `<div class="mermaid-diagram">${slot(state, diagram.svg)}</div>\n`
  if (diagram) {
    return slot(
      state,
      `<div class="mermaid-error"><p>Mermaid: ${escapeHtml(diagram.error)}</p><pre><code>${escapeHtml(token.content)}</code></pre></div>\n`,
    )
  }
  const languageClass = language === '' ? '' : ` class="language-${escapeHtml(language)}"`
  return slot(
    state,
    `<pre class="code-block"><code${languageClass}>${highlight(token.content, token.info)}</code></pre>\n`,
  )
}

/** Relative link (no scheme, not `/…`, `//…` or `#…`). */
export function isRelativeUrl(url: string): boolean {
  return url !== '' && !/^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(url)
}

const TEXT_ALIGN = { 'text-align': [/^(?:left|right|center)$/] }

/** Allow-list for raw HTML in notes (and everything markdown-it emits). Scripts, styles, frames, forms and event handlers go. */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'input', 'del', 'ins', 'details', 'summary'],
  allowedAttributes: {
    a: ['href', 'title', 'id'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    input: ['type', 'checked', 'disabled'],
    ol: ['start'],
    details: ['open'],
    th: ['style', 'colspan', 'rowspan'],
    td: ['style', 'colspan', 'rowspan'],
    '*': ['id', 'class'],
  },
  allowedClasses: {
    '*': ['footnote*', 'task-list-item*', 'contains-task-list', 'language-*', 'math-block', 'mermaid-*', 'code-block'],
  },
  allowedStyles: { th: TEXT_ALIGN, td: TEXT_ALIGN },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
}

/**
 * Renders a note to sanitised HTML: GFM (tables, task lists, strikethrough, autolinks), footnotes,
 * heading ids, KaTeX (`$…$`, `$$…$$`, ```` ```math ````, as in the editor), highlighted fenced code and
 * mermaid diagrams. Frontmatter is stripped. Raw HTML passes an allow-list; generated KaTeX, code and
 * SVG are inserted after sanitising.
 */
export async function renderMarkdown(markdown: string, options: RenderOptions = {}): Promise<RenderedMarkdown> {
  const env: RenderEnv = { slots: [], nonce: randomBytes(6).toString('hex'), mermaid: new Map(), hasMath: false }
  const tokens = md.parse(parseNoteText(markdown).body, env)

  const fences = tokens.filter((token) => token.type === 'fence')
  await loadLanguages(fences.map((token) => token.info))
  const { renderMermaid } = options
  if (renderMermaid) {
    // One at a time: the renderer (a hidden window) lays out one diagram after the other anyway.
    for (const token of fences) {
      if (fenceLanguage(token) !== 'mermaid' || env.mermaid.has(token.content)) continue
      env.mermaid.set(
        token.content,
        await renderMermaid(token.content).then(
          (svg) => ({ svg }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        ),
      )
    }
  }

  const images: string[] = []
  const imageToken = (index: number) => `\uE000${env.nonce}:img${index}\uE001`
  const sanitized = sanitizeHtml(md.renderer.render(tokens, md.options, env), {
    ...SANITIZE,
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src ?? ''
        if (!options.resolveImage || !isRelativeUrl(src)) return { tagName, attribs }
        images.push(src)
        return { tagName, attribs: { ...attribs, src: imageToken(images.length - 1) } }
      },
      a: (tagName, attribs) => {
        const href = attribs.href
        const next = href !== undefined && isRelativeUrl(href) ? options.rewriteLink?.(href) : undefined
        return { tagName, attribs: next === undefined ? attribs : { ...attribs, href: next } }
      },
      input: (tagName, attribs) => ({ tagName, attribs: { ...attribs, disabled: '' } }),
    },
  })

  const resolved = await Promise.all(
    images.map(async (src) => (await options.resolveImage?.(src).catch(() => undefined)) ?? src),
  )
  const html = sanitized.replace(new RegExp(`\uE000${env.nonce}:(img)?(\\d+)\uE001`, 'g'), (_whole, img, index) => {
    const i = Number(index)
    return img ? escapeHtml(resolved[i] ?? '') : (env.slots[i] ?? '')
  })
  return { html, hasMath: env.hasMath }
}

/** `other.md#x` → `other.html#x`: links between notes of an exported folder. Anything else: `undefined`. */
export function noteLinkToHtml(href: string): string | undefined {
  const match = /^([^?#]*?)\.md((?:[?#].*)?)$/i.exec(href)
  return match ? `${match[1]}.html${match[2]}` : undefined
}
