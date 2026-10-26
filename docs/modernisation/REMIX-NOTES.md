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
  `rmx` cascade layer. Global CSS (`src/app/ui/public/base.css`) declares `@layer base, rmx;` so
  component rules win. The CSP therefore allows inline styles; scripts need `'self'` or the nonce.
- **CSP nonce plumbing:** `contentSecurityPolicy()` stores a per-request nonce under a context key;
  `Document` reads it with `getContext()` (needs `asyncContext()` first in the middleware list) and
  passes it to `<ImportMap nonce>`. The client runtime copies that nonce onto import maps it adds for
  client entries discovered later (frames).
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
