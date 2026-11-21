import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { markdownFilesIn } from '../../src/main/argv.ts'

describe('markdownFilesIn', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'argv-'))
    await mkdir(path.join(cwd, 'dir.md'))
    for (const name of ['Plan.MD', 'b.Md', 'c.md', 'd.mdx', 'e.markdown', '.md']) {
      await writeFile(path.join(cwd, name), '# x\n')
    }
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('keeps existing note files in any extension case, resolved against cwd, and drops the rest', () => {
    const argv = [
      'electron',
      '--flag',
      'Plan.MD',
      'b.Md',
      path.join(cwd, 'c.md'),
      'd.mdx',
      'e.markdown',
      '.md',
      'dir.md',
      'gone.md',
    ]
    expect(markdownFilesIn(argv, cwd)).toEqual([
      path.join(cwd, 'Plan.MD'),
      path.join(cwd, 'b.Md'),
      path.join(cwd, 'c.md'),
    ])
  })
})
