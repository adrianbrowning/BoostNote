import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { createQuitDisposal } from '../../src/main/quit.ts'

interface QuitEvent {
  preventDefault: Mock<() => void>
}

function quitEvent(): QuitEvent {
  return { preventDefault: vi.fn() }
}

describe('createQuitDisposal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the quit until the asset server has closed', async () => {
    const { promise: closed, resolve: finishClose } = Promise.withResolvers<void>()
    const quit = vi.fn()
    const dispose = vi.fn()
    const beforeQuit = createQuitDisposal({ server: { close: () => closed }, dispose, quit, timeoutMs: 1000 })

    const event = quitEvent()
    const done = beforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(quit).not.toHaveBeenCalled()

    finishClose()
    await done
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('quits after the bound when closing never settles', async () => {
    const quit = vi.fn()
    const beforeQuit = createQuitDisposal({
      server: { close: () => new Promise<void>(() => {}) },
      dispose: () => {},
      quit,
      timeoutMs: 1000,
    })
    const done = beforeQuit(quitEvent())

    await vi.advanceTimersByTimeAsync(999)
    expect(quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('quits when closing fails', async () => {
    const quit = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const beforeQuit = createQuitDisposal({
      server: { close: () => Promise.reject(new Error('boom')) },
      dispose: () => {},
      quit,
      timeoutMs: 1000,
    })
    await beforeQuit(quitEvent())
    expect(quit).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('holds repeated quits while closing, then lets the final quit through', async () => {
    const { promise: closed, resolve: finishClose } = Promise.withResolvers<void>()
    const finalEvents: QuitEvent[] = []
    const close = vi.fn(() => closed)
    // Like `app.quit()`: quitting emits `before-quit` again, synchronously.
    const quit = vi.fn(() => {
      const event = quitEvent()
      finalEvents.push(event)
      void beforeQuit(event)
    })
    const beforeQuit = createQuitDisposal({ server: { close }, dispose: () => {}, quit, timeoutMs: 1000 })

    const done = beforeQuit(quitEvent())
    const repeated = quitEvent()
    await beforeQuit(repeated)
    expect(repeated.preventDefault).toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)

    finishClose()
    await done
    expect(quit).toHaveBeenCalledTimes(1)
    expect(finalEvents).toHaveLength(1)
    expect(finalEvents[0]?.preventDefault).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
