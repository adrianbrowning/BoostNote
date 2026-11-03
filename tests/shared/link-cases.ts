/**
 * The one table of link hrefs, as written in note `FROM`, that the shared resolver
 * (`tests/shared/vault-ids.test.ts`), export's `noteLinkToHtml` (`tests/markdown/render.test.ts`) and
 * the vault's link rewriting (`tests/vault/link-updates.test.ts`) are all asserted against.
 */
export const FROM = 'Guides/ch4.md'

export interface LinkCase {
  /** What the row covers. */
  kind: string
  href: string
  /** `isRelativeLink(href)`. */
  relative: boolean
  /** `resolveNoteLink(FROM, href)`: the note it opens. */
  note: string | undefined
  /**
   * `noteLinkToHtml(href)`: the link in exported HTML. Export has no note to resolve from, so a note
   * link that would leave the vault still maps; dot-folders do not.
   */
  html: string | undefined
  /** The link after the vault moves `FROM` to `Archive/ch4.md`. */
  moved: string
}

export const LINK_CASES: readonly LinkCase[] = [
  {
    kind: 'same folder',
    href: 'ch3.md',
    relative: true,
    note: 'Guides/ch3.md',
    html: 'ch3.html',
    moved: '../Guides/ch3.md',
  },
  {
    kind: 'nested folders',
    href: 'sub/deep/n.md',
    relative: true,
    note: 'Guides/sub/deep/n.md',
    html: 'sub/deep/n.html',
    moved: '../Guides/sub/deep/n.md',
  },
  {
    kind: 'parent folder',
    href: '../Default/n.md',
    relative: true,
    note: 'Default/n.md',
    html: '../Default/n.html',
    moved: '../Default/n.md',
  },
  {
    kind: 'dot segments',
    href: './sub/../ch3.md',
    relative: true,
    note: 'Guides/ch3.md',
    html: './sub/../ch3.html',
    moved: '../Guides/ch3.md',
  },
  {
    kind: 'percent-encoded name',
    href: 'Git%20cheat%20sheet.md',
    relative: true,
    note: 'Guides/Git cheat sheet.md',
    html: 'Git%20cheat%20sheet.html',
    moved: '../Guides/Git%20cheat%20sheet.md',
  },
  {
    kind: 'query string',
    href: 'ch3.md?x=1',
    relative: true,
    note: 'Guides/ch3.md',
    html: 'ch3.html?x=1',
    moved: '../Guides/ch3.md?x=1',
  },
  {
    kind: 'fragment',
    href: 'ch3.md#curry',
    relative: true,
    note: 'Guides/ch3.md',
    html: 'ch3.html#curry',
    moved: '../Guides/ch3.md#curry',
  },
  {
    kind: 'note.md/#anchor',
    href: 'ch3.md/#user-content-curry',
    relative: true,
    note: 'Guides/ch3.md',
    html: 'ch3.html#user-content-curry',
    moved: '../Guides/ch3.md/#user-content-curry',
  },
  {
    kind: 'note.md/?query, encoded, in another folder',
    href: '../Default/Git%20cheat%20sheet.md/?x=1',
    relative: true,
    note: 'Default/Git cheat sheet.md',
    html: '../Default/Git%20cheat%20sheet.html?x=1',
    moved: '../Default/Git%20cheat%20sheet.md/?x=1',
  },
  {
    kind: 'inner backslash',
    href: 'sub\\n.md',
    relative: true,
    note: 'Guides/sub/n.md',
    html: 'sub/n.html',
    moved: '../Guides/sub/n.md',
  },
  {
    kind: 'non-note file',
    href: 'ch3.assets/a.png',
    relative: true,
    note: undefined,
    html: undefined,
    moved: '../Guides/ch3.assets/a.png',
  },
  { kind: 'folder', href: 'notes/', relative: true, note: undefined, html: undefined, moved: '../Guides/notes' },
  { kind: 'uppercase .MD', href: 'B.MD', relative: true, note: undefined, html: undefined, moved: '../Guides/B.MD' },
  {
    kind: 'traversal',
    href: '../../out.md',
    relative: true,
    note: undefined,
    html: '../../out.html',
    moved: '../../out.md',
  },
  {
    kind: 'hidden segment',
    href: '.trash/x.md',
    relative: true,
    note: undefined,
    html: undefined,
    moved: '.trash/x.md',
  },
  {
    kind: 'hidden segment after ..',
    href: '../.boostnote/x.md',
    relative: true,
    note: undefined,
    html: undefined,
    moved: '../.boostnote/x.md',
  },
  {
    kind: 'scheme',
    href: 'https://example.com/a.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: 'https://example.com/a.md',
  },
  {
    kind: 'mailto scheme',
    href: 'mailto:me@example.com',
    relative: false,
    note: undefined,
    html: undefined,
    moved: 'mailto:me@example.com',
  },
  {
    kind: 'protocol-relative',
    href: '//example.com/a.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: '//example.com/a.md',
  },
  {
    kind: 'absolute',
    href: '/Guides/ch3.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: '/Guides/ch3.md',
  },
  { kind: 'leading backslash', href: '\\n.md', relative: false, note: undefined, html: undefined, moved: '\\n.md' },
  { kind: 'anchor', href: '#top', relative: false, note: undefined, html: undefined, moved: '#top' },
  { kind: 'query only', href: '?x=1', relative: false, note: undefined, html: undefined, moved: '?x=1' },
  { kind: 'empty', href: '', relative: false, note: undefined, html: undefined, moved: '' },
  {
    kind: 'encoded absolute path',
    href: '%2FGuides%2Fch3.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: '%2FGuides%2Fch3.md',
  },
  {
    kind: 'encoded leading backslash',
    href: '%5Cn.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: '%5Cn.md',
  },
  {
    kind: 'encoded scheme',
    href: 'https%3A%2F%2Fexample.com%2Fa.md',
    relative: false,
    note: undefined,
    html: undefined,
    moved: 'https%3A%2F%2Fexample.com%2Fa.md',
  },
  { kind: 'encoded anchor', href: '%23top', relative: false, note: undefined, html: undefined, moved: '%23top' },
  { kind: 'encoded query', href: '%3Fch3.md', relative: false, note: undefined, html: undefined, moved: '%3Fch3.md' },
  {
    kind: 'encoded separator',
    href: 'sub%2Fn.md',
    relative: true,
    note: 'Guides/sub/n.md',
    html: 'sub/n.html',
    moved: '../Guides/sub/n.md',
  },
  {
    kind: 'note.md/#anchor with an encoded slash',
    href: 'ch3.md%2F#x',
    relative: true,
    note: 'Guides/ch3.md',
    html: 'ch3.html#x',
    moved: '../Guides/ch3.md/#x',
  },
]
