import { mkdir, realpath, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import type { TabStore } from '../../src/app/actions/public/workspace/navigation.ts'
import type { TabsSnapshot } from '../../src/app/actions/public/workspace/tabs.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { origin, TestApp } from './helpers.ts'

/**
 * `WorkspaceModel` over the in-process router (`createClient` over `TestApp.fetch`) and a memory tab store:
 * the model's own actions (vault switches, `attempt` and its error notice) without a page.
 */

const QUOTA = 'The quota has been exceeded.'

let app: TestApp
/** Note ids whose reads answer `404`, as if deleted on disk after the vault listed them. */
let gone: Set<string>
/** Tab snapshots by vault root; `save` throws like `localStorage.setItem` over its quota. */
let snapshots: Map<string, TabsSnapshot>
let model: WorkspaceModel

const store: TabStore = {
  load: (root) => snapshots.get(root) ?? null,
  save: () => {
    throw new DOMException(QUOTA, 'QuotaExceededError')
  },
}

const api = createClient(async (href, init) => {
  const url = new URL(href, origin)
  if (url.pathname === '/api/notes/read' && gone.has(url.searchParams.get('id') ?? '')) {
    return Response.json({ error: 'NOT_FOUND', message: 'Note not found' }, { status: 404 })
  }
  return app.fetch(href, init)
})

/** Writes `files` into a new folder `name` of the test app's temp dir. */
async function folderWith(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(app.dir, name)
  for (const [id, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, id)), { recursive: true })
    await writeFile(path.join(dir, id), body)
  }
  return dir
}

beforeEach(async () => {
  app = await TestApp.create()
  gone = new Set()
  snapshots = new Map()
  await folderWith('vault', { 'in first.md': '# In first\n' })
  await app.openVault('vault')
  model = new WorkspaceModel(
    await api.workspace(),
    { ui: DEFAULT_UI, hotkeyRegistered: false, update: null },
    { api, store },
  )
})

afterEach(async () => {
  model.session.close()
  await app.close()
})

describe('WorkspaceModel vault switches', () => {
  /**
   * A second vault whose saved active tab names a note that reads as gone: restoring its tabs closes that
   * tab and saves the tabs, and the store's save throws.
   */
  async function secondVaultWhoseRestoreFails(): Promise<string> {
    // Vault roots are real paths (the temp dir can sit behind a symlink); the tab store is keyed by them.
    const second = await realpath(await folderWith('second', { 'in second.md': '# In second\n' }))
    snapshots.set(second, { tabs: ['in second.md'], active: 0, closed: [] })
    gone.add('in second.md')
    return second
  }

  it('openVault awaits the tab restore: its failure is the error notice once the call resolves', async () => {
    const second = await secondVaultWhoseRestoreFails()
    await model.openVault(second)
    expect(model.data.vault?.root).toBe(second)
    expect(model.notice).toEqual({ kind: 'error', text: QUOTA })
  })

  it('pickVault awaits the tab restore: its failure is the error notice once the call resolves', async () => {
    const second = await secondVaultWhoseRestoreFails()
    app.picks.push(second)
    await model.pickVault()
    expect(model.data.vault?.root).toBe(second)
    expect(model.notice).toEqual({ kind: 'error', text: QUOTA })
  })
})
