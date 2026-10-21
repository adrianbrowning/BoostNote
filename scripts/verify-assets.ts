// `pnpm build` gate. Nothing is transpiled ahead of time (the main process runs TS/JSX through
// remix/node-tsx and the asset server compiles browser modules on request), so instead this renders
// the document with production settings and compiles every browser asset it references, failing on
// the first error. Run before packaging so broken client code never ships.
process.env.NODE_ENV = 'production'

// Dynamic so NODE_ENV is set before assets.ts reads it.
const { router } = await import('../src/app/router.ts')
const { assets, katexStylesHref } = await import('../src/app/assets.ts')
const origin = 'http://app'

const page = await router.fetch(new URL('/', origin))
if (!page.ok) throw new Error(`GET / responded ${page.status}`)
const html = await page.text()

const urls = new Set<string>()
for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) if (match[1]) urls.add(match[1])
for (const match of html.matchAll(/<script[^>]*type="importmap"[^>]*>([^<]*)<\/script>/g)) {
  const importMap = JSON.parse(match[1] ?? '{}') as { imports?: Record<string, string> }
  for (const url of Object.values(importMap.imports ?? {})) urls.add(url)
}
// The live-preview editor (and every language it lazy-loads) is not on `/` until the workspace lands.
const editorGraph = await assets.getImportMap(['src/editor/index.ts'])
for (const url of Object.values(editorGraph.imports ?? {})) urls.add(url)
urls.add(katexStylesHref)

for (const url of urls) {
  const response = await router.fetch(new URL(url, origin))
  if (!response.ok) throw new Error(`${url} responded ${response.status}: ${await response.text()}`)
  await response.arrayBuffer()
}

console.log(`Rendered / and compiled ${urls.size} browser assets (including the editor).`)
