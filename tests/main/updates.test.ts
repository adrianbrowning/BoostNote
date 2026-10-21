import { afterEach, describe, expect, it } from 'vitest'

import {
  type Clock,
  checkForUpdate,
  compareVersions,
  createUpdater,
  isUpdateShown,
  type UpdateResult,
} from '../../src/main/updates.ts'
import { TestApp } from '../app/helpers.ts'

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
  })

  it('ranks a prerelease below its release, per semver precedence', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1] ?? '', ordered[i] ?? '')).toBe(-1)
  })

  it('accepts a v prefix and ignores build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })

  it('returns undefined for invalid versions', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'latest', '01.2.3', '1.2.3-']) {
      expect(compareVersions(bad, '1.0.0')).toBeUndefined()
    }
  })
})

const release = {
  tag_name: 'v1.5.0',
  html_url: 'https://github.com/adrianbrowning/BoostNote/releases/tag/v1.5.0',
  name: 'Boostnote 1.5.0',
}

function fakeFetch(respond: () => Response | Promise<Response>): typeof fetch {
  return (async () => respond()) as typeof fetch
}

describe('checkForUpdate', () => {
  it('reports a newer published release', async () => {
    const result = await checkForUpdate({ currentVersion: '1.4.2', fetch: fakeFetch(() => Response.json(release)) })
    expect(result).toEqual({ status: 'update', version: '1.5.0', url: release.html_url })
  })

  it('is current when the release is the same or older', async () => {
    expect(await checkForUpdate({ currentVersion: '1.5.0', fetch: fakeFetch(() => Response.json(release)) })).toEqual({
      status: 'current',
    })
    expect(await checkForUpdate({ currentVersion: '2.0.0', fetch: fakeFetch(() => Response.json(release)) })).toEqual({
      status: 'current',
    })
  })

  it('treats 404 (no release yet) as current', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => new Response('{}', { status: 404 })),
    })
    expect(result).toEqual({ status: 'current' })
  })

  it('sends GitHub headers', async () => {
    let headers: Headers | undefined
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return Response.json(release)
    }) as typeof fetch
    await checkForUpdate({ currentVersion: '1.0.0', fetch: fetchFn })
    expect(headers?.get('accept')).toBe('application/vnd.github+json')
    expect(headers?.get('user-agent')).toMatch(/^Boostnote\//)
  })

  it('reports malformed JSON, unexpected bodies and server errors', async () => {
    const malformed = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => new Response('not json')),
    })
    expect(malformed.status).toBe('error')
    const shape = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => Response.json({ tag_name: 3 })),
    })
    expect(shape.status).toBe('error')
    const server = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => new Response('', { status: 500 })),
    })
    expect(server).toEqual({ status: 'error', message: 'GitHub answered 500' })
  })

  it('never reports an invalid tag as an update', async () => {
    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => Response.json({ ...release, tag_name: 'nightly' })),
    })
    expect(result).toEqual({ status: 'current' })
  })

  it('reports network errors and timeouts', async () => {
    const network = await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fakeFetch(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND'))),
    })
    expect(network).toEqual({ status: 'error', message: 'getaddrinfo ENOTFOUND' })
    // A real (10 ms) timeout: the checker relies on the platform's `AbortSignal.timeout`.
    const hanging = ((_url: string, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>()
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      return promise
    }) as typeof fetch
    const timeout = await checkForUpdate({ currentVersion: '1.0.0', fetch: hanging, timeoutMs: 10 })
    expect(timeout).toEqual({ status: 'error', message: 'GitHub did not answer in time' })
  })
})

describe('isUpdateShown', () => {
  it('hides the dismissed version and shows a newer one', () => {
    expect(isUpdateShown({ version: '1.5.0', url: 'u' }, '1.5.0')).toBe(false)
    expect(isUpdateShown({ version: '1.6.0', url: 'u' }, '1.5.0')).toBe(true)
    expect(isUpdateShown({ version: '1.5.0', url: 'u' }, '')).toBe(true)
    expect(isUpdateShown(undefined, '')).toBe(false)
  })
})

/** A clock whose timers run when `tick` is called. */
function fakeClock() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  const clock: Clock = {
    setTimeout(callback, ms) {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
  }
  return {
    clock,
    get pending() {
      return [...timers.values()].map((timer) => timer.at - now)
    },
    async tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
      // Let the async check and its `finally` (which reschedules) settle.
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
  }
}

describe('createUpdater', () => {
  const update: UpdateResult = { status: 'update', version: '9.0.0', url: 'https://example.com/r' }

  it('checks 10 s after enabling, then every 24 h, and remembers the update', async () => {
    const time = fakeClock()
    let checks = 0
    const found: string[] = []
    const updater = createUpdater({
      check: async () => {
        checks++
        return update
      },
      automatic: true,
      onUpdate: (info) => found.push(info.version),
      clock: time.clock,
    })
    updater.setAutomatic(true)
    expect(time.pending).toEqual([10_000])
    await time.tick(10_000)
    expect(checks).toBe(1)
    expect(updater.available).toEqual({ version: '9.0.0', url: 'https://example.com/r' })
    expect(found).toEqual(['9.0.0'])
    expect(time.pending).toEqual([24 * 60 * 60 * 1000])
    await time.tick(24 * 60 * 60 * 1000)
    expect(checks).toBe(2)
  })

  it('stops when the preference is turned off and restarts when turned on', async () => {
    const time = fakeClock()
    let checks = 0
    const updater = createUpdater({
      check: async () => {
        checks++
        return { status: 'current' }
      },
      automatic: true,
      onUpdate: () => undefined,
      clock: time.clock,
    })
    updater.setAutomatic(false)
    expect(time.pending).toEqual([])
    updater.setAutomatic(true)
    updater.setAutomatic(false)
    await time.tick(30_000)
    expect(checks).toBe(0)
    expect(updater.scheduled).toBe(false)
    updater.setAutomatic(true)
    await time.tick(10_000)
    expect(checks).toBe(1)
    expect(updater.scheduled).toBe(true)
  })

  it('never schedules when not packaged, but manual checks still work', async () => {
    const time = fakeClock()
    const updater = createUpdater({
      check: async () => update,
      automatic: false,
      onUpdate: () => undefined,
      clock: time.clock,
    })
    updater.setAutomatic(true)
    expect(time.pending).toEqual([])
    expect(await updater.checkNow()).toEqual(update)
    expect(updater.available?.version).toBe('9.0.0')
  })
})

describe('preferences route and the update notice', () => {
  let app: TestApp | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('reports the update unless that version was dismissed, and toggles the schedule', async () => {
    app = await TestApp.create()
    app.updates.available = { version: '2.0.0', url: 'https://example.com/v2' }
    const initial = await (await app.get('/api/preferences')).json()
    expect(initial.update).toEqual({ version: '2.0.0', url: 'https://example.com/v2' })
    expect(initial.ui.checkUpdates).toBe(true)

    const dismissed = await (await app.post('/api/preferences', { dismissedUpdate: '2.0.0' })).json()
    expect(dismissed.update).toBeNull()
    expect(app.settings.ui.dismissedUpdate).toBe('2.0.0')

    app.updates.available = { version: '2.1.0', url: 'https://example.com/v21' }
    expect((await (await app.get('/api/preferences')).json()).update?.version).toBe('2.1.0')

    await app.post('/api/preferences', { checkUpdates: false })
    await app.post('/api/preferences', { checkUpdates: true })
    expect(app.updates.automatic).toEqual([false, true])
    expect((await app.post('/api/preferences', { checkUpdates: 'yes' })).status).toBe(400)
  })
})
