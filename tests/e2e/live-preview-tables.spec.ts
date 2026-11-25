import type { Locator } from '@playwright/test'

import { expect, readSettings, test } from './fixtures.ts'

const sentence =
  'The customer asked for a refund after the parcel arrived late and the box was badly damaged in transit'
const longWord = 'x'.repeat(400)

test.use({
  files: {
    'table.md': `# Table\n\nIntro paragraph.\n\n| Customer | Notes | Outcome | Follow-up | Owner |\n| --- | --- | --- | --- | --- |\n| Acme | ${sentence} | ${sentence} | ${sentence} | ${sentence} |\n\n${longWord}\n`,
  },
})

/** How many lines the text of `locator` is laid out on. */
const textLines = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
  })

/** The words of `locator`'s text that are laid out across more than one line. */
const splitWords = (locator: Locator) =>
  locator.evaluate((element) => {
    const split: string[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange()
        range.setStart(node, match.index)
        range.setEnd(node, match.index + match[0].length)
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
        if (tops.size > 1) split.push(match[0])
      }
    }
    return split
  })

test('live-preview table cells break only between words and stay within the text column', async ({ app }) => {
  const { page } = app
  await page.locator('[data-note="table.md"]').click()
  const table = page.locator('[data-editor] .cm-lp-table table')
  await expect(table).toBeVisible()

  const header = table.locator('th').first()
  await expect(header).toHaveText('Customer')
  expect(await textLines(header)).toBe(1)
  // Long cell text still wraps (between words).
  expect(await textLines(table.locator('td').nth(1))).toBeGreaterThan(1)
  expect(await splitWords(table.locator('td').nth(1))).toEqual([])

  const content = await page.locator('[data-editor] .cm-content').boundingBox()
  const tableBox = await table.boundingBox()
  if (!content || !tableBox) throw new Error('not visible')
  expect(tableBox.width).toBeLessThanOrEqual(content.width)

  // Prose outside tables still wraps long unbroken words.
  const prose = page.locator('[data-editor] .cm-line', { hasText: longWord.slice(0, 50) })
  expect(await textLines(prose)).toBeGreaterThan(1)
})

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('element is not visible')
  return rect
}

/** The horizontal extent and height of `locator`, leaving out where it sits vertically on the page. */
const across = async (locator: Locator) => {
  const { x, width, height } = await box(locator)
  return { x, width, height }
}

test.describe('the table width', () => {
  const cell = 'y'.repeat(60)
  test.use({
    files: {
      'widths.md': [
        '# Widths',
        '',
        'A paragraph of prose that is long enough to fill the whole text column of the editor, so its line is as wide as the text column.',
        '',
        '| Customer | Notes | Outcome | Follow-up | Owner |',
        '| --- | --- | --- | --- | --- |',
        `| Acme | ${sentence} | ${sentence} | ${sentence} | ${sentence} |`,
        '',
        '| Key | Value |',
        '| --- | --- |',
        '| a | b |',
        '',
        '- A list item',
        '',
        '  | In | List |',
        '  | --- | --- |',
        `  | ${sentence} | ${sentence} |`,
        '',
        '> | Quoted | Table |',
        '> | --- | --- |',
        `> | ${sentence} | ${sentence} |`,
        '',
        `| ${Array(8).fill('Wide').join(' | ')} |`,
        `| ${Array(8).fill('---').join(' | ')} |`,
        `| ${Array(8).fill(cell).join(' | ')} |`,
        '',
      ].join('\n'),
    },
    ui: { lineWidth: 600, panes: { sidebarCollapsed: true, listWidth: 200 } },
  })

  test('lets live-preview tables grow from the text column to the pane while prose keeps the line width', async ({
    app,
  }) => {
    const { page } = app
    await page.locator('[data-note="widths.md"]').click()
    const editor = page.locator('[data-editor]')
    const content = editor.locator('.cm-content')
    const widgets = editor.locator('.cm-lp-table')
    await expect(widgets).toHaveCount(4)
    const [wide, narrow, inList, tooWide] = [widgets.nth(0), widgets.nth(1), widgets.nth(2), widgets.nth(3)]
    // A table in a blockquote stays as quoted source lines (no widget is drawn after a quote marker).
    const inQuote = editor.locator('.cm-line', { hasText: sentence }).last()
    const paragraph = editor.locator('.cm-line', { hasText: 'A paragraph of prose' })

    // The default table width keeps every table within the text column, as before.
    const column = await box(paragraph)
    const wideBefore = await box(wide)
    expect(wideBefore.x).toBeGreaterThanOrEqual(column.x - 0.5)
    expect(wideBefore.x + wideBefore.width).toBeLessThanOrEqual(column.x + column.width + 0.5)
    const narrowBefore = await across(narrow.locator('table'))
    const narrowWidgetBefore = await across(narrow)

    const tableWidth = page.getByRole('combobox', { name: 'Table width', exact: true })
    await app.clickMenu('preferences')
    await tableWidth.selectOption('full')
    await expect.poll(async () => (await readSettings(app)).ui.tableWidth).toBe('full')
    await page.keyboard.press('Escape')

    // Prose keeps the line width.
    await expect(content).toHaveCSS('max-width', '600px')
    expect((await box(paragraph)).width).toBeLessThanOrEqual(600)
    expect(await box(paragraph)).toEqual(column)

    // A wide table grows past the line width, within the pane, centred on the text column.
    const pane = await box(editor)
    await expect.poll(async () => (await box(wide)).width).toBeGreaterThan(600)
    expect(await wide.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const wideAfter = await box(wide)
    expect(wideAfter.x).toBeGreaterThanOrEqual(pane.x)
    expect(wideAfter.x + wideAfter.width).toBeLessThanOrEqual(pane.x + pane.width)
    expect(Math.abs(wideAfter.x + wideAfter.width / 2 - (column.x + column.width / 2))).toBeLessThanOrEqual(1)
    // The pane itself never scrolls sideways.
    const scroller = editor.locator('.cm-scroller')
    expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

    // A narrow table looks as it did (it only moves up, as the wide table above it got shorter).
    expect(await across(narrow.locator('table'))).toEqual(narrowBefore)
    expect(await across(narrow)).toEqual(narrowWidgetBefore)
    // A table in a list keeps the width of the text column.
    const inListBox = await box(inList)
    expect(inListBox.x).toBeGreaterThanOrEqual(column.x - 0.5)
    expect(inListBox.x + inListBox.width).toBeLessThanOrEqual(column.x + column.width + 0.5)
    // So does a table in a blockquote.
    const inQuoteBox = await box(inQuote)
    expect(inQuoteBox.x).toBeGreaterThanOrEqual(column.x - 0.5)
    expect(inQuoteBox.x + inQuoteBox.width).toBeLessThanOrEqual(column.x + column.width + 0.5)

    // A table wider than the pane scrolls inside its widget, within the pane.
    const tooWideBox = await box(tooWide)
    expect(tooWideBox.x + tooWideBox.width).toBeLessThanOrEqual(pane.x + pane.width)
    expect(await tooWide.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    // `auto`/`scroll` (not `hidden`/`clip`) is what lets the user scroll the clipped table.
    await expect(tooWide).toHaveCSS('overflow-x', /^(auto|scroll)$/)

    // A pixel table width caps tables at that width.
    await app.clickMenu('preferences')
    await tableWidth.selectOption('custom')
    await page.getByRole('spinbutton', { name: 'Table width (px)' }).click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('700')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readSettings(app)).ui.tableWidth).toBe(700)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await box(wide)).width).toBeLessThanOrEqual(700)
    expect((await box(wide)).width).toBeGreaterThan(600)

    // A click on a cell still moves the cursor into the table source.
    await tooWide.locator('td').first().click()
    await expect(widgets).toHaveCount(3)
    await expect(editor.locator('.cm-line', { hasText: `| ${cell} |` })).toBeVisible()
  })
})

for (const tableWidth of ['line', 'full'] as const) {
  test.describe(`a zero line width with table width ${tableWidth}`, () => {
    test.use({
      files: {
        'wide.md': [
          '# Wide',
          '',
          `| ${Array(8).fill('Wide').join(' | ')} |`,
          `| ${Array(8).fill('---').join(' | ')} |`,
          `| ${Array(8).fill('y'.repeat(60)).join(' | ')} |`,
          '',
        ].join('\n'),
      },
      ui: { lineWidth: 0, tableWidth, panes: { sidebarCollapsed: true, listWidth: 200 } },
    })

    test('a too-wide live-preview table scrolls inside its widget within the pane', async ({ app }) => {
      const { page } = app
      await page.locator('[data-note="wide.md"]').click()
      const editor = page.locator('[data-editor]')
      const widget = editor.locator('.cm-lp-table')
      await expect(widget).toBeVisible()
      const pane = await box(editor)
      const widgetBox = await box(widget)
      expect(widgetBox.x).toBeGreaterThanOrEqual(pane.x)
      expect(widgetBox.x + widgetBox.width).toBeLessThanOrEqual(pane.x + pane.width)
      expect(
        await editor.locator('.cm-scroller').evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true)
      expect(await widget.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    })
  })
}
