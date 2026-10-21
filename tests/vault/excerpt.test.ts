import { describe, expect, it } from 'vitest'

import { EXCERPT_LENGTH, excerptOf } from '../../src/vault/note.ts'

describe('excerptOf', () => {
  it('turns markdown-heavy bodies into plain text', () => {
    const body = [
      '---',
      'title: [broken yaml',
      '---',
      '# Weekly **plan**',
      '',
      '> **Note:** read the [design doc](https://example.com/doc?a=1) and `README.md` first.',
      '',
      '![diagram](./plan.assets/abc123.png)',
      '',
      '- [ ] Ship _tabs_ <kbd>Cmd</kbd>+<kbd>W</kbd>',
      '- [x] ~~Drop~~ old <span class="x">code</span>',
      '1. Numbered &amp; escaped \\*stars\\*',
      '',
      '```ts',
      'const secret = "should not appear"',
      '```',
      '',
      '$$',
      'e = mc^2',
      '$$',
      '',
      '| Col A | Col B |',
      '| :--- | ---: |',
      '| one | two |',
      '',
      '---',
      '',
      '<!-- hidden comment -->',
      'Autolink <https://example.com/x> and footnote[^1].',
      '',
      '[^1]: The footnote.',
      '[ref]: https://example.com/ref',
    ].join('\n')

    expect(excerptOf(body)).toBe(
      'Note: read the design doc and README.md first. Ship tabs Cmd + W Drop old code Numbered & escaped *stars* ' +
        'Col A Col B one two Autolink and footnote.',
    )
  })

  it('collapses whitespace and truncates to the excerpt length', () => {
    const excerpt = excerptOf(`# Title\n\n${'word   \t '.repeat(100)}`)
    expect(excerpt.length).toBe(EXCERPT_LENGTH)
    expect(excerpt).toMatch(/^word word .*…$/)
    expect(excerpt).not.toMatch(/\s{2,}/)
  })

  it('is empty for notes with only a title, code or images', () => {
    expect(excerptOf('# Only a title\n')).toBe('')
    expect(excerptOf('~~~\ncode\n~~~\n![x](a.png)\n')).toBe('')
  })
})
