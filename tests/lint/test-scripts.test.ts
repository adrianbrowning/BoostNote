import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

const run = (script: string, PATH: string) => {
  const result = spawnSync('/bin/bash', [path.join(root, 'scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH, HOME: process.env.HOME ?? '' },
  })
  return { status: result.status, stderr: result.stderr }
}

describe('test scripts error branches', () => {
  let bin: string
  beforeEach(async () => {
    bin = await mkdtemp(path.join(tmpdir(), 'boost-script-bin-'))
  })
  afterEach(async () => {
    await rm(bin, { recursive: true, force: true })
  })

  it('test:case-sensitive stops with a clear error off macOS', async () => {
    const uname = path.join(bin, 'uname')
    await writeFile(uname, '#!/bin/sh\necho Linux\n')
    await chmod(uname, 0o755)
    const { status, stderr } = run('test-case-sensitive.sh', `${bin}:/usr/bin:/bin`)
    expect(status).toBe(1)
    expect(stderr).toContain('needs macOS')
    expect(stderr).not.toContain('hdiutil: command not found')
  })

  it('test:linux stops with a clear error when docker is not on PATH', () => {
    // An empty PATH dir: the docker check runs before any external command.
    const { status, stderr } = run('test-linux.sh', bin)
    expect(status).toBe(1)
    expect(stderr).toContain('docker is not on PATH')
  })
})
