import { describe, expect, it } from 'vitest'

import { renderInlineMarkdown } from '../../src/editor/render/inline.ts'
import { LINK_CASES } from '../shared/link-cases.ts'

const IMAGE_CASES: readonly { href: string; relative: boolean }[] = [
  ...LINK_CASES.map(({ href, relative }) => ({ href, relative })),
  { href: 'https://x/a.png', relative: false },
  { href: 'data:image/png;base64,AA', relative: false },
  { href: '//cdn/a.png', relative: false },
  { href: '/abs.png', relative: false },
  { href: '\\x.png', relative: false },
  { href: '#x', relative: false },
  { href: '', relative: false },
  { href: 'note.assets/a%20b.png', relative: true },
]

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

describe('renderInlineMarkdown images', () => {
  it('keeps reference and shortcut images without a destination as text', () => {
    const resolve = (p: string) => `asset:${p}`
    expect(renderInlineMarkdown('![a][ref]', resolve)).toBe('![a][ref]')
    expect(renderInlineMarkdown('![a]', resolve)).toBe('![a]')
  })

  it.each(IMAGE_CASES)('resolves $href only when it is relative ($relative)', ({ href, relative }) => {
    const resolved: string[] = []
    const html = renderInlineMarkdown(`![a](${href})`, (p) => {
      resolved.push(p)
      return `asset:${p}`
    })
    expect(resolved).toEqual(relative ? [href] : [])
    expect(html).toBe(`<img src="${escapeAttr(relative ? `asset:${href}` : href)}" alt="a">`)
  })

  it.each([
    { md: '![a](<https://x/a.png>)', src: 'https://x/a.png', relative: false },
    { md: '![a](<my note.assets/1.png>)', src: 'my note.assets/1.png', relative: true },
  ])('unwraps the angle-bracket destination $md', ({ md, src, relative }) => {
    const resolved: string[] = []
    const html = renderInlineMarkdown(md, (p) => {
      resolved.push(p)
      return `asset:${p}`
    })
    expect(resolved).toEqual(relative ? [src] : [])
    expect(html).toBe(`<img src="${escapeAttr(relative ? `asset:${src}` : src)}" alt="a">`)
  })
})

describe('renderInlineMarkdown links', () => {
  it('unwraps the angle-bracket link destination', () => {
    expect(renderInlineMarkdown('[a](<my note.md>)', (p) => p)).toBe('<a href="my note.md">a</a>')
  })
})
