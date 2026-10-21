/**
 * Update notice: asks GitHub for the newest published release and compares it with the running
 * version. Nothing is downloaded or installed; the user gets a link to the release page.
 * Plain Node (no Electron imports) so it can be unit tested; `main.ts` wires it to Electron.
 */

/** Newest published, non-draft, non-prerelease release (GitHub's `releases/latest`). */
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/adrianbrowning/BoostNote/releases/latest'
export const CHECK_TIMEOUT_MS = 10_000
export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateInfo {
  version: string
  url: string
}

export type UpdateResult =
  | ({ status: 'update' } & UpdateInfo)
  | { status: 'current' }
  | { status: 'error'; message: string }

interface Version {
  core: [number, number, number]
  pre: string[]
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** `major.minor.patch[-pre][+build]`, optional leading `v`; `undefined` when invalid. */
export function parseVersion(value: string): Version | undefined {
  const match = SEMVER.exec(value.trim())
  if (!match) return undefined
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] }
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Math.sign(Number(a) - Number(b))
  if (numericA) return -1
  if (numericB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence: negative when `a < b`, `0` when equal (build metadata ignored), `undefined` when either is invalid. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  const core = left.core.map((part, i) => part - (right.core[i] ?? 0)).find((diff) => diff !== 0)
  if (core !== undefined) return Math.sign(core)
  // A prerelease has lower precedence than the release.
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length)
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const diff = compareIdentifiers(left.pre[i] ?? '', right.pre[i] ?? '')
    if (diff !== 0) return diff
  }
  return Math.sign(left.pre.length - right.pre.length)
}

/** The `releases/latest` response against the running version. */
export function parseRelease(body: unknown, currentVersion: string): UpdateResult {
  if (typeof body !== 'object' || body === null) return { status: 'error', message: 'Unexpected response from GitHub' }
  const { tag_name: tag, html_url: url } = body as Record<string, unknown>
  if (typeof tag !== 'string' || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return { status: 'error', message: 'Unexpected response from GitHub' }
  }
  const version = tag.trim().replace(/^v/, '')
  const order = compareVersions(version, currentVersion)
  // An unparseable tag (or running version) never produces a notice.
  return order !== undefined && order > 0 ? { status: 'update', version, url } : { status: 'current' }
}

export interface CheckOptions {
  currentVersion: string
  url?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/** One check. Never throws: network failures, timeouts and bad responses are `error` results. */
export async function checkForUpdate({
  currentVersion,
  url = LATEST_RELEASE_URL,
  fetch: fetchFn = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
}: CheckOptions): Promise<UpdateResult> {
  try {
    const response = await fetchFn(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Boostnote/${currentVersion}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    // No release published yet.
    if (response.status === 404) return { status: 'current' }
    if (!response.ok) return { status: 'error', message: `GitHub answered ${response.status}` }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { status: 'error', message: 'Unexpected response from GitHub' }
    }
    return parseRelease(body, currentVersion)
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { status: 'error', message: 'GitHub did not answer in time' }
    }
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether the notice for `update` shows: not when the user dismissed that exact version. */
export function isUpdateShown(update: UpdateInfo | undefined, dismissed: string): update is UpdateInfo {
  return update !== undefined && update.version !== dismissed
}

export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface UpdaterOptions {
  check(): Promise<UpdateResult>
  /** Automatic checks run only when packaged (or a dev override asks for them). */
  automatic: boolean
  /** Called with every update found (scheduled or manual). */
  onUpdate(update: UpdateInfo): void
  clock?: Clock
  firstDelayMs?: number
  intervalMs?: number
}

export interface Updater {
  /** The newest update found so far. */
  readonly available: UpdateInfo | undefined
  /** Starts (`true`) or stops (`false`) the automatic checks. */
  setAutomatic(enabled: boolean): void
  /** Checks now. */
  checkNow(): Promise<UpdateResult>
  readonly scheduled: boolean
}

const realClock: Clock = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** Remembers the last update found and runs the checks: `firstDelayMs` after enabling, then every `intervalMs`. */
export function createUpdater({
  check,
  automatic,
  onUpdate,
  clock = realClock,
  firstDelayMs = FIRST_CHECK_DELAY_MS,
  intervalMs = CHECK_INTERVAL_MS,
}: UpdaterOptions): Updater {
  let available: UpdateInfo | undefined
  let timer: unknown

  const run = async (): Promise<UpdateResult> => {
    const result = await check()
    if (result.status === 'update') {
      available = { version: result.version, url: result.url }
      onUpdate(available)
    }
    return result
  }
  const schedule = (ms: number) => {
    timer = clock.setTimeout(() => {
      timer = undefined
      void run().finally(() => {
        if (timer === undefined && enabled) schedule(intervalMs)
      })
    }, ms)
  }
  let enabled = false

  return {
    get available() {
      return available
    },
    get scheduled() {
      return timer !== undefined
    },
    setAutomatic(on) {
      enabled = on && automatic
      if (!enabled) {
        if (timer !== undefined) clock.clearTimeout(timer)
        timer = undefined
      } else if (timer === undefined) {
        schedule(firstDelayMs)
      }
    },
    checkNow: run,
  }
}
