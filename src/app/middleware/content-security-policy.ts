import { randomBytes } from 'node:crypto'
import { createContextKey, type Middleware } from 'remix/router'

/** Per-request nonce that the document puts on its inline import map. */
export const CspNonce = createContextKey<string>()

/**
 * Adds a strict Content-Security-Policy to HTML responses. Scripts must come from the app origin
 * or carry the request nonce (the import map). Styles allow inline because the component runtime
 * emits `css(...)` rules as `<style>` elements.
 */
export function contentSecurityPolicy(): Middleware<{ key: typeof CspNonce; value: string; property: 'cspNonce' }> {
  return async (context, next) => {
    const nonce = randomBytes(16).toString('base64')
    context.set(CspNonce, nonce, { property: 'cspNonce' })

    const response = await next()
    if (!response.headers.get('Content-Type')?.includes('text/html')) return response

    const headers = new Headers(response.headers)
    headers.set(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    )
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
