# Remix 3 notes

Remix 3 is not React and not Remix 2. Read `node_modules/remix/INDEX.md` and the guide it points to
before using an API. These are the things about Remix 3 in this app that are easy to get wrong:

- **Route patterns only match `http:`/`https:` URLs.** A `boost://app/x` request never matches
  anything. `protocol.ts` (`toRouterRequest`) re-issues it as `http://app/x` with the same method,
  headers, body and abort signal. So inside actions `context.url` is `http://app/...`: always emit
  path-only URLs (`routes.x.href()`, relative redirects), never absolute URLs built from `context.url`.
- **Don't top-level `await app.whenReady()` anywhere in the main-process import graph.** Electron
  emits `ready` only after the ESM entry has finished evaluating, so it deadlocks (no window, no error).
  Top-level awaits that don't depend on `ready` are fine (`assets.ts` awaits `getScriptEntry`).
  `protocol.registerSchemesAsPrivileged` runs during that evaluation, i.e. before `ready`, as required.
- **The TS hook must be registered before any `.ts` module is resolved**, which is why the entry is a
  plain-JS file that imports `remix/node-tsx` and then uses a dynamic `import()`.
- **`clientEntry` setup also runs during SSR.** Put browser-only work (EventSource, `window`) in
  `handle.queueTask(...)`; tie its cleanup to `handle.signal`. Client-entry props must be serialisable
  (no functions); pass URLs such as `routes.events.href()` as props. A queued task is cancelled by the
  next re-render's tasks, so keep its result unless the component really went away.
- **Controlled inputs re-render on every input.** With `value={x}`, the input handler sets `x` and
  calls `handle.update()`; without the update, Remix restores the old value after each key press
  (the inline-rename bug). Never write a value into a field the user may be typing in from an async
  task (the import-dialog race): offer it as a button instead. Test typing with
  `page.keyboard.type`, which sends one input event per key; `fill()` sets the value at once and
  hides both bugs.
- **Styles:** `css(...)` rules are collected during SSR into `<style data-rmx-style>` tags inside the
  `rmx` cascade layer, each generated class in its own sublayer (`@layer rmx.rmxc-…`).
  Global CSS (`src/app/ui/public/base.css`) declares `@layer base, rmx;` so component rules win.
  `render()` stamps the CSP nonce on those tags; rules first added on the client go into
  constructed stylesheets (`adoptedStyleSheets`), which the policy does not govern.
- **Generated class names are not an interface.** Never select, assert on or script against
  `rmxc-*` names; check styling through computed styles in the Electron e2e tests (`tests/e2e`).
  Remix 3.2 fixed `css()` number serialisation: under 3.1 `WebkitLineClamp: 2` computed `none` in the
  app, so the note-list excerpt was not clamped, and `flex: 1` was emitted as `flex: 1px` (flex-basis
  `1px` instead of `0%`); the e2e test pins both and the unitless z-index and font-weight values.
- **No authored `style` attributes.** Per-element values (pane widths, editor settings, folder
  colours, tree depth, task progress) go through a `css({...})` mixin built in render: the server
  emits it in `<style data-rmx-style>` (rules kept for the page's life), and rules first added on
  the client are ref-counted and dropped when no element uses them. Two places write CSSOM directly
  (`style.setProperty`): the context menu sets `left`/`top` in a ref, keyed by position so each
  placement remounts the element instead of adding a page-wide `css()` rule, and a pane drag sets
  the pane variable and removes it once the re-render's class holds the new width.
- **CSP:** the router runs `asyncContext()`, `noStoreNonceResponses`, `csp()` (`remix/middleware/csp`)
  and `render()`, in that order (`router.ts` holds the policy). `csp()` makes a fresh nonce per
  request and appends the app policy to every `text/html` response; `render()` stamps that nonce on
  the import map, the module preloads and `<style data-rmx-style>` tags it generates, and the client
  runtime copies it onto import maps it adds for client entries discovered later (frames). Authored
  tags that `render()` does not stamp (the module preloads and entry script of `EntryHead`, shared by
  `Document` and `MermaidRendererPage`) read it with `getCspNonce(getContext())`, which needs
  `asyncContext()` first. `csp()` appends instead of replacing, so an HTML vault asset response
  (reader assets are images only) carries both its own sandbox policy and the app policy, and the
  browser enforces both. `csp()` sets no cache headers, so
  `noStoreNonceResponses` sends `Cache-Control: no-store` on every response whose policy carries a
  nonce (app pages and HTML assets); other responses keep their cache headers. It must stay outside
  (before) `csp()`: only there does it see the policy `csp()` added.
- **Style elements need the nonce** (`style-src-elem 'self' 'nonce-…'`; style attributes stay
  allowed by `style-src-attr 'unsafe-inline'` for KaTeX, table-cell alignment and Mermaid). Client
  code that makes a `<style>` reads the page nonce with `pageCspNonce()`
  (`src/editor/render/csp-nonce.ts`, the `<meta name="rmx-nonce">` property, as Remix's runtime
  does): CodeMirror gets it through `EditorView.cspNonce`, and `mermaidNodes` stamps it on a
  diagram's `<style>` before the editor or the reader inserts the SVG. Mermaid itself takes no
  nonce, yet inserts a `<style>` into its measuring SVG and then DOMPurify parses the serialised
  SVG (both checked against the page policy), so while `mermaid.render` runs
  `document.createElement` stamps style elements, and the nonce is stripped from the result again
  (cached, exported). `/export/mermaid` therefore has the app policy too, no route-specific one.
  Trade-off: the stamp on creation sets only the `nonce` property, which the policy checks when
  mermaid inserts the `<style>`, but DOMPurify's parse of the serialised SVG needs the attribute,
  so `withStampedStyles` sets the attribute once mermaid has inserted the `<style>` (removing that
  attribute stamp gives `style-src-elem` violations). The attribute stamp is scoped to Mermaid's
  measuring container (`#d<id>` and the SVG `#<id>`): a `<style>` made elsewhere while a render
  runs (CodeMirror's, say) gets the nonce as a property only, never as an attribute. While a
  render runs, the page nonce (which also authorises scripts) is readable as an attribute of the
  measuring SVG's `<style>`. Accepted:
  `default-src 'none'`, `img-src 'self' data: blob:` and `connect-src 'self'` leave CSS attribute
  selectors no outside host to leak it to, inserted HTML never runs a `<script>`, and the nonce is
  removed before the SVG is cached or exported. Verified against Mermaid 12.2.0: re-check on a
  Mermaid upgrade, or drop it once Mermaid accepts a nonce.
  E2E: every app window records `securitypolicyviolation` from the start of its load
  (session preload `tests/e2e/csp-violations-preload.cjs`, registered by
  `tests/e2e/csp-violations.cjs`); `tests/e2e/csp.spec.ts` asserts none.
- **Asset server:** `allowFiles`/`mounts` come from `remix.json` via `loadConfig` from `remix/cli`;
  `rootDir` must be passed explicitly (the packaged app's cwd is `/`). Package files are served from
  `/assets/npm/.pnpm/...` (the asset server understands pnpm's store). New browser-side packages
  (`@codemirror/*`, `@lezer/*`, `katex`, …) must be added to `allowPackages`. The asset server rejects
  anything that looks like CommonJS; such packages need an ESM build or `/vendor/*` (see PLAN.md §
  Editor).
- **Import maps:** Electron 45's Chromium supports multiple import maps natively, so `entry.ts` uses a
  plain dynamic `import()` instead of `remix/multiple-import-maps-polyfill`.
- **`scriptEntry` is resolved once at startup** (top-level await in `assets.ts`); its preload list goes
  stale only if the entry's own import graph changes during `pnpm dev` — restart in that case.
- **Router defaults:** unmatched paths return `404 Not Found: <path>` (text); a matched path with the
  wrong method returns `405` with an `Allow` header. If an action throws, `router.fetch` rejects;
  `protocol.ts` logs it and returns a 500.
- **Packaging:** no asar (see `electron-builder.yml`). pnpm installs native bindings only for the host
  platform, so build each installer on its target OS/arch.
- **Testing:** `router.fetch(new URL('/', 'http://app'))` exercises the full stack in Vitest, including
  asset compilation. Vitest's transform honours `jsxImportSource` from `tsconfig.json`, no extra config.
  Playwright `_electron.launch({ args: ['.'] })` works with this ESM entry (once nothing deadlocks
  `ready`).
