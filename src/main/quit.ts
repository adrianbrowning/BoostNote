/** How long quitting waits for every teardown step (asset server dev watcher, event hub, vaults) to settle. */
export const QUIT_TEARDOWN_TIMEOUT_MS = 2000

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

/** One named quit-time teardown step; a failure is logged as `Could not close ${name}`. */
export interface TeardownStep {
  name: string
  run(): void | Promise<void>
}

interface QuitDisposalOptions {
  /**
   * Teardown steps run once, together, when disposal starts. Each is guarded on its own, so one that
   * throws or rejects is logged and never skips another; returned promises are awaited together.
   */
  teardown: ReadonlyArray<TeardownStep>
  /** Quits for real (`app.quit()`); emits `before-quit` again, which then passes through. */
  quit(): void
  timeoutMs?: number
}

/**
 * The `before-quit` handler once leaving is confirmed: the first quit is held (`preventDefault`)
 * while `teardown` runs, bounded by `timeoutMs` so a step that throws, fails or never settles still
 * quits; repeated quits meanwhile are held too, and the final `quit()` passes through.
 */
export function createQuitDisposal({
  teardown,
  quit,
  timeoutMs = QUIT_TEARDOWN_TIMEOUT_MS,
}: QuitDisposalOptions): (event: { preventDefault(): void }) => Promise<void> {
  let state: 'pending' | 'running' | 'done' = 'pending'
  return async (event) => {
    if (state === 'done') return
    event.preventDefault()
    if (state === 'running') return
    state = 'running'
    await raceTimeout(
      Promise.all(teardown.map(({ name, run }) => logFailure(`Could not close ${name}`, run))),
      timeoutMs,
    )
    state = 'done'
    quit()
  }
}
