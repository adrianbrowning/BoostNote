import { protocol } from 'electron'

import type { AppRouter } from '../app/router.ts'

export const SCHEME = 'boost'
export const APP_ORIGIN = `${SCHEME}://app`

/** Must run before `app` is ready: makes `boost://` behave like https (fetch, streams, storage, secure context). */
export function registerBoostScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

/**
 * Remix route patterns only match `http:`/`https:` URLs, so a `boost://app/x` request is handed
 * to the router as `http://app/x`. Method, headers, body and abort signal are carried over.
 */
export function toRouterRequest(request: Request): Request {
  const url = new URL(request.url)
  const routerUrl = `http://${url.host}${url.pathname}${url.search}`
  return new Request(routerUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
    duplex: 'half',
  } as RequestInit)
}

/** Serves every `boost://app/...` request from the Remix router running in the main process. */
export function handleBoostProtocol(router: AppRouter): void {
  protocol.handle(SCHEME, async (request) => {
    if (new URL(request.url).host !== 'app') return new Response('Not Found', { status: 404 })
    try {
      return await router.fetch(toRouterRequest(request))
    } catch (error) {
      console.error(`Unhandled error for ${request.method} ${request.url}`, error)
      return new Response('Internal Server Error', { status: 500 })
    }
  })
}
