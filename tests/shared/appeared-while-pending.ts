import { existsSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'

/**
 * Waits, between the vault's own file operations, until `file` exists while `pending` is still under
 * way. Rejects with `pending`'s error when it fails first, and fails when `pending` settled before
 * `file` was seen: a write queued after this wait would then not test the gap inside `pending`.
 */
export async function appearedWhilePending(file: string, pending: Promise<unknown>): Promise<void> {
  let settled = false
  pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  while (!existsSync(file)) {
    if (settled) break
    await setImmediate()
  }
  if (settled) {
    await pending
    throw new Error(`${file}: the relocation settled before the file was seen`)
  }
}
