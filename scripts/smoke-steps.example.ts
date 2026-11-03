// Example `--steps` module for scripts/smoke.ts:
// `pnpm smoke --vault-copy tests/fixtures/sample-vault --steps scripts/smoke-steps.example.ts`.
// Through the app's API it searches the vault, trashes the first hit and restores it, logging each result.
import type { AppHandle } from '../tests/e2e/fixtures.ts'

export default async function steps({ page }: AppHandle): Promise<void> {
  await page.locator('[data-connection="connected"]').waitFor()
  const result = await page.evaluate(async () => {
    const call = async (url: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(
        url,
        body === undefined
          ? {}
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`)
      return response.json()
    }
    const workspace = (await call('/api/workspace')) as { vault: { root: string } }
    const vault = encodeURIComponent(workspace.vault.root)
    const search = (await call(`/api/search?vault=${vault}&q=plan`)) as { ids: string[] }
    const id = search.ids[0]
    if (!id) throw new Error('Search for "plan" found no notes')
    const trashed = (await call(`/api/notes/delete?vault=${vault}`, { id })) as { id: string }
    const restored = await call(`/api/trash/restore?vault=${vault}`, { id: trashed.id })
    return { root: workspace.vault.root, search, trashed, restored }
  })
  console.log(`Vault root: ${result.root}`)
  console.log('Search "plan":', JSON.stringify(result.search))
  console.log('Trashed:', JSON.stringify(result.trashed))
  console.log('Restored:', JSON.stringify(result.restored))
}
