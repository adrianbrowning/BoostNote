import { describe, expect, it } from 'vitest'

import { katexStylesHref } from '../../src/app/assets.ts'
import { router } from '../../src/app/router.ts'
import { devRoutes, routes } from '../../src/app/routes.ts'
import { eventHub } from '../../src/main/events.ts'

const origin = 'http://app'

describe('router', () => {
  it('GET / renders the workspace document with the client entry', async () => {
    const response = await router.fetch(new URL(routes.home.href(), origin))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/text\/html/)

    const html = await response.text()
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toMatch(
      /<script type="module" src="\/assets\/src\/app\/actions\/public\/entry\.@[^"]+\.ts"><\/script>/,
    )
    expect(html).toContain('type="importmap"')
    expect(html).toContain('No vault open')
    expect(html).toContain('data-connection="connecting"')
  })

  it('sends a nonce-based Content-Security-Policy that matches the import map', async () => {
    const response = await router.fetch(new URL('/', origin))
    const policy = response.headers.get('Content-Security-Policy') ?? ''
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1]
    expect(policy).toContain("default-src 'none'")
    expect(nonce).toBeTruthy()
    expect(await response.text()).toContain(`type="importmap" nonce="${nonce}"`)

    const second = await router.fetch(new URL('/', origin))
    expect(second.headers.get('Content-Security-Policy')).not.toContain(`'nonce-${nonce}'`)
  })

  it('serves the compiled client entry from the asset server', async () => {
    const page = await (await router.fetch(new URL('/', origin))).text()
    const src = page.match(/<script type="module" src="([^"]+)"/)?.[1]
    if (!src) throw new Error('no client entry script')

    const response = await router.fetch(new URL(src, origin))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/javascript/)
    expect(await response.text()).toContain('loadModule')
  })

  it('GET /events opens an SSE stream on the shared hub', async () => {
    const controller = new AbortController()
    const response = await router.fetch(
      new Request(new URL(routes.events.href(), origin), { signal: controller.signal }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/event-stream/)
    expect(eventHub.size).toBe(1)

    controller.abort()
    expect(eventHub.size).toBe(0)
  })

  it('returns 404 for unknown routes', async () => {
    const response = await router.fetch(new URL('/no-such-page', origin))
    expect(response.status).toBe(404)
  })

  it('maps the vendored mermaid build in the import map and serves only allow-listed files', async () => {
    const html = await (await router.fetch(new URL('/', origin))).text()
    expect(html).toContain('"mermaid/dist/mermaid.esm.min.mjs":"/vendor/mermaid/mermaid.esm.min.mjs"')

    const entry = await router.fetch(new URL('/vendor/mermaid/mermaid.esm.min.mjs', origin))
    expect(entry.status).toBe(200)
    expect(entry.headers.get('Content-Type')).toMatch(/javascript/)
    const chunk = (await entry.text()).match(/"\.\/(chunks\/mermaid\.esm\.min\/[\w-]+\.mjs)"/)?.[1]
    expect((await router.fetch(new URL(`/vendor/mermaid/${chunk}`, origin))).status).toBe(200)

    for (const path of ['/vendor/mermaid/../package.json', '/vendor/mermaid/mermaid.js', '/vendor/other/x.mjs']) {
      expect((await router.fetch(new URL(path, origin))).status).toBe(404)
    }
  })

  it('serves the KaTeX stylesheet and fonts through the asset server', async () => {
    const css = await (await router.fetch(new URL(katexStylesHref, origin))).text()
    const font = css.match(/url\("?([^")]+\.woff2)"?\)/)?.[1]
    if (!font) throw new Error('no KaTeX font in stylesheet')
    const response = await router.fetch(new URL(font, origin))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/font\/woff2/)
  })

  it('does not expose the developer pages outside development', async () => {
    const response = await router.fetch(new URL(devRoutes.editor.href(), origin))
    expect(response.status).toBe(404)
  })
})
