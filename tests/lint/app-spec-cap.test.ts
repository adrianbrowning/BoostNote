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

describe('app.spec.ts test cap', () => {
  it('passes on the committed app.spec.ts', () => {
    expect(check()).toMatchObject({ status: 0 })
  })

  it('fails when app.spec.ts gains one more test, telling the author to add a spec for the concern', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'boost-app-spec-'))
    try {
      const grown = path.join(dir, 'app.spec.ts')
      await writeFile(grown, `${await readFile(appSpec, 'utf8')}\ntest('one more', async () => {})\n`)
      const { status, output } = check(grown)
      expect(status).not.toBe(0)
      expect(output).toContain('add a spec for its concern')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
