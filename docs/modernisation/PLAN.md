# Boostnote modernisation

Boostnote (Electron 4, React/Redux, webpack/grunt/babel, Stylus, CSON storage) is being rebuilt on a
current, much smaller stack. The work lands as a stack of PRs on `adrianbrowning/BoostNote`, one per
phase. The legacy code is deleted in phase 1; read it with `git show origin/master:<path>` (for
example `browser/main/lib/dataApi/`, `browser/lib/markdown.js`, `tests/fixtures/`).

## Decisions

- **No webpack, grunt, babel, Stylus, React or Redux.** The UI is [Remix 3](https://remix.run)
  (`remix@3.0.0`): components are `function C(handle) { return () => <jsx/> }`, state lives in setup
  scope, `handle.update()` re-renders, events use `mix={on('click', …)}`. Remix 3 is not React and
  shares no APIs with Remix 2 / React Router; the installed docs are in `node_modules/remix/INDEX.md`.
- **The router runs in the Electron main process.** Main registers the privileged `boost://` scheme
  and answers every request with `router.fetch(request)`. Pages are server-rendered with
  `remix/component/server`; interactive pieces are `clientEntry(...)` components hydrated by `run()`.
  Browser JS/CSS is compiled on demand by the `remix/assets` server mounted on the same router.
- **Secure renderer.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no
  preload. Every page carries a nonce-based Content-Security-Policy. All disk access happens in main.
- **Browser ↔ main is plain HTTP** on `boost://app/...` (fetch, forms, Remix frames). Main pushes
  (menu commands, later file changes) through one Server-Sent Events route, `GET /events`.
- **One live editor/viewer:** CodeMirror 6 live preview (Obsidian/Typora style). Markdown text is the
  source of truth with exact round-trip; widgets for images, task checkboxes, hr, tables, KaTeX math
  and mermaid reveal their source when the cursor enters them.
- **Storage is plain `.md` files with YAML frontmatter** in a user-chosen folder (a vault). Legacy CSON
  storages are converted by a non-destructive importer.
- **Adopted from Boost Note (Hubble):** live reload on external edits, `/` slash commands and markdown
  shortcuts, a file properties panel for frontmatter, tabs with per-tab back/forward.
- **Dropped:** AWS analytics, auto-update, WordPress publishing, Wakatime, flowchart.js,
  js-sequence-diagrams, chart.js, PlantUML, snippet notes (the importer converts them to markdown),
  touchbar, vim/emacs keymaps, i18n (English only).

## Toolchain

- pnpm 10, Node ≥ 24, ESM everywhere, TypeScript strict (`tsc` type-checks only, `noEmit`).
- Electron 45; packaging with electron-builder (`electron-builder.yml`), no auto-update.
- Biome (`biome.json`) for lint + format; Vitest for unit tests (`happy-dom` where a DOM is needed);
  Playwright `_electron` for end-to-end smoke tests (phase 6).
- CI (`.github/workflows/ci.yml`): `pnpm check`, `pnpm typecheck`, `pnpm test` on macOS and Ubuntu.

### Loading TypeScript/JSX in the main process: `remix/node-tsx`, no transpile step

Electron 45 ships Node 24.22, which supports synchronous module customisation hooks
(`module.registerHooks`). `remix/node-tsx` uses exactly that, so it works in Electron's main process
unchanged. `src/main/index.js` (the only hand-written JavaScript file) imports `remix/node-tsx` and
then dynamically imports `src/main/main.ts`; everything after that, including the Remix app in
`src/app`, is TS/TSX loaded through the hook. The browser side is compiled on demand by the Remix
asset server, which needs the sources at runtime anyway, so a separate esbuild/tsc emit step would
only add a second compiler and a `build/` directory without removing the runtime one.

Consequences:

- `pnpm build` does not emit files. It type-checks and then renders `/` with production settings and
  fetches every asset the page references (`scripts/verify-assets.ts`), so broken browser code fails
  before packaging.
- The packaged app ships `src/`, `tsconfig.json` (node-tsx and the asset server read its JSX settings)
  and `remix.json`, and is packaged **without asar** (`asar: false`): inside an asar archive the app
  was observed to hang before `ready`, most likely because the native oxc/lightningcss binaries behind
  node-tsx and the asset server read real files rather than Electron's virtual asar filesystem.
- In production (`app.isPackaged`) the asset server minifies and fingerprints URLs (immutable caching);
  in development (`pnpm dev`) it watches `src/` and serves source maps.

## Architecture

```
┌──────────────────────────── Electron main process (Node 24) ────────────────────────────┐
│                                                                                          │
│  src/main/index.js ──▶ remix/node-tsx hook ──▶ src/main/main.ts                          │
│                                                 │  single-instance lock, lifecycle       │
│                                                 ├─ window.ts   BrowserWindow, bounds     │
│                                                 ├─ menu.ts     app menu ─┐               │
│                                                 ├─ events.ts   SSE hub ◀─┘ broadcast()   │
│                                                 └─ protocol.ts boost:// ─┐               │
│                                                                          ▼               │
│   src/app/router.ts  (Remix router: asyncContext → CSP nonce → render middleware)        │
│     ├─ GET /          server-rendered document (src/app/ui/document.tsx)                 │
│     ├─ GET /assets/*  remix/assets: compiles src/**/public/**, src/editor/**, packages   │
│     ├─ GET /vendor/*  allow-listed package files served verbatim (mermaid's ESM build)  │
│     ├─ GET /events    text/event-stream from the SSE hub                                 │
│     └─ GET /dev/*     developer harnesses (/dev/editor), unpackaged app only           │
│   src/vault (phase 2)  plain Node storage core, used by router controllers               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                 ▲  boost://app/... (HTML, JS, CSS, fetch, forms)   │  SSE: event: menu …
                 │                                                  ▼
┌──────────────── Renderer (sandboxed Chromium, no Node, no preload) ──────────────────────┐
│  HTML from the router → entry.ts runs remix/component run() → hydrates clientEntry()s    │
│  (StatusBar today; sidebar, note list, CodeMirror 6 editor in later phases)             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Layout:

```
src/main/      Electron main: main.ts, window.ts, protocol.ts, menu.ts, events.ts, settings.ts
src/app/       Remix app: routes.ts, router.ts, assets.ts, actions/ (controllers), ui/ (server
               components), middleware/, **/public/ (browser-reachable client entries + CSS)
src/vault/     storage core (phase 2)          src/migrate/  CSON importer + CLI (phase 2)
src/editor/    CM6 live preview (phase 3)      src/markdown/ export renderer (phase 6)
tests/         Vitest tests mirroring src/; tests/e2e for Playwright (phase 6)
```

App-level settings live in `<userData>/settings.json` (owned by main; phase 1 stores the window
bounds). `userData` is `<appData>/Boostnote Modern`, deliberately not legacy Boostnote's
`<appData>/Boostnote`: sharing it would make both apps contend for the single-instance lock and let
Chromium 140+ migrate the Electron 4 profile in place.

## Editor (phase 3)

`src/editor` is the live-preview editor: one CodeMirror 6 view whose document is the markdown source,
browser-only and framework-agnostic. Public API (`src/editor/index.ts`):
`createLivePreviewEditor({ parent, doc, theme, onChange, resolveAssetUrl, saveAsset, onOpenLink })`
returns `{ view, setDoc(doc, { preserveSelection }), setTheme, focus, destroy }`.

- **Live preview.** `live-preview/markers.ts` (view plugin, visible ranges only) styles headings,
  quotes, lists, code and links and hides `#`, `*`/`_`, `` ` ``, `~~`, link brackets/URLs, `>`, escapes
  and code fences unless the selection touches the construct (line-level markers: its line).
  `live-preview/blocks.ts` (state field, because block widgets span lines) replaces images, task
  markers, `---`, GFM tables, `$…$`/`$$…$$`/```` ```math ```` and ```` ```mermaid ```` with widgets while
  the selection is outside them. Blocks inside a quote or list item stay as source.
- **Syntax.** GFM via `@lezer/markdown` plus a small math extension (`syntax/math.ts`); `$5 and $6`
  stays text. Fenced code highlights with `@codemirror/language-data`, loaded on first use.
- **Mermaid** is imported on first diagram (`render/mermaid.ts`), `securityLevel: 'strict'`, theme
  `default`/`dark` from `setTheme`, renders serialised, SVG cached by source + theme, errors shown in
  the widget. Its self-contained ESM build (`mermaid/dist/mermaid.esm.min.mjs`) bundles lodash/UMD
  shims (`typeof exports == "object" && exports`) that the asset server's CommonJS check rejects, and
  `mermaid`'s main entry pulls in real CommonJS (dayjs). So the editor imports the bare specifier,
  the asset server leaves it alone (`scripts.external`), `/vendor/mermaid/*` serves the allow-listed
  dist files verbatim, and `Document` adds the specifier to its import map (`src/app/vendor.ts`).
- **KaTeX** renders synchronously; pages that show the editor must link `katexStylesHref`
  (`src/app/assets.ts`), whose fonts the asset server serves (`files.extensions` in `remix.json`).
- **Editing.** `/` at line start or after whitespace opens the slash menu (autocomplete, filterable,
  arrows/Enter/Esc). On an otherwise empty line the command converts the line in place; otherwise
  it removes the `/query` and inserts the block after the current top-level block (Hubble semantics).
  Mod-B/I/E/Shift-X toggle `**`/`*`/`` ` ``/`~~`, Mod-K links, Enter continues lists/tasks/quotes and
  ends the list on an empty item, Tab/Shift-Tab nest list items by the sibling's marker width,
  `( [ { "` auto-close, `` ` * _ ~ `` wrap a selection, Mod-F search. Pasted/dropped images go
  through `saveAsset`; pasted HTML becomes GFM markdown (turndown + turndown-plugin-gfm).
- **Themes.** Colours are CSS variables scoped to `.cm-editor` (values match `base.css`); hosts tune
  `--editor-font`, `--editor-font-size`, `--editor-line-height`, `--editor-max-width`, `--editor-padding`.
- **`setDoc`** without options resets the state (selection, history); with `preserveSelection` it
  replaces only the changed middle so the selection maps through, isn't undoable, and doesn't call
  `onChange`.
- `GET /dev/editor` (development only) mounts the editor with in-memory callbacks next to its markdown
  source; phase 4 replaces it with the workspace. `pnpm build` also compiles the editor's whole
  graph, including every lazily loaded language.

## Phases (stack bottom → top)

1. `modernise/01-foundation` — toolchain, Electron 45 shell, `boost://` → Remix router,
   server-rendered document + one hydrated client entry, SSE `/events` hub, menu skeleton,
   electron-builder, CI, Biome, Vitest; legacy code deleted.
2. `modernise/02-vault` — `src/vault` + `src/migrate` (+ `pnpm migrate <legacyStorageDir> <targetVaultDir>`),
   `docs/modernisation/MIGRATION.md`, unit tests with legacy fixtures.
3. `modernise/03-editor` — CM6 live preview: hidden markers, widgets (images, checkbox, hr, tables,
   KaTeX, lazy mermaid), fenced-code highlighting, slash commands, markdown shortcuts, image paste/drop,
   HTML paste → markdown.
4. `modernise/04-workspace` — open/switch vault, sidebar, note list (sort/filter/search), editor
   integration with autosave and live reload, note/folder CRUD with trash, in-app importer.
5. `modernise/05-tabs-properties` — tabs with per-tab history, properties panel, preferences, native
   menus + shortcuts, global show/hide hotkey.
6. `modernise/06-export-release` — HTML/PDF export, print, copy as markdown, Playwright smoke tests,
   packaging verification, README/contributing rewrite.

## Remix notes

Things about Remix 3 in this setup that are easy to get wrong:

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
  (no functions); pass URLs such as `routes.events.href()` as props.
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
  anything that looks like CommonJS; such packages need an ESM build or `/vendor/*` (see Editor).
- **Import maps:** Electron 45's Chromium supports multiple import maps natively, so `entry.ts` uses a
  plain dynamic `import()` instead of `remix/multiple-import-maps-polyfill`.
- **`scriptEntry` is resolved once at startup** (top-level await in `assets.ts`); its preload list goes
  stale only if the entry's own import graph changes during `pnpm dev` — restart in that case.
- **Router defaults:** unmatched paths return `404 Not Found: <path>` (text); a matched path with the
  wrong method returns `405` with an `Allow` header. If an action throws, `router.fetch` rejects;
  `protocol.ts` logs it and returns a 500.
- **Packaging:** no asar (see above). pnpm installs native bindings only for the host platform, so
  build each installer on its target OS/arch.
- **Testing:** `router.fetch(new URL('/', 'http://app'))` exercises the full stack in Vitest, including
  asset compilation. Vitest's transform honours `jsxImportSource` from `tsconfig.json`, no extra config.
  Playwright `_electron.launch({ args: ['.'] })` works with this ESM entry (once nothing deadlocks
  `ready`).

## Vault notes

`src/vault` (public entry `src/vault/index.ts`) is plain Node, no Electron. Things consumers need to know:

- **Entry point:** `openVault(root, { watch: true })` returns a `Vault`: `tree()`, `index` (titles, tags,
  starred, `search()`), `readNote`/`writeNote`/`createNote`/`renameNote`/`moveNote`/`deleteNote`,
  `listTrash`/`restore`/`emptyTrash`, folder CRUD + colours/order, `saveAsset`/`assetPath`. Errors are
  `VaultError` with a `code` (`INVALID_PATH`, `NOT_FOUND`, `EXISTS`, `NOT_A_VAULT`) to map onto HTTP
  statuses. Mutations are serialised per vault.
- **Ids are vault-relative POSIX paths** (`work/todo.md`, folders `work`, root `''`). Ids with `..`, `\`,
  dot-segments or `*.assets` segments are rejected, and every resolved path is checked against symlink
  escapes. Serve note assets only through `vault.assetPath(noteId, href)`.
- **Events (`subscribe`) only report external changes.** The vault remembers the content hash of every
  file it wrote, so its own writes, moves and deletes never come back as `note-changed`; a controller
  that mutates must update the UI itself. `Note.hash` (sha256 of the file) lets the editor detect that a
  file changed under it.
- **Watching:** `fs.watch(recursive)`; a burst of events triggers one full reconcile (stat-first, hash
  on change). macOS FSEvents can drop changes made in the first moments after a watcher starts, so one
  extra reconcile runs a second after `startWatching`; `vault.refresh()` forces one (e.g. on window focus).
- **Frontmatter writes edit the YAML text in place:** unchanged keys keep their exact bytes (quotes,
  comments, flow lists); invalid YAML is treated as body, so nothing is ever lost.
