import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExportResult, OpenRequest } from '../../src/app/actions/public/workspace/types.ts'
import { routes } from '../../src/app/routes.ts'
import type { Vault } from '../../src/vault/index.ts'
import { TestApp } from './helpers.ts'

const api = routes.api
let app: TestApp
let vault: Vault

const NOTE = '# Plan\n\n$x^2$\n\n```mermaid\ngraph TD; A-->B\n```\n\n![s](./plan.assets/s.png)\n'

beforeEach(async () => {
  app = await TestApp.create()
  vault = await app.openVault()
  await mkdir(path.join(vault.root, 'work/plan.assets'), { recursive: true })
  await writeFile(path.join(vault.root, 'work/plan.md'), NOTE)
  await writeFile(path.join(vault.root, 'work/plan.assets/s.png'), 'png')
  await writeFile(path.join(vault.root, 'index.md'), '[plan](work/plan.md)\n')
  await vault.refresh()
})

afterEach(async () => {
  await app.close()
})

async function exportNote(format: string): Promise<ExportResult> {
  const response = await app.post(api.exportNote.href(), { id: 'work/plan.md', format })
  expect(response.status).toBe(200)
  return response.json()
}

describe('POST /api/export/note', () => {
  it('writes standalone HTML with math, diagrams and inlined assets', async () => {
    const target = path.join(app.dir, 'out.html')
    app.saves.push(target)
    expect(await exportNote('html')).toEqual({ path: target })
    expect(app.saveCalls[0]).toMatchObject({ defaultPath: 'plan.html', filters: [{ extensions: ['html'] }] })
    const html = await readFile(target, 'utf8')
    expect(html).toContain('class="katex"')
    expect(html).toContain('<svg data-fake-mermaid=')
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from('png').toString('base64')}"`)
  })

  it('writes the PDF the printer produced and prints without a dialog', async () => {
    const target = path.join(app.dir, 'out.pdf')
    app.saves.push(target)
    expect(await exportNote('pdf')).toEqual({ path: target })
    expect(await readFile(target, 'utf8')).toBe('%PDF-fake')
    expect(app.pdfs[0]).toContain('<svg data-fake-mermaid=')

    expect(await exportNote('print')).toEqual({ path: null })
    expect(app.saveCalls).toHaveLength(1)
    expect(app.printed[0]).toContain('class="katex"')
  })

  it('copies markdown with its assets', async () => {
    const target = path.join(app.dir, 'copy.md')
    app.saves.push(target)
    await exportNote('markdown')
    expect(await readFile(target, 'utf8')).toContain('](./copy.assets/s.png)')
    expect(await readdir(path.join(app.dir, 'copy.assets'))).toEqual(['s.png'])
  })

  it('handles cancel, unknown formats and missing notes', async () => {
    expect(await exportNote('html')).toEqual({ path: null })
    expect((await app.post(api.exportNote.href(), { id: 'work/plan.md', format: 'docx' })).status).toBe(400)
    expect((await app.post(api.exportNote.href(), { id: 'nope.md', format: 'html' })).status).toBe(404)
  })
})

describe('POST /api/export/folder', () => {
  it('creates a new folder with an index and pages, and reveals it', async () => {
    app.picks.push(app.dir, app.dir, app.dir)
    const first: ExportResult = await (await app.post(api.exportFolder.href(), { folder: '' })).json()
    const site = path.join(app.dir, 'vault (HTML)')
    expect(first.path).toBe(site)
    // The vault's own index.md becomes index.html; the generated listing moves aside.
    expect((await readdir(site)).sort()).toEqual(['_contents.html', 'index.html', 'work'])
    expect(await readFile(path.join(site, 'index.html'), 'utf8')).toContain('href="work/plan.html"')
    expect(await readFile(path.join(site, '_contents.html'), 'utf8')).toContain('href="work/plan.html"')
    expect(app.revealed).toEqual([path.join(site, '_contents.html')])

    const second: ExportResult = await (await app.post(api.exportFolder.href(), { folder: 'work' })).json()
    expect(second.path).toBe(path.join(app.dir, 'work (HTML)'))
    expect((await readdir(second.path ?? '')).sort()).toEqual(['index.html', 'plan.html'])
    const again: ExportResult = await (await app.post(api.exportFolder.href(), { folder: '' })).json()
    expect(again.path).toBe(path.join(app.dir, 'vault (HTML) 2'))
    expect((await app.post(api.exportFolder.href(), { folder: 'missing' })).status).toBe(404)
  })
})

describe('POST /api/open-request', () => {
  it('hands out queued files opened from the OS once each, in order, as notes of the open vault', async () => {
    const take = async (): Promise<OpenRequest | null> => (await app.post(api.openRequest.href())).json()
    expect(await take()).toBeNull()
    app.vaults.requestOpen(path.join(vault.root, 'work', 'plan.md'))
    app.vaults.requestOpen(path.join(vault.root, 'missing.md'))
    app.vaults.requestOpen(path.join(vault.root, 'index.md'))
    expect(await take()).toEqual({ kind: 'note', vault: vault.root, id: 'work/plan.md' })
    expect(await take()).toEqual({ kind: 'note', vault: vault.root, id: 'index.md' })
    expect(await take()).toBeNull()
  })
})
