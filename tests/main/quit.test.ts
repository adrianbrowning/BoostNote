import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { createQuitDisposal, raceTimeout, type TeardownStep } from '../../src/main/quit.ts'

interface QuitEvent {
  preventDefault: Mock<() => void>
}

function quitEvent(): QuitEvent {
  return { preventDefault: vi.fn() }
}

function step(name: string, run: () => void | Promise<void>): TeardownStep {
  return { name, run }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('raceTimeout', () => {
  it('settles with the promise value, even false, when the promise wins', async () => {
    await expect(raceTimeout(Promise.resolve(false), 1000)).resolves.toBe(false)
  })

  it("settles with 'timeout' and clears its timer when the timer wins", async () => {
    const result = raceTimeout(new Promise(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createQuitDisposal', () => {
  it('holds the quit until the asset server has closed', async () => {
    const { promise: closed, resolve: finishClose } = Promise.withResolvers<void>()
    const quit = vi.fn()
    const dispose = vi.fn()
    const beforeQuit = createQuitDisposal({
      teardown: [step('the hub', dispose), step('the asset server', () => closed)],
      quit,
      timeoutMs: 1000,
    })

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
      teardown: [step('the asset server', () => new Promise<void>(() => {}))],
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

  it('quits when closing fails, logging the step by name', async () => {
    const quit = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const beforeQuit = createQuitDisposal({
      teardown: [step('the asset server', () => Promise.reject(new Error('boom')))],
      quit,
      timeoutMs: 1000,
    })
    await beforeQuit(quitEvent())
    expect(quit).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('Could not close the asset server', expect.objectContaining({ message: 'boom' }))
  })

  it('logs a throwing step and still closes the asset server and quits', async () => {
    const { promise: closed, resolve: finishClose } = Promise.withResolvers<void>()
    const quit = vi.fn()
    const close = vi.fn(() => closed)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const beforeQuit = createQuitDisposal({
      teardown: [
        step('the hub', () => {
          throw new Error('hub')
        }),
        step('the asset server', close),
      ],
      quit,
      timeoutMs: 1000,
    })

    const done = beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(500)
    expect(close).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()

    finishClose()
    await done
    expect(quit).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('Could not close the hub', expect.objectContaining({ message: 'hub' }))
  })

  it('runs every step and logs each failure when one throws and another rejects', async () => {
    const quit = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const vaults = vi.fn(() => Promise.reject(new Error('vaults')))
    const beforeQuit = createQuitDisposal({
      teardown: [
        step('the hub', () => {
          throw new Error('hub')
        }),
        step('the vaults', vaults),
        step('the asset server', () => Promise.resolve()),
      ],
      quit,
      timeoutMs: 1000,
    })
    await beforeQuit(quitEvent())
    expect(vaults).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('Could not close the hub', expect.objectContaining({ message: 'hub' }))
    expect(error).toHaveBeenCalledWith('Could not close the vaults', expect.objectContaining({ message: 'vaults' }))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('waits for a pending step up to the bound', async () => {
    const quit = vi.fn()
    const beforeQuit = createQuitDisposal({
      teardown: [
        step('the hub', () => {}),
        step('the vaults', () => new Promise<void>(() => {})),
        step('the asset server', () => Promise.resolve()),
      ],
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

  it('quits once a pending step settles', async () => {
    const { promise: disposed, resolve: finishDispose } = Promise.withResolvers<void>()
    const quit = vi.fn()
    const beforeQuit = createQuitDisposal({
      teardown: [step('the vaults', () => disposed), step('the asset server', () => Promise.resolve())],
      quit,
      timeoutMs: 1000,
    })
    const done = beforeQuit(quitEvent())

    await vi.advanceTimersByTimeAsync(500)
    expect(quit).not.toHaveBeenCalled()

    finishDispose()
    await done
    expect(quit).toHaveBeenCalledTimes(1)
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
    const dispose = vi.fn()
    const beforeQuit = createQuitDisposal({
      teardown: [step('the hub', dispose), step('the asset server', close)],
      quit,
      timeoutMs: 1000,
    })

    const done = beforeQuit(quitEvent())
    const repeated = quitEvent()
    await beforeQuit(repeated)
    expect(repeated.preventDefault).toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)

    finishClose()
    await done
    expect(quit).toHaveBeenCalledTimes(1)
    expect(finalEvents).toHaveLength(1)
    expect(finalEvents[0]?.preventDefault).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
