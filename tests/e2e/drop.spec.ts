import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test, writeFiles } from './fixtures.ts'

test.use({
  files: {
    'open.md': '# Open\n\nKeep this text.\n',
    'work/existing.md': '# Existing\n',
  },
})

const shots = '/tmp/boost-phase12'

/**
 * Drops files from disk onto `selector` the only way Playwright can: real `File`s from a file input
 * (`setInputFiles`, so they are backed by the paths), put in a `DataTransfer` and dispatched as
 * `dragover` + `drop`. The app's drop handler then asks the preload for their paths, as for a real drop.
 * An OS folder can't be put in a file input, so folder drops are not covered this way.
 */
async function dropFiles(page: Page, selector: string, files: string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'e2e-drop-files'
    document.body.append(input)
  })
  await page.setInputFiles('#e2e-drop-files', files)
  await page
    .locator(selector)
    .first()
    .evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#e2e-drop-files')
      const data = new DataTransfer()
      for (const file of input?.files ?? []) data.items.add(file)
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: data }
      target.dispatchEvent(new DragEvent('dragenter', init))
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
      input?.remove()
    })
}

const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex')

test('drops notes with an image and a link between them into the selected folder', async ({ app }) => {
  const { page, vault, dir } = app
  const src = path.join(dir, 'drop-src')
  await writeFiles(src, {
    'Trip Plan.md': '---\ntags: [travel]\n---\n# Trip\n\n![map](./map%20v2.png)\n\nSee [packing](Packing%20List.md).\n',
    'Packing List.md': '# Packing\n\n- [ ] socks\n',
    'map v2.png': 'PNG-BYTES',
    'notes.txt': 'not markdown',
  })
  const sources = ['Trip Plan.md', 'Packing List.md', 'notes.txt'].map((name) => path.join(src, name))
  const before = await Promise.all(sources.map(sha))

  await page.locator('[data-folder="work"]').getByTitle('work').click()
  await dropFiles(page, 'section[aria-label="Notes"]', sources)

  const notice = page.locator('[data-notice]')
  await expect(notice).toContainText('Imported 2 notes into work (1 image copied, 1 skipped)')
  await expect(notice.locator('[data-notice-details]')).toContainText('Skipped notes.txt: not a Markdown file')
  await expect(page.locator('[data-note="work/Trip Plan.md"]')).toBeVisible()
  await page.screenshot({ path: `${shots}/e2e-drop-list.png` })

  const trip = await readFile(path.join(vault, 'work', 'Trip Plan.md'), 'utf8')
  const asset = (await readdir(path.join(vault, 'work', 'Trip Plan.assets')))[0]
  expect(asset).toMatch(/^[0-9a-f]{12}\.png$/)
  expect(trip).toBe(
    `---\ntags: [travel]\n---\n# Trip\n\n![map](./Trip%20Plan.assets/${asset})\n\nSee [packing](Packing%20List.md).\n`,
  )
  expect(await readFile(path.join(vault, 'work', 'Packing List.md'), 'utf8')).toBe('# Packing\n\n- [ ] socks\n')
  expect(await Promise.all(sources.map(sha))).toEqual(before)
})

test('a .md dropped on the editor is imported and opened, not pasted', async ({ app }) => {
  const { page, vault, dir } = app
  await writeFiles(path.join(dir, 'drop-src'), { 'Dropped.md': '# Dropped\n\nFrom disk.\n' })
  await page.locator('[data-note="open.md"]').click()
  await expect(page.locator('[data-editor] .cm-content')).toContainText('Keep this text.')

  await dropFiles(page, '[data-editor] .cm-content', [path.join(dir, 'drop-src', 'Dropped.md')])

  await expect(page.locator('[data-tab="Dropped.md"]')).toBeVisible()
  await expect(page.locator('[data-editor] .cm-content')).toContainText('From disk.')
  expect(await readFile(path.join(vault, 'Dropped.md'), 'utf8')).toBe('# Dropped\n\nFrom disk.\n')
  expect(await readFile(path.join(vault, 'open.md'), 'utf8')).toBe('# Open\n\nKeep this text.\n')
  await page.screenshot({ path: `${shots}/e2e-drop-editor.png` })
})

test('a folder row takes the drop (highlighted while dragging over it)', async ({ app }) => {
  const { page, vault, dir } = app
  await writeFiles(path.join(dir, 'drop-src'), { 'Row.md': 'row\n' })
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'x.md'))
    document
      .querySelector('[data-folder="work"]')
      ?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('[data-folder="work"]')).toHaveAttribute('data-drop-target', 'true')

  await dropFiles(page, '[data-folder="work"]', [path.join(dir, 'drop-src', 'Row.md')])

  await expect(page.locator('[data-folder="work"]')).not.toHaveAttribute('data-drop-target', 'true')
  await expect(page.locator('[data-notice]')).toContainText('Imported 1 note into work')
  expect(await readFile(path.join(vault, 'work', 'Row.md'), 'utf8')).toBe('row\n')
})

test('an image dropped on the editor text is still stored as an asset of the open note', async ({ app }) => {
  const { page, vault, dir } = app
  await writeFiles(path.join(dir, 'drop-src'), { 'shot.png': 'IMG' })
  await page.locator('[data-note="open.md"]').click()
  await expect(page.locator('[data-editor] .cm-content')).toContainText('Keep this text.')

  // An editor image drop needs only the File's bytes and MIME type, so no file input is needed.
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['IMG'], 'shot.png', { type: 'image/png' }))
    const init = { bubbles: true, cancelable: true, dataTransfer: data }
    const content = document.querySelector('[data-editor] .cm-content')
    content?.dispatchEvent(new DragEvent('dragover', init))
    content?.dispatchEvent(new DragEvent('drop', init))
  })

  await expect
    .poll(() => readFile(path.join(vault, 'open.md'), 'utf8'), { timeout: 10_000 })
    .toMatch(/!\[shot\]\(\.\/open\.assets\/[0-9a-f]{12}\.png\)/)
  expect(await readdir(vault)).not.toContain('shot.md')
})

test('without an open vault a drop asks to open one first', async ({ app }) => {
  const { page, dir, vault } = app
  await writeFiles(path.join(dir, 'drop-src'), { 'Lost.md': 'lost\n' })
  await page.evaluate(
    (root) =>
      fetch('/api/vaults/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root }),
      }),
    vault,
  )
  await page.reload()
  await expect(page.locator('[data-vault="none"]')).toBeVisible()
  await dropFiles(page, 'main', [path.join(dir, 'drop-src', 'Lost.md')])
  await expect(page.locator('[data-notice]')).toContainText('Open a vault first')
})
