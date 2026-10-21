import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { katexStylesHref } from '../../src/app/assets.ts'
import { routes } from '../../src/app/routes.ts'
import { TestApp } from './helpers.ts'

let app: TestApp

beforeEach(async () => {
  app = await TestApp.create()
})

afterEach(async () => {
  await app.close()
})

describe('router', () => {
  it('GET / renders the workspace document with the client entry', async () => {
    const response = await app.get(routes.home.href())
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
    expect(html).toContain(`href="${katexStylesHref}"`)
  })

  it('server-renders the open vault: folders, tags and notes', async () => {
    const vault = await app.openVault('Notes')
    await vault.createFolder('', 'Work')
    await vault.createNote('Work', 'Quarterly plan', { frontmatter: { tags: ['planning'] } })

    const html = await (await app.get('/')).text()
    expect(html).toContain('data-vault="open"')
    expect(html).toContain('data-folder="Work"')
    expect(html).toContain('data-tag="planning"')
    expect(html).toContain('Quarterly plan')
  })

  it('sends a nonce-based Content-Security-Policy that matches the import map', async () => {
    const response = await app.get('/')
    const policy = response.headers.get('Content-Security-Policy') ?? ''
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1]
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("img-src 'self'")
    expect(nonce).toBeTruthy()
    expect(await response.text()).toContain(`type="importmap" nonce="${nonce}"`)

    const second = await app.get('/')
    expect(second.headers.get('Content-Security-Policy')).not.toContain(`'nonce-${nonce}'`)
  })

  it('serves the compiled client entries from the asset server', async () => {
    const page = await (await app.get('/')).text()
    const src = page.match(/<script type="module" src="([^"]+)"/)?.[1]
    if (!src) throw new Error('no client entry script')

    const response = await app.get(src)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/javascript/)
    expect(await response.text()).toContain('loadModule')

    const workspace = page.match(/"(\/assets\/src\/app\/actions\/public\/workspace\/workspace\.@[^"]+\.tsx)"/)?.[1]
    if (!workspace) throw new Error('no workspace client entry in the page')
    expect((await app.get(workspace)).status).toBe(200)
  })

  it('GET /events opens an SSE stream on the shared hub', async () => {
    const controller = new AbortController()
    const response = await app.router.fetch(
      new Request(new URL(routes.events.href(), 'http://app'), { signal: controller.signal }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/event-stream/)
    expect(app.events.size).toBe(1)

    controller.abort()
    expect(app.events.size).toBe(0)
  })

  it('returns 404 for unknown routes, including the removed developer pages', async () => {
    expect((await app.get('/no-such-page')).status).toBe(404)
    expect((await app.get('/dev/editor')).status).toBe(404)
  })

  it('maps the vendored mermaid build in the import map and serves only allow-listed files', async () => {
    const html = await (await app.get('/')).text()
    expect(html).toContain('"mermaid/dist/mermaid.esm.min.mjs":"/vendor/mermaid/mermaid.esm.min.mjs"')

    const entry = await app.get('/vendor/mermaid/mermaid.esm.min.mjs')
    expect(entry.status).toBe(200)
    expect(entry.headers.get('Content-Type')).toMatch(/javascript/)
    const chunk = (await entry.text()).match(/"\.\/(chunks\/mermaid\.esm\.min\/[\w-]+\.mjs)"/)?.[1]
    expect((await app.get(`/vendor/mermaid/${chunk}`)).status).toBe(200)

    for (const path of ['/vendor/mermaid/../package.json', '/vendor/mermaid/mermaid.js', '/vendor/other/x.mjs']) {
      expect((await app.get(path)).status).toBe(404)
    }
  })

  it('serves the KaTeX stylesheet and fonts through the asset server', async () => {
    const css = await (await app.get(katexStylesHref)).text()
    const font = css.match(/url\("?([^")]+\.woff2)"?\)/)?.[1]
    if (!font) throw new Error('no KaTeX font in stylesheet')
    const response = await app.get(font)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/font\/woff2/)
  })
})
