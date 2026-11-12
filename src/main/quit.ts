/** How long quitting waits for the asset server (its dev file watcher) to close. */
export const ASSET_CLOSE_TIMEOUT_MS = 2000

interface QuitDisposalOptions {
  /** The asset server; closing it stops its dev file watcher. */
  server: { close(): Promise<void> }
  /** Synchronous teardown run once, when disposal starts. */
  dispose(): void
  /** Quits for real (`app.quit()`); emits `before-quit` again, which then passes through. */
  quit(): void
  timeoutMs?: number
}

/**
 * The `before-quit` handler once leaving is confirmed: the first quit is held (`preventDefault`)
 * while the asset server closes, bounded by `timeoutMs` so a close that fails or never settles
 * still quits; repeated quits meanwhile are held too, and the final `quit()` passes through.
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
    dispose()
    const { promise: timeout, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, timeoutMs)
    try {
      await Promise.race([server.close(), timeout])
    } catch (error) {
      console.error('Could not close the asset server', error)
    } finally {
      clearTimeout(timer)
    }
    state = 'done'
    quit()
  }
}
