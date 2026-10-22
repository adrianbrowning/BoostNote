/**
 * "Install Command Line Tool…": writes a `boostnote` shell shim that runs the CLI on the app's own
 * binary (`ELECTRON_RUN_AS_NODE=1 <app exe> <app>/src/cli/index.js "$@"`), so no separate Node is
 * needed. Plain Node (the main process supplies the paths and shows the result).
 */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** What the shim runs. */
export interface CliTarget {
  /** The app binary (`process.execPath` in the main process). */
  executable: string
  /** Absolute path of src/cli/index.js inside the app. */
  entry: string
}

export interface InstallResult {
  file: string
  /** Whether the shim's folder is on the user's PATH (so `boostnote` works as typed). */
  onPath: boolean
}

const MARKER = '# boostnote-cli-shim'

/** Single-quotes `value` for sh. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function shimScript(target: CliTarget): string {
  return `#!/bin/sh
${MARKER}: installed by Boostnote (Install Command Line Tool…); runs the Boostnote command line on the app's own runtime.
ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(target.executable)} ${shellQuote(target.entry)} "$@"
`
}

/** The commands a Windows user runs instead (no shim is installed there). */
export function windowsCommands(target: CliTarget): string {
  return [
    'PowerShell:',
    `  $env:ELECTRON_RUN_AS_NODE=1; & "${target.executable}" "${target.entry}" search todo`,
    'Command Prompt:',
    `  set "ELECTRON_RUN_AS_NODE=1" && "${target.executable}" "${target.entry}" search todo`,
  ].join('\n')
}

/** Default places for the shim: `/usr/local/bin` when writable, else `~/.local/bin` (created if needed). */
export function defaultShimDirs(home = os.homedir()): string[] {
  return ['/usr/local/bin', path.join(home, '.local', 'bin')]
}

/**
 * Writes `<dir>/boostnote` into the first of `dirs` that is writable; the last one is created when
 * missing. An existing `boostnote` that is not a Boostnote shim is never replaced.
 */
export async function installShim(target: CliTarget, dirs: readonly string[], pathEnv: string): Promise<InstallResult> {
  for (const [index, dir] of dirs.entries()) {
    const last = index === dirs.length - 1
    if (last) await mkdir(dir, { recursive: true })
    try {
      await access(dir, constants.W_OK)
    } catch {
      if (last) throw new Error(`Cannot write to ${dir}`)
      continue
    }
    const file = path.join(dir, 'boostnote')
    const existing = await readFile(file, 'utf8').catch(() => undefined)
    if (existing !== undefined && !existing.includes(MARKER)) {
      throw new Error(`${file} already exists and was not installed by Boostnote. Remove it and try again.`)
    }
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, shimScript(target), { mode: 0o755 })
    await chmod(temp, 0o755)
    await rename(temp, file)
    const onPath = pathEnv.split(path.delimiter).some((entry) => entry !== '' && path.resolve(entry) === dir)
    return { file, onPath }
  }
  throw new Error('No folder to install the command line tool into')
}

/**
 * The PATH of the user's login shell: apps started from the Dock/Finder get a minimal PATH, so
 * `process.env.PATH` would not show what the user's terminal sees. Falls back to `fallback`.
 */
export function loginShellPath(shell: string | undefined, fallback: string): Promise<string> {
  if (!shell) return Promise.resolve(fallback)
  const { promise, resolve } = Promise.withResolvers<string>()
  execFile(shell, ['-ilc', 'printf "\\n%s" "$PATH"'], { timeout: 3000 }, (error, stdout) => {
    const line = stdout.split('\n').at(-1)?.trim()
    resolve(error || !line ? fallback : line)
  })
  return promise
}
