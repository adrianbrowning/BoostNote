import * as path from 'node:path'

import { type AppHandle, cspViolations, expect, test, writeFiles } from './fixtures.ts'

const DIAGRAMS = `# Diagrams

\`\`\`mermaid
graph TD
  A[Write] --> B[Export]
\`\`\`

\`\`\`mermaid
broken
\`\`\`
`

/** Opens `body` as a loose `.md` in the reader, as the OS does, and returns the reader's body. */
async function openInReader({ page, dir, electronApp }: AppHandle, body: string) {
  await writeFiles(path.join(dir, 'loose'), { 'diagrams.md': body })
  await electronApp.evaluate(
    ({ app: electronApp }, target) => {
      electronApp.emit('open-file', { preventDefault() {} }, target)
    },
    path.join(dir, 'loose', 'diagrams.md'),
  )
  const reader = page.locator('[data-reader-body]')
  await expect(reader.locator('h1')).toHaveText('Diagrams', { timeout: 20_000 })
  return reader
}

test('the reader renders a valid diagram and keeps the code block of one that fails', async ({ app }) => {
  const reader = await openInReader(app, DIAGRAMS)
  await expect(reader.locator('.mermaid-diagram svg')).toHaveCount(1, { timeout: 20_000 })
  await expect(reader.locator('.mermaid-diagram svg')).toContainText('Write')
  await expect(reader.locator('pre > code.language-mermaid')).toHaveCount(1)
  await expect(reader.locator('pre > code.language-mermaid')).toContainText('broken')
  expect(await cspViolations(app.page)).toEqual([])
})

test('reader diagrams follow the OS colour scheme when it changes', async ({ app }) => {
  await app.page.emulateMedia({ colorScheme: 'light' })
  const reader = await openInReader(app, DIAGRAMS)
  const node = reader.locator('.mermaid-diagram svg .node rect').first()
  // Mermaid's default (light) and dark themes fill nodes with #ECECFF and #1f2020.
  await expect(node).toHaveCSS('fill', 'rgb(236, 236, 255)', { timeout: 20_000 })

  await app.page.emulateMedia({ colorScheme: 'dark' })
  await expect(reader.locator('.mermaid-diagram svg .node rect').first()).toHaveCSS('fill', 'rgb(31, 32, 32)')
  await expect(reader.locator('.mermaid-diagram svg')).toContainText('Write')
  // The failed diagram keeps its code block through the re-render.
  await expect(reader.locator('pre > code.language-mermaid')).toContainText('broken')

  await app.page.emulateMedia({ colorScheme: 'light' })
  await expect(reader.locator('.mermaid-diagram svg .node rect').first()).toHaveCSS('fill', 'rgb(236, 236, 255)')
  expect(await cspViolations(app.page)).toEqual([])
})
