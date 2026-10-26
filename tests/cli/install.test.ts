import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installShim, shimScript, windowsCommands } from '../../src/cli/install.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'boost-shim-'))
})

afterEach(async () => {
  await chmod(path.join(root, 'system'), 0o755).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('command line tool shim', () => {
  it('installs into the first writable folder and runs the app binary as Node', async () => {
    // A stand-in "app binary" (in a folder with a space and a quote) that prints what it was given.
    const appDir = path.join(root, "My Apps/Boost'note.app")
    await mkdir(appDir, { recursive: true })
    const executable = path.join(appDir, 'Boostnote')
    await writeFile(
      executable,
      '#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "arg:$a"; done\n',
    )
    await chmod(executable, 0o755)
    const target = { executable, entry: path.join(appDir, 'src/cli/index.js') }

    const system = path.join(root, 'system')
    await mkdir(system)
    await chmod(system, 0o555)
    const user = path.join(root, 'home/.local/bin')
    const result = await installShim(target, [system, user], `/usr/bin${path.delimiter}${user}`)
    expect(result).toEqual({ file: path.join(user, 'boostnote'), onPath: true })
    expect((await stat(result.file)).mode & 0o777).toBe(0o755)
    expect(await readFile(result.file, 'utf8')).toBe(shimScript(target))

    const { stdout } = await promisify(execFile)(result.file, ['search', 'two words'])
    expect(stdout).toBe(`RUN_AS_NODE=1\narg:${target.entry}\narg:search\narg:two words\n`)
  })

  it('uses the first folder when writable, says when it is not on PATH, and replaces only its own shim', async () => {
    const target = { executable: '/Applications/Boostnote.app/Contents/MacOS/Boostnote', entry: '/x/src/cli/index.js' }
    const first = path.join(root, 'bin')
    await mkdir(first)
    expect(await installShim(target, [first, path.join(root, 'other')], '/usr/bin')).toEqual({
      file: path.join(first, 'boostnote'),
      onPath: false,
    })
    // Reinstalling (the app moved) replaces the Boostnote shim…
    const moved = { ...target, executable: '/Apps/Boostnote.app/Contents/MacOS/Boostnote' }
    await installShim(moved, [first], '')
    expect(await readFile(path.join(first, 'boostnote'), 'utf8')).toContain(
      "'/Apps/Boostnote.app/Contents/MacOS/Boostnote'",
    )
    // …but never somebody else's `boostnote`.
    await writeFile(path.join(first, 'boostnote'), '#!/bin/sh\necho mine\n')
    await expect(installShim(target, [first], '')).rejects.toThrow(/already exists and was not installed by Boostnote/)
    expect(await readFile(path.join(first, 'boostnote'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
})

describe('Windows instructions', () => {
  it('shows the PowerShell and cmd commands', () => {
    const text = windowsCommands({
      executable: 'C:\\Boostnote\\Boostnote.exe',
      entry: 'C:\\Boostnote\\resources\\app\\src\\cli\\index.js',
    })
    expect(text).toContain(
      '$env:ELECTRON_RUN_AS_NODE=1; & "C:\\Boostnote\\Boostnote.exe" "C:\\Boostnote\\resources\\app\\src\\cli\\index.js" search todo',
    )
    expect(text).toContain('set "ELECTRON_RUN_AS_NODE=1" && "C:\\Boostnote\\Boostnote.exe"')
  })
})
