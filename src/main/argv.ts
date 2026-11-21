import { statSync } from 'node:fs'
import * as path from 'node:path'

import { isNoteFileName } from '../shared/vault-ids.ts'

/** Existing note files on a command line (Windows/Linux file associations, `electron . Plan.MD`), resolved against `cwd`. */
export function markdownFilesIn(argv: readonly string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && isNoteFileName(path.basename(arg)))
    .map((arg) => path.resolve(cwd, arg))
    .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)
}
