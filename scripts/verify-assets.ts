// `pnpm build` gate. Nothing is transpiled ahead of time (the main process runs TS/JSX through
// remix/node-tsx and the asset server compiles browser modules on request), so instead this renders
// the document with production settings and compiles every browser asset it references, failing on
// the first error. Run before packaging so broken client code never ships.
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { createEventHub } from '../src/main/events.ts'
import { SettingsStore } from '../src/main/settings.ts'
import { VaultSession } from '../src/main/vault-session.ts'

process.env.NODE_ENV = 'production'

// Dynamic because assets.ts reads NODE_ENV while it evaluates (static imports would run first).
const { createAppRouter } = await import('../src/app/router.ts')
const { assets, katexStylesHref } = await import('../src/app/assets.ts')

const origin = 'http://app'
const scratch = await mkdtemp(path.join(os.tmpdir(), 'boostnote-verify-'))
const events = createEventHub()
const settings = new SettingsStore(path.join(scratch, 'settings.json'))
const router = createAppRouter({
  events,
  vaults: new VaultSession({ settings, events }),
  settings,
  preferences: { apply: () => {}, setHotkey: () => true, registeredHotkey: undefined },
  pickFolder: async () => undefined,
  openExternal: async () => {},
  showItemInFolder: () => {},
  findLegacyStorages: async () => [],
})

try {
  const page = await router.fetch(new URL('/', origin))
  if (!page.ok) throw new Error(`GET / responded ${page.status}`)
  const html = await page.text()

  const urls = new Set<string>()
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) if (match[1]) urls.add(match[1])
  for (const match of html.matchAll(/<script[^>]*type="importmap"[^>]*>([^<]*)<\/script>/g)) {
    const importMap = JSON.parse(match[1] ?? '{}') as { imports?: Record<string, string> }
    for (const url of Object.values(importMap.imports ?? {})) urls.add(url)
  }
  // The workspace entry (and with it the editor) loads on `/`, but the languages the editor
  // highlights fenced code with are imported lazily, so compile its whole graph explicitly.
  const workspaceGraph = await assets.getImportMap(['src/app/actions/public/workspace/workspace.tsx'])
  for (const url of Object.values(workspaceGraph.imports ?? {})) urls.add(url)
  urls.add(katexStylesHref)

  for (const url of urls) {
    const response = await router.fetch(new URL(url, origin))
    if (!response.ok) throw new Error(`${url} responded ${response.status}: ${await response.text()}`)
    await response.arrayBuffer()
  }

  console.log(`Rendered / and compiled ${urls.size} browser assets (workspace and editor included).`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
