/**
 * The page's CSP nonce, read the way Remix's runtime reads it: the `nonce` property of the
 * `<meta name="rmx-nonce">` that `render()` emits (a header CSP hides the attribute, not the
 * property). Style elements the client creates need it (`style-src-elem` in `src/app/router.ts`).
 * Empty on a page without one.
 */
export function pageCspNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="rmx-nonce"]')?.nonce ?? ''
}
