import { describe, expect, it } from 'vitest'

import { restoreFromTrash } from '../../src/cli/commands.ts'
import type { Vault } from '../../src/vault/index.ts'

describe('restoreFromTrash', () => {
  it('returns the vault restore result without asking whether the note exists', async () => {
    const vault = {
      restore: async (trashId: string) => ({ id: `${trashId} 2`, kind: 'folder' as const }),
      hasNote: () => {
        throw new Error('hasNote must not be called')
      },
    } as unknown as Vault
    expect(await restoreFromTrash(vault, ' Ideas ')).toEqual({ id: 'Ideas 2', kind: 'folder' })
  })
})
