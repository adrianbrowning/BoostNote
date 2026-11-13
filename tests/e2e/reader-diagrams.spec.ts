import { type AppHandle, cspViolations, expect, openLooseFile, test } from './fixtures.ts'

// The broken fence comes first: diagrams render one at a time, so once the graph has drawn the
// broken one has finished too, and its kept code block is final rather than a pending render.
const DIAGRAMS = `# Diagrams

\`\`\`mermaid
broken
\`\`\`

\`\`\`mermaid
graph TD
  A[Write] --> B[Export]
\`\`\`
`

/** Opens `body` as a loose `.md` in the reader, as the OS does, and returns the reader's body. */
async function openInReader(app: AppHandle, body: string) {
  await openLooseFile(app, 'diagrams.md', body)
  const reader = app.page.locator('[data-reader-body]')
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
