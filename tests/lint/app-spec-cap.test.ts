import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')
const appSpec = path.join(root, 'tests/e2e/app.spec.ts')

const check = (...args: string[]) => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-app-spec.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const checkGrown = async (grow: (source: string) => string) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'boost-app-spec-'))
  try {
    const grown = path.join(dir, 'app.spec.ts')
    await writeFile(grown, grow(await readFile(appSpec, 'utf8')))
    return check(grown)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Each case spawns the check script; under a loaded parallel suite that can exceed vitest's 5s default.
describe('app.spec.ts test cap', { timeout: 30_000 }, () => {
  it('passes on the committed app.spec.ts', () => {
    expect(check()).toMatchObject({ status: 0 })
  })

  it('fails when app.spec.ts gains one more test, telling the author to add a spec for its concern', async () => {
    const { status, output } = await checkGrown((source) => `${source}\ntest('one more', async () => {})\n`)
    expect(status).not.toBe(0)
    expect(output).toContain('add a spec for its concern')
  })

  it('fails on one more top-level test even when a nested test made room for it', async () => {
    // Turns one nested test into a plain call, so the total stays at its cap while the top level grows by one.
    const { status, output } = await checkGrown(
      (source) =>
        `${source.replace(/^ {2}test\('asks, then rewrites/m, "  it('asks, then rewrites")}\ntest('one more', async () => {})\n`,
    )
    expect(status).not.toBe(0)
    expect(output).toContain('top-level')
  })
})
