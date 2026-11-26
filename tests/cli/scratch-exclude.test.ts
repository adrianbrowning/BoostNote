import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../../src/cli/main.ts'
import { appUserDataDir } from '../../src/cli/vault-dir.ts'

/** The home folder `os.homedir()` answers, so the app's userData lies inside the test folder. */
const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof Os>()
  return { ...os, homedir: () => home.dir }
})

let env: NodeJS.ProcessEnv

beforeEach(async () => {
  home.dir = await mkdtemp(path.join(tmpdir(), 'cli-scratch-'))
  // Linux and Windows read these instead of the home folder; keep them inside it, visible to the vault.
  env = { XDG_CONFIG_HOME: path.join(home.dir, 'config'), APPDATA: path.join(home.dir, 'config') }
})

afterEach(async () => {
  await rm(home.dir, { recursive: true, force: true })
})

async function cli(vault: string): Promise<{ code: number; stderr: string }> {
  let stderr = ''
  const code = await runCli(['--vault', vault, 'list'], {
    stdout: () => {},
    stderr: (text) => {
      stderr += text
    },
    stdin: async () => undefined,
    env,
  })
  return { code, stderr }
}

describe('the CLI and the scratch notes’ folder', () => {
  it('refuses a vault that holds the app’s scratch folder, and still opens one elsewhere', async () => {
    const scratch = path.join(appUserDataDir(env), 'scratch')
    await mkdir(scratch, { recursive: true })
    await writeFile(path.join(scratch, `${'a'.repeat(32)}.md`), '# Scratch')
    const elsewhere = path.join(home.dir, 'notes')
    await mkdir(elsewhere)

    const refused = await cli(home.dir)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('overlaps the scratch notes’ folder')
    expect((await cli(scratch)).code).not.toBe(0)
    expect((await cli(elsewhere)).code).toBe(0)
  })
})
