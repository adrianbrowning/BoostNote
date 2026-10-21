import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  exportFolderHtml,
  exportNoteMarkdown,
  noteLinkToHtml,
  noteToHtml,
  renderMarkdown,
} from '../../src/markdown/index.ts'
import { openVault, type Vault } from '../../src/vault/index.ts'

const html = async (markdown: string, options?: Parameters<typeof renderMarkdown>[1]) =>
  (await renderMarkdown(markdown, options)).html

describe('renderMarkdown', () => {
  it('strips frontmatter and renders GFM', async () => {
    const out = await html(
      '---\ntitle: x\ntags: [a]\n---\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n~~gone~~ and https://example.com\n',
    )
    expect(out).not.toContain('title: x')
    expect(out).toContain('<table>')
    expect(out).toContain('<td style="text-align:right">2</td>')
    expect(out).toContain('<s>gone</s>')
    expect(out).toContain('<a href="https://example.com">https://example.com</a>')
  })

  it('renders task lists as disabled checkboxes', async () => {
    const out = await html('- [ ] todo\n- [x] done\n- plain\n')
    expect(out).toContain('<ul class="contains-task-list">')
    expect(out).toMatch(
      /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled \/?>\s*todo/,
    )
    expect(out).toMatch(/<input type="checkbox" class="task-list-item-checkbox" disabled checked \/?>\s*done/)
    expect(out).toContain('<li>plain</li>')
  })

  it('gives headings unique GitHub-style ids', async () => {
    const out = await html('# Hello, World!\n## Hello, World!\n### Café `code`\n')
    expect(out).toContain('<h1 id="hello-world">')
    expect(out).toContain('<h2 id="hello-world-1">')
    expect(out).toContain('<h3 id="café-code">')
  })

  it('renders math with the editor syntax', async () => {
    const result = await renderMarkdown('Inline $x^2$, money $5 and $6.\n\n$$\n\\frac{a}{b}\n$$\n\n```math\ny\n```\n')
    expect(result.hasMath).toBe(true)
    const out = result.html
    expect(out.match(/class="katex"/g)).toHaveLength(3)
    expect(out.match(/class="katex-display"/g)).toHaveLength(2)
    expect(out).toContain('money $5 and $6.')
    expect(out).toContain('<mfrac>')
    expect((await renderMarkdown('no math')).hasMath).toBe(false)
  })

  it('renders footnotes', async () => {
    const out = await html('Text[^1].\n\n[^1]: The note.\n')
    expect(out).toContain('class="footnote-ref"')
    expect(out).toContain('<li id="fn1" class="footnote-item">')
  })

  it('highlights fenced code like the editor', async () => {
    const out = await html('```js\nconst x = "s" // c\n```\n\n```nolang\n<b>\n```\n')
    expect(out).toContain('<code class="language-js"><span class="syn-keyword">const</span>')
    expect(out).toContain('<span class="syn-string">&quot;s&quot;</span>'.replace(/&quot;/g, '"'))
    expect(out).toContain('<span class="syn-comment">// c</span>')
    expect(out).toContain('<code class="language-nolang">&lt;b&gt;\n</code>')
  })

  it('sanitises raw HTML with an allow-list', async () => {
    const out = await html(
      '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a>' +
        '<iframe src="https://e.com"></iframe><input type="text"><span class="evil" style="color:red">s</span>' +
        '<details open><summary>S</summary>D</details>\n',
    )
    expect(out).not.toMatch(/<script|onerror|javascript:|<iframe|type="text"|evil|style=/)
    expect(out).toContain('<img src="x.png" />'.replace(' />', ''))
    expect(out).toContain('<a>x</a>')
    expect(out).toContain('<details open><summary>S</summary>D</details>')
    expect(out).toContain('<span>s</span>')
  })

  it('does not let a note forge trusted slots', async () => {
    const out = await html('\uE000abc:0\uE001 $x$')
    expect(out).toContain('\uE000abc:0\uE001')
  })

  it('renders mermaid through the injected renderer and shows errors', async () => {
    const sources: string[] = []
    const out = await html(
      '```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nbroken\n```\n\n```mermaid\ngraph TD; A-->B\n```\n',
      {
        async renderMermaid(source) {
          sources.push(source)
          if (source.startsWith('broken')) throw new Error('Parse error')
          return '<svg id="m"><g onclick="x"></g></svg>'
        },
      },
    )
    expect(sources).toEqual(['graph TD; A-->B\n', 'broken\n'])
    expect(out.match(/<div class="mermaid-diagram"><svg id="m">/g)).toHaveLength(2)
    expect(out).toContain(
      '<div class="mermaid-error"><p>Mermaid: Parse error</p><pre><code>broken\n</code></pre></div>',
    )
    // Without a renderer a diagram stays a code block.
    expect(await html('```mermaid\ngraph TD\n```\n')).toContain('<code class="language-mermaid">')
  })

  it('resolves relative images and rewrites relative links', async () => {
    const out = await html('![a](./n.assets/a.png) ![r](https://e.com/r.png) [n](other.md#x) [w](https://e.com/a.md)', {
      resolveImage: async (src) => (src === './n.assets/a.png' ? 'data:image/png;base64,AAA' : undefined),
      rewriteLink: noteLinkToHtml,
    })
    expect(out).toContain('<img src="data:image/png;base64,AAA" alt="a" />'.replace(' />', ''))
    expect(out).toContain('src="https://e.com/r.png"')
    expect(out).toContain('href="other.html#x"')
    expect(out).toContain('href="https://e.com/a.md"')
  })
})

describe('noteLinkToHtml', () => {
  it('maps .md links and leaves the rest', () => {
    expect(noteLinkToHtml('a/b.md')).toBe('a/b.html')
    expect(noteLinkToHtml('../b.MD?x=1#y')).toBe('../b.html?x=1#y')
    expect(noteLinkToHtml('img.png')).toBeUndefined()
    expect(noteLinkToHtml('#top')).toBeUndefined()
  })
})

describe('vault export', () => {
  let root: string
  let out: string
  let vault: Vault

  async function put(rel: string, content: string | Buffer): Promise<void> {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), content)
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'export-vault-'))
    out = await mkdtemp(path.join(tmpdir(), 'export-out-'))
    await put('work/todo.md', '---\ntitle: Todo\n---\n# Todo\n\n![shot](./todo.assets/a.png)\n\n[Other](../other.md)\n')
    await put('work/todo.assets/a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await put('other.md', '# Other\n\n$e=mc^2$ [todo](work/todo.md)\n')
    vault = await openVault(root)
  })

  afterEach(async () => {
    await vault.close()
    await rm(root, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  })

  it('inlines assets into a standalone document', async () => {
    const page = await noteToHtml(vault, 'work/todo.md')
    expect(page).toMatch(/^<!doctype html>/)
    expect(page).toContain('<title>Todo</title>')
    expect(page).toContain(`src="data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}"`)
    expect(page).toContain('href="../other.md"')
    expect(page).not.toContain('@font-face')
    const math = await noteToHtml(vault, 'other.md')
    expect(math).toContain('@font-face')
    expect(math).toContain('url(data:font/woff2;base64,')
    expect(math).not.toContain('url(fonts/')
  })

  it('exports a folder tree with an index and .html links', async () => {
    expect(await exportFolderHtml(vault, '', out)).toEqual({ contents: path.join(out, 'index.html'), pages: 2 })
    const index = await readFile(path.join(out, 'index.html'), 'utf8')
    expect(index).toContain('<a href="other.html">Other</a>')
    expect(index).toContain('<h2>work</h2>')
    expect(index).toContain('<a href="work/todo.html">Todo</a>')
    expect(await readFile(path.join(out, 'work/todo.html'), 'utf8')).toContain('href="../other.html"')
    expect(await readFile(path.join(out, 'other.html'), 'utf8')).toContain('href="work/todo.html"')

    const sub = path.join(out, 'sub')
    expect((await exportFolderHtml(vault, 'work', sub)).pages).toBe(1)
    await writeFile(path.join(root, 'work/index.md'), '# Work index\n')
    await vault.refresh()
    const own = await exportFolderHtml(vault, 'work', sub)
    expect(own.contents).toBe(path.join(sub, '_contents.html'))
    expect(await readFile(path.join(sub, 'index.html'), 'utf8')).toContain('Work index')
    expect((await stat(path.join(sub, 'todo.html'))).isFile()).toBe(true)
  })

  it('exports markdown with its assets folder renamed after the file', async () => {
    const target = path.join(out, 'Renamed.md')
    await exportNoteMarkdown(vault, 'work/todo.md', target)
    const text = await readFile(target, 'utf8')
    expect(text).toContain('![shot](./Renamed.assets/a.png)')
    expect(text).toContain('title: Todo')
    expect((await stat(path.join(out, 'Renamed.assets/a.png'))).size).toBe(4)
  })
})
