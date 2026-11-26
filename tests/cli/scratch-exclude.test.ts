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

async function cli(vault: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runCli(['--vault', vault, 'list'], {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    stdin: async () => undefined,
    env,
  })
  return { code, stdout, stderr }
}

describe('the CLI and the scratch notes’ folder', () => {
  it('opens a vault that holds the app’s scratch folder without its scratch notes, and refuses the scratch folder', async () => {
    const scratch = path.join(appUserDataDir(env), 'scratch')
    await mkdir(scratch, { recursive: true })
    await writeFile(path.join(scratch, `${'a'.repeat(32)}.md`), '# Scratch')
    await writeFile(path.join(home.dir, 'kept.md'), '# Kept')

    const holder = await cli(home.dir)
    expect(holder.code).toBe(0)
    expect(holder.stdout).toContain('kept')
    expect(holder.stdout).not.toContain('a'.repeat(32))
    const refused = await cli(scratch)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('overlaps the scratch notes’ folder')
  })
})
