import { asyncContext } from 'remix/middleware/async-context'
import { csp } from 'remix/middleware/csp'
import { render } from 'remix/middleware/render'
import { createRouter, type Middleware, type MiddlewareContext, type Router } from 'remix/router'

import { createApiController } from './actions/api/controller.ts'
import { createRootController } from './actions/controller.tsx'
import { assets } from './assets.ts'
import { routes } from './routes.ts'
import type { AppServices } from './services.ts'

/**
 * The app policy, appended to every HTML response. Scripts must come from the app origin or carry
 * the request nonce, which `render()` stamps on generated import maps, module preloads and `css()`
 * style tags. style-src keeps 'unsafe-inline' because authored style attributes and inline
 * Mermaid/KaTeX styles carry no nonce.
 */
const appCsp = csp({
  policy: ({ nonce }) => ({
    defaultSrc: ["'none'"],
    scriptSrc: ["'self'", `'nonce-${nonce}'`],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    formAction: ["'self'"],
    baseUri: ["'none'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  }),
})

/**
 * Runs outside `csp()`, so it sees the app policy: a response whose policy carries a nonce (every
 * HTML response, vault `.html` assets included) must not be stored and replayed with a stale nonce.
 */
const noStoreNonceResponses: Middleware = async (_context, next) => {
  const response = await next()
  if (!response.headers.get('Content-Security-Policy')?.includes("'nonce-")) return response
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// `asyncContext()` lets server components read request values (the CSP nonce) via `getContext()`.
const middleware = [asyncContext(), noStoreNonceResponses, appCsp, render({ assets })] as const
type AppContext = MiddlewareContext<typeof middleware>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

export type AppRouter = Router<AppContext>

/** The whole app. The Electron main process serves it on `boost://app/` via `protocol.handle`. */
export function createAppRouter(services: AppServices): AppRouter {
  const router = createRouter<AppContext>({ middleware: [...middleware] })
  router.map(routes, createRootController(services))
  router.map(routes.api, createApiController(services))
  return router
}
