import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Locator } from '@playwright/test'

import { expect, test } from './fixtures.ts'

// Layout values the workspace components set per element (pane widths, editor settings, menu
// placement, folder colours, tree indentation, task progress), pinned as computed styles and boxes.
test.use({
  files: {
    'tasks.md': '# Tasks\n\n- [x] one\n- [ ] two\n- [ ] three\n',
    'work/third.md': '# Third\n',
    'work/deep/fourth.md': '# Fourth\n',
  },
  ui: {
    panes: { sidebarWidth: 250, listWidth: 280 },
    fontSize: 18,
    lineWidth: 600,
    editorFont: 'Georgia',
  },
})

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('element is not visible')
  return rect
}

test('pane widths and editor settings come from settings.json', async ({ app }) => {
  const { page } = app
  const sidebar = page.getByRole('navigation', { name: 'Vault' })
  const notes = page.getByRole('region', { name: 'Notes' })
  const sidebarResizer = page.getByRole('separator', { name: 'Resize sidebar' })
  const listResizer = page.getByRole('separator', { name: 'Resize note list' })
  expect((await box(sidebar)).width).toBe(250)
  expect(await box(sidebarResizer)).toMatchObject({ x: 250, width: 4 })
  expect(await box(notes)).toMatchObject({ x: 254, width: 280 })
  expect(await box(listResizer)).toMatchObject({ x: 534, width: 4 })

  await page.locator('[data-note="tasks.md"]').click()
  await expect(page.locator('[data-editor] .cm-content')).toHaveCSS('font-size', '18px')
  await expect(page.locator('[data-editor] .cm-content')).toHaveCSS('max-width', '600px')
  await expect(page.locator('[data-editor] .cm-scroller')).toHaveCSS('font-family', 'Georgia')
})

test('dragging a resizer resizes the pane, persists the width and survives collapsing and a reload', async ({
  app,
}) => {
  const { page, userDataDir } = app
  const sidebar = page.getByRole('navigation', { name: 'Vault' })
  const notes = page.getByRole('region', { name: 'Notes' })
  const resizer = await box(page.getByRole('separator', { name: 'Resize sidebar' }))
  await page.mouse.move(resizer.x + 2, resizer.y + 100)
  await page.mouse.down()
  await page.mouse.move(resizer.x + 22, resizer.y + 100, { steps: 4 })
  await page.mouse.move(resizer.x + 42, resizer.y + 100, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await box(sidebar)).width).toBe(290)
  const settings = async () => JSON.parse(await readFile(path.join(userDataDir, 'settings.json'), 'utf8'))
  await expect.poll(async () => (await settings()).ui.panes.sidebarWidth).toBe(290)

  // A collapsed sidebar takes no width, so the drag leaves no width of its own behind.
  await app.clickMenu('toggle-sidebar')
  await expect(sidebar).toBeHidden()
  await expect.poll(async () => (await box(notes)).x).toBe(0)
  await app.clickMenu('toggle-sidebar')
  await expect.poll(async () => (await box(sidebar)).width).toBe(290)

  await page.reload()
  await page.locator('[data-connection="connected"]').waitFor()
  expect((await box(sidebar)).width).toBe(290)
})

test('the context menu opens at the pointer, 200px wide', async ({ app }) => {
  const { page } = app
  const row = await box(page.locator('[data-note="tasks.md"]'))
  await page.locator('[data-note="tasks.md"]').click({ button: 'right', position: { x: 30, y: 12 } })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  // The row sits at a fractional y; the menu lands on the pointer's whole pixel.
  const rect = await box(menu)
  expect(rect.width).toBe(200)
  expect(Math.abs(rect.x - (row.x + 30))).toBeLessThanOrEqual(1)
  expect(Math.abs(rect.y - (row.y + 12))).toBeLessThanOrEqual(1)
})

test('folder colour swatches show the palette and the picked colour paints the folder dot', async ({ app }) => {
  const { page } = app
  const folder = page.locator('[data-folder="work"]')
  const dot = folder.locator('[data-folder-swatch]')
  await folder.click({ button: 'right' })
  const swatch = page.getByRole('menuitemradio', { name: 'Colour #E10051' })
  await expect(swatch).toHaveCSS('background-color', 'rgb(225, 0, 81)')
  await expect(page.getByRole('menuitemradio', { name: 'Colour #2BA5F7' })).toHaveCSS(
    'background-color',
    'rgb(43, 165, 247)',
  )
  await swatch.click()
  await expect(dot).toHaveCSS('background-color', 'rgb(225, 0, 81)')
})

test('nested folders are indented 14px per level', async ({ app }) => {
  const { page } = app
  await page.getByRole('button', { name: 'work subfolders' }).click()
  const deep = page.locator('[data-folder="work/deep"]')
  await expect(page.locator('[data-folder="work"]')).toHaveCSS('padding-left', '0px')
  await expect(deep).toHaveCSS('padding-left', '14px')
})

test('the task progress fill spans the share of tasks done', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="tasks.md"]').click()
  const bar = page.getByRole('progressbar', { name: 'Tasks done' })
  const fill = bar.locator('[data-task-progress-fill]')
  const share = async () => (await box(fill)).width / (await box(bar)).width
  await expect.poll(share).toBeCloseTo(0.33, 2)
  await page.locator('[data-editor] .cm-lp-checkbox').nth(1).click()
  await expect.poll(share).toBeCloseTo(0.66, 2)
})
