import { asyncContext } from 'remix/middleware/async-context'
import { render } from 'remix/middleware/render'
import { createRouter, type MiddlewareContext } from 'remix/router'

import controller from './actions/controller.tsx'
import { assets } from './assets.ts'
import { contentSecurityPolicy } from './middleware/content-security-policy.ts'
import { routes } from './routes.ts'

// `asyncContext()` lets server components read request values (the CSP nonce) via `getContext()`.
const middleware = [asyncContext(), contentSecurityPolicy(), render({ assets })] as const
type AppContext = MiddlewareContext<typeof middleware>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

/** The whole app. The Electron main process serves it on `boost://app/` via `protocol.handle`. */
export const router = createRouter<AppContext>({
  middleware: [...middleware],
})

router.map(routes, controller)
