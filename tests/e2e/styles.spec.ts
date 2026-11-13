import { expect, test } from './fixtures.ts'

// How css() values reach the page, pinned as computed styles (never generated class names).
test.use({ files: { 'second.md': '# Second\n\nPlain text.\n' } })

test('css() numbers reach the page as valid CSS: line clamp, flex, z-index and font weight', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="second.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('second')
  // An invalid serialised value falls back to the default (under remix 3.1 the clamp computed `none`).
  const excerpt = page.locator('[data-note="second.md"]').getByText('Plain text.')
  await expect(excerpt).toHaveCSS('-webkit-line-clamp', '2')
  // `flex: 1` computes basis 0%; remix 3.1 serialised it as `flex: 1px` (grow 1, basis 1px).
  const notes = page.getByRole('listbox', { name: /^Notes in / })
  const editor = page.locator('[data-editor]')
  await expect(notes).toHaveCSS('flex-grow', '1')
  await expect(notes).toHaveCSS('flex-basis', '0%')
  await expect(editor).toHaveCSS('flex-grow', '1')
  await expect(editor).toHaveCSS('flex-basis', '0%')
  await expect(page.locator('[data-note-title]')).toHaveCSS('font-weight', '600')
  await page.locator('[data-note="second.md"]').click({ button: 'right' })
  await expect(page.locator('[data-scrim="menu"]')).toHaveCSS('z-index', '50')
  await page.keyboard.press('Escape')
})
