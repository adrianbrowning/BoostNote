import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const biome = path.join(root, 'node_modules/.bin/biome')
let dir: string

// Biome's stdin mode reports no diagnostics, so each probe is a real file in a copy of the configuration.
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'boost-lint-'))
  await cp(path.join(root, 'biome.json'), path.join(dir, 'biome.json'))
  await cp(path.join(root, 'tests/e2e/rules.grit'), path.join(dir, 'tests/e2e/rules.grit'))
})

afterAll(() => rm(dir, { recursive: true, force: true }))

/** Lints `source` saved at `file` (relative to the repository root) with the repository's Biome configuration. */
const lint = async (file: string, source: string) => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await writeFile(path.join(dir, file), source)
  const result = spawnSync(biome, ['lint', '--vcs-enabled=false', file], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('e2e lint rules', () => {
  it('rejects getComputedStyle in an e2e spec, pointing at toHaveCSS', async () => {
    const { status, output } = await lint(
      'tests/e2e/computed.spec.ts',
      'export const read = (dot) => dot.evaluate((element) => window.getComputedStyle(element).backgroundColor)\n',
    )
    expect(status).not.toBe(0)
    expect(output).toContain('toHaveCSS')
  })

  it("rejects locator('..') DOM traversal in an e2e spec", async () => {
    const { status, output } = await lint(
      'tests/e2e/parent.spec.ts',
      "export const parent = (row) => row.locator('..')\n",
    )
    expect(status).not.toBe(0)
    expect(output).toContain('data-*')
  })

  it('accepts a toHaveCSS assertion and a data-* locator', async () => {
    const { status } = await lint(
      'tests/e2e/clean.spec.ts',
      "export const check = (page, expect) => expect(page.locator('[data-note]')).toHaveCSS('color', 'red')\n",
    )
    expect(status).toBe(0)
  })

  it('leaves getComputedStyle in app code alone', async () => {
    const { status } = await lint(
      'src/app/probe.ts',
      'export const read = (element) => getComputedStyle(element).color\n',
    )
    expect(status).toBe(0)
  })
})
