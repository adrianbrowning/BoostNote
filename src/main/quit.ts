/** How long quitting waits for the asset server (its dev file watcher) and the vaults to close. */
export const ASSET_CLOSE_TIMEOUT_MS = 2000

/** Settles with `promise`, or with `'timeout'` after `ms`; the timer is always cleared. */
export async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  const { promise: timeout, resolve } = Promise.withResolvers<'timeout'>()
  const timer = setTimeout(() => resolve('timeout'), ms)
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `teardown`, logging (not propagating) a synchronous throw or a rejection. */
async function logFailure(message: string, teardown: () => void | Promise<void>): Promise<void> {
  try {
    await teardown()
  } catch (error) {
    console.error(message, error)
  }
}

interface QuitDisposalOptions {
  /** The asset server; closing it stops its dev file watcher. */
  server: { close(): Promise<void> }
  /** Teardown run once, when disposal starts; a returned promise is awaited alongside the server. */
  dispose(): void | Promise<void>
  /** Quits for real (`app.quit()`); emits `before-quit` again, which then passes through. */
  quit(): void
  timeoutMs?: number
}

/**
 * The `before-quit` handler once leaving is confirmed: the first quit is held (`preventDefault`)
 * while `dispose` and the asset server close, bounded by `timeoutMs` so a teardown that throws,
 * fails or never settles still quits; repeated quits meanwhile are held too, and the final `quit()`
 * passes through.
 */
export function createQuitDisposal({
  server,
  dispose,
  quit,
  timeoutMs = ASSET_CLOSE_TIMEOUT_MS,
}: QuitDisposalOptions): (event: { preventDefault(): void }) => Promise<void> {
  let state: 'pending' | 'running' | 'done' = 'pending'
  return async (event) => {
    if (state === 'done') return
    event.preventDefault()
    if (state === 'running') return
    state = 'running'
    await raceTimeout(
      Promise.all([
        logFailure('Could not dispose before quitting', dispose),
        logFailure('Could not close the asset server', () => server.close()),
      ]),
      timeoutMs,
    )
    state = 'done'
    quit()
  }
}
