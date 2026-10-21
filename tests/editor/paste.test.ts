import { describe, expect, it } from 'vitest'

import { htmlToMarkdown, imageMarkdown } from '../../src/editor/paste.ts'

describe('HTML paste → markdown', () => {
  it('converts headings, emphasis, links and lists', () => {
    const html =
      '<meta charset="utf-8"><h2>Title</h2><p>Some <b>bold</b>, <i>italic</i> and <a href="https://x.y">a link</a>.</p>' +
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start="3"><li>third</li><li>fourth</li></ol>'
    expect(htmlToMarkdown(html)).toBe(
      '## Title\n\nSome **bold**, *italic* and [a link](https://x.y).\n\n- one\n- two\n  - nested\n\n3. third\n4. fourth',
    )
  })

  it('converts GFM tables, strikethrough, task lists and fenced code', () => {
    const html =
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>' +
      '<p><del>gone</del></p><ul><li><input type="checkbox" checked> done</li></ul>' +
      '<pre><code class="language-js">let a = 1\n</code></pre>'
    const markdown = htmlToMarkdown(html)
    expect(markdown).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(markdown).toContain('~~gone~~')
    expect(markdown).toContain('- [x] done')
    expect(markdown).toContain('```js\nlet a = 1\n```')
  })

  it('drops scripts and styles', () => {
    expect(htmlToMarkdown('<style>p{}</style><script>alert(1)</script><p>safe</p>')).toBe('safe')
  })
})

describe('image markdown', () => {
  it('uses the file stem as alt text and wraps awkward paths', () => {
    expect(imageMarkdown('Screen Shot.png', './note.assets/ab12cd34ef56.png')).toBe(
      '![Screen Shot](./note.assets/ab12cd34ef56.png)',
    )
    expect(imageMarkdown('x.png', './my note.assets/1.png')).toBe('![x](<./my note.assets/1.png>)')
    expect(imageMarkdown('[a].png', 'a.png')).toBe('![a](a.png)')
  })
})
