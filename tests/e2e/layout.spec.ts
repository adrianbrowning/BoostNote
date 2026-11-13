import type { Locator, Page } from '@playwright/test'

import { expect, readSettings, test } from './fixtures.ts'

/** Waits `frames` animation frames in the page, so pending renders have run. */
async function settleFrames(page: Page, frames = 2): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame++) {
      const { promise, resolve } = Promise.withResolvers<number>()
      requestAnimationFrame(resolve)
      await promise
    }
  }, frames)
}

/** A pointer event step: target (a selector, or `'window'`), event type and clientX. */
type PointerStep = [target: string, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number]

/** Dispatches `steps` in one synchronous burst at height `y`, so no update settles in between. */
async function pointerBurst(page: Page, y: number, steps: PointerStep[]): Promise<void> {
  await page.evaluate(
    ({ y, steps }) => {
      for (const [selector, type, clientX] of steps) {
        const matches = selector === 'window' ? [window] : document.querySelectorAll(selector)
        const [target] = matches
        if (!target || matches.length !== 1) throw new Error(`${selector} matches ${matches.length} elements, not one`)
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: y }))
      }
    },
    { y, steps },
  )
}

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

test.describe('a zero line width', () => {
  test.use({ ui: { lineWidth: 0 } })

  test('lets the editor fill the pane', async ({ app }) => {
    const { page } = app
    await page.locator('[data-note="tasks.md"]').click()
    await expect(page.locator('[data-editor] .cm-content')).toHaveCSS('max-width', 'none')
  })
})

test('dragging a resizer resizes the pane, persists the width and survives collapsing and a reload', async ({
  app,
}) => {
  const { page } = app
  const sidebar = page.getByRole('navigation', { name: 'Vault' })
  const notes = page.getByRole('region', { name: 'Notes' })
  const resizer = await box(page.getByRole('separator', { name: 'Resize sidebar' }))
  await page.mouse.move(resizer.x + 2, resizer.y + 100)
  await page.mouse.down()
  await page.mouse.move(resizer.x + 22, resizer.y + 100, { steps: 4 })
  await page.mouse.move(resizer.x + 42, resizer.y + 100, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await box(sidebar)).width).toBe(290)
  await expect.poll(async () => (await readSettings(app)).ui?.panes?.sidebarWidth).toBe(290)

  // A collapsed sidebar takes no width, so the drag leaves no width of its own behind.
  await app.clickMenu('toggle-sidebar')
  await expect(sidebar).toBeHidden()
  await expect.poll(async () => (await box(notes)).x).toBe(0)
  expect(await box(page.getByRole('separator', { name: 'Resize note list' }))).toMatchObject({ x: 280, width: 4 })
  await app.clickMenu('toggle-sidebar')
  await expect.poll(async () => (await box(sidebar)).width).toBe(290)

  await page.reload()
  await page.locator('[data-connection="connected"]').waitFor()
  expect((await box(sidebar)).width).toBe(290)
})

test('dragging the note-list resizer resizes the list and persists listWidth', async ({ app }) => {
  const { page } = app
  const notes = page.getByRole('region', { name: 'Notes' })
  const resizer = await box(page.getByRole('separator', { name: 'Resize note list' }))
  await page.mouse.move(resizer.x + 2, resizer.y + 100)
  await page.mouse.down()
  await page.mouse.move(resizer.x + 22, resizer.y + 100, { steps: 4 })
  await page.mouse.move(resizer.x + 42, resizer.y + 100, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await box(notes)).width).toBe(320)
  await expect.poll(async () => (await readSettings(app)).ui?.panes?.listWidth).toBe(320)
})

test('a second drag that starts before the first settles keeps its own width', async ({ app }) => {
  const { page } = app
  const sidebar = page.getByRole('navigation', { name: 'Vault' })
  const sidebarResizer = '[aria-label="Resize sidebar"]'
  const resizer = await box(page.getByRole('separator', { name: 'Resize sidebar' }))
  const x = resizer.x + 2
  const y = resizer.y + 100
  // One synchronous burst, so the second pointerdown lands before the first drag's update settles.
  await pointerBurst(page, y, [
    [sidebarResizer, 'pointerdown', x],
    ['window', 'pointermove', x + 20],
    ['window', 'pointerup', x + 20],
    [sidebarResizer, 'pointerdown', x],
    ['window', 'pointermove', x + 60],
  ])
  // Wait for the first drag to settle (its width stored, then two frames for its render), which
  // must not drop the width the still-held second drag set.
  await expect.poll(async () => (await readSettings(app)).ui?.panes?.sidebarWidth).toBe(270)
  await settleFrames(page)
  // The second drag starts from the first's stored 270px and moves 60px more.
  expect((await box(sidebar)).width).toBe(330)
})

test('a note-list drag that starts before a sidebar drag settles leaves no sidebar width behind', async ({ app }) => {
  const { page } = app
  const notes = page.getByRole('region', { name: 'Notes' })
  const sidebarResizer = '[aria-label="Resize sidebar"]'
  const listResizer = '[aria-label="Resize note list"]'
  const sidebarBox = await box(page.getByRole('separator', { name: 'Resize sidebar' }))
  const listBox = await box(page.getByRole('separator', { name: 'Resize note list' }))
  const y = sidebarBox.y + 100
  // One synchronous burst, so the list pointerdown lands before the sidebar drag's update settles.
  await pointerBurst(page, y, [
    [sidebarResizer, 'pointerdown', sidebarBox.x + 2],
    ['window', 'pointermove', sidebarBox.x + 22],
    ['window', 'pointerup', sidebarBox.x + 22],
    [listResizer, 'pointerdown', listBox.x + 2],
    ['window', 'pointermove', listBox.x + 22],
  ])
  await expect.poll(async () => (await readSettings(app)).ui?.panes?.sidebarWidth).toBe(270)
  await settleFrames(page)
  await pointerBurst(page, y, [['window', 'pointerup', listBox.x + 22]])
  await expect.poll(async () => (await readSettings(app)).ui?.panes?.listWidth).toBe(300)

  // The sidebar drag's inline width must be gone, so a collapsed sidebar takes no width.
  await app.clickMenu('toggle-sidebar')
  await expect(page.getByRole('navigation', { name: 'Vault' })).toBeHidden()
  await expect.poll(async () => (await box(notes)).x).toBe(0)
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
  const uncoloured = 'rgba(0, 0, 0, 0)'
  await expect(dot).toHaveCSS('background-color', uncoloured)
  await folder.click({ button: 'right' })
  const swatch = page.getByRole('menuitemradio', { name: 'Colour #E10051' })
  await expect(swatch).toHaveCSS('background-color', 'rgb(225, 0, 81)')
  await expect(page.getByRole('menuitemradio', { name: 'Colour #2BA5F7' })).toHaveCSS(
    'background-color',
    'rgb(43, 165, 247)',
  )
  await swatch.click()
  await expect(dot).toHaveCSS('background-color', 'rgb(225, 0, 81)')

  await folder.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'Colour #2BA5F7' }).click()
  await expect(dot).toHaveCSS('background-color', 'rgb(43, 165, 247)')

  await folder.click({ button: 'right' })
  await page.getByRole('menuitemradio', { name: 'No colour' }).click()
  await expect(dot).toHaveCSS('background-color', uncoloured)
})

test('nested folders are indented 14px per level', async ({ app }) => {
  const { page } = app
  await page.getByRole('button', { name: 'work subfolders' }).click()
  const deep = page.locator('[data-folder="work/deep"]')
  await expect(page.locator('[data-folder="work"]')).toHaveCSS('padding-left', '0px')
  await expect(deep).toHaveCSS('padding-left', '14px')
})

test.describe('a folder two levels deep', () => {
  test.use({
    files: {
      'tasks.md': '# Tasks\n\n- [x] one\n- [ ] two\n- [ ] three\n',
      'work/third.md': '# Third\n',
      'work/deep/fourth.md': '# Fourth\n',
      'work/deep/deeper/fifth.md': '# Fifth\n',
    },
  })

  test('is indented 28px', async ({ app }) => {
    const { page } = app
    await page.getByRole('button', { name: 'work subfolders' }).click()
    await page.getByRole('button', { name: 'deep subfolders' }).click()
    await expect(page.locator('[data-folder="work/deep/deeper"]')).toHaveCSS('padding-left', '28px')
  })
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
