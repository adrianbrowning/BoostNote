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
│     ├─ GET /vault-assets/*  files a note links to (images), via vault.assetPath()        │
│     └─ /api/*         the workspace's JSON API (see "Workspace (phase 4)")              │
│   src/vault (phase 2)  plain Node storage core, used by router controllers               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                 ▲  boost://app/... (HTML, JS, CSS, fetch, forms)   │  SSE: event: menu …
                 │                                                  ▼
┌──────────────── Renderer (sandboxed Chromium, no Node, no preload) ──────────────────────┐
│  HTML from the router → entry.ts runs remix/component run() → hydrates clientEntry()s    │
│  (one Workspace entry: sidebar, note list, CodeMirror 6 editor, status bar)             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Layout:

```
src/main/      Electron main: main.ts, window.ts, protocol.ts, menu.ts, events.ts, settings.ts,
               vault-session.ts
src/app/       Remix app: routes.ts, router.ts, assets.ts, actions/ (controllers), ui/ (server
               components), middleware/, **/public/ (browser-reachable client entries + CSS)
src/vault/     storage core (phase 2)          src/migrate/  CSON importer + CLI (phase 2)
src/editor/    CM6 live preview (phase 3)      src/markdown/ export renderer (phase 6)
tests/         Vitest tests mirroring src/; tests/e2e for Playwright (phase 6)
```

App-level settings live in `<userData>/settings.json` (owned by main: window bounds, `vaults`,
`lastVault`, and the `ui` section of preferences and pane layout, see phase 5). `userData` is `<appData>/Boostnote Modern`, deliberately not legacy Boostnote's
`<appData>/Boostnote`: sharing it would make both apps contend for the single-instance lock and let
Chromium 140+ migrate the Electron 4 profile in place. A `--user-data-dir=<dir>` switch overrides it
(tests, side-by-side profiles).

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
- The workspace (phase 4) hosts the editor; the phase-3 `/dev/editor` harness is gone. `pnpm build`
  compiles the workspace entry's whole graph, including every lazily loaded language.

## Workspace (phase 4)

The app's only page (`GET /`) server-renders one client entry, `Workspace`
(`src/app/actions/public/workspace/workspace.tsx`), with the vault's current lists as props, so the
first paint is complete; `run()` then hydrates it. It is one entry rather than frames plus several
small entries because the three panes share live state (selection, the dirty editor, conflicts):

- `model.ts` — `WorkspaceModel`: lists from `GET /api/workspace`, sidebar selection, sort, debounced
  search, menus/dialogs/notices and every mutation. Components render it and call its methods.
- `note-session.ts` — `NoteSession`: the open note's body, frontmatter and hash; autosave; live reload
  and conflict handling.
- `sidebar.tsx`, `note-list.tsx`, `editor-pane.tsx`, `overlays.tsx`, `import-dialog.tsx` — plain
  components inside the entry; `api.ts` is the typed client of `/api`, `types.ts` the shared JSON shapes.

Main side: `VaultSession` (`src/main/vault-session.ts`, plain Node) holds the open vault (opened with
`{ watch: true }`), keeps `vaults[]` (most recent first, max 10) and `lastVault` in `settings.json`,
reopens `lastVault` before the first window loads and forwards watcher events to the SSE hub as
`event: vault` (`{ type: 'vault', change, id }`). The router is built by `createAppRouter(services)`;
`AppServices` (`src/app/services.ts`) is everything Electron-specific (folder picker =
`dialog.showOpenDialog`, `shell.openExternal`, `shell.showItemInFolder`, legacy storage discovery),
so controllers never import Electron and tests pass fakes. The File menu (New Note ⌘N, New Folder
⇧⌘N, Open Folder… ⌘O, Import Boostnote Storage…, Reveal in Finder ⌥⌘R) sends SSE `menu` events;
the workspace performs them because it knows the selected folder and open note.

### Routes

All URLs are path-only. Ids travel in query strings or JSON bodies (note ids are paths). Errors are
JSON `{ error, message }`: `VaultError` `INVALID_PATH`/`NOT_A_VAULT` → 400, `NOT_FOUND` → 404,
`EXISTS` → 409; `MigrationError` → 400 (`TARGET_NOT_EMPTY` → 409); no open vault → 409 `NO_VAULT`.

| Route | Purpose |
| --- | --- |
| `GET /` | Workspace document (SSR with the open vault's lists) |
| `GET /vault-assets/<note id>?src=<link>` | File a note links to, resolved by `vault.assetPath` (no `..`, dot-dirs or symlink escapes); `Content-Type` from the extension, `nosniff`, `CSP: sandbox` |
| `GET /api/workspace` | `{ vault, recent, tree, notes, trash }` |
| `GET /api/search?q=` | `{ ids }`, best first (vault index) |
| `POST /api/vaults/pick` · `open {path}` · `close` · `forget {path}` | Folder dialog + open; open a recent vault; close; drop from Recent |
| `GET /api/notes/read?id=` | `NoteDocument`: summary + `frontmatter` + `body` + `hash` |
| `POST /api/notes/save {id, body, baseHash, frontmatter?}` | Writes if the file's hash is still `baseHash` (`null`: must not exist); 409 `CONFLICT` with the disk version otherwise |
| `POST /api/notes/create {folder}` · `rename {id, name}` · `move {id, folder}` · `delete {id}` · `reveal {id}` | Note CRUD (delete → trash), Reveal in Finder |
| `POST /api/folders/create {parent, name}` · `rename` · `move` · `delete` · `color {id, color\|null}` | Folder CRUD and colour |
| `POST /api/trash/restore {id}` · `empty` | Trash |
| `POST /api/assets?note=&ext=` (raw body, ≤ 50 MB) | Editor `saveAsset` → `{ href: "./<stem>.assets/<hash>.<ext>" }` |
| `GET /api/import/candidates` · `POST /api/import/pick {purpose}` · `POST /api/import/run {source, target, dryRun, force}` | Importer: storages found on this machine, folder dialog, dry run / run → summary |
| `POST /api/open-external {url}` | http(s) links only |
| `GET /api/preferences` · `POST /api/preferences {…UiPatch}` | `{ ui, hotkeyRegistered }`; save validates every field, `409 HOTKEY_UNAVAILABLE` when the OS refuses the global hotkey (phase 5) |

### Editor integration and conflict rules

- The editor only sees the body. Frontmatter stays in the session and is sent only when edited (star
  toggle; phase 5's properties panel); without it the server keeps the file's frontmatter. Values
  sent back unchanged keep their original YAML bytes.
- Autosave 500 ms after the last edit; also on editor blur, before switching/renaming/moving notes,
  switching vaults, when the window is hidden, and on quit (main calls
  `window.boostFlushPendingSave()` via `executeJavaScript`, 3 s timeout; if work could not be saved it
  asks "Quit Anyway?"). On Windows/Linux closing the window does the same.
- Every save carries the hash it is based on. External change (SSE `note-changed`) of the open note:
  not dirty → `setDoc(body, { preserveSelection: true })`; dirty (or a save answered 409) → a
  conflict bar, autosave suspended: **Keep mine** saves on top of their hash, **Load theirs** drops the
  edits. External delete/move → "Save my copy" (writes with `baseHash: null`) or Close. While a
  conflict is unresolved the app refuses to leave the note, so neither side is lost silently.
- Title is read-only above the editor (frontmatter `title`, else first H1, else file name); renaming
  the file is a separate action. Relative `.md` links open inside the app, http(s) links open in the
  browser, everything else is ignored.
- Folders show the notes directly inside them; "All notes" shows everything. Drag a note (or folder)
  onto a folder to move it. Pane widths and visibility persist in `settings.json` (`ui.panes`).

## Tabs, properties, preferences (phase 5)

### Tabs

`tabs.ts` (`Tabs`, pure state, unit-tested) follows Hubble: a tab is a note path plus its own
back/forward trail. There is one editor and one `NoteSession`; the session always shows the active
tab's note. Every tab transition goes through `WorkspaceModel.#switchTabs`: save the open note
(refused while a conflict is unresolved, like any note switch), change the tabs, load the active
tab's note from disk. Background tabs therefore never hold unsaved text.

- Click in the note list (or a relative `.md` link, or ↑/↓ in the list) navigates the active tab,
  pushing onto its back trail; ⌘/Ctrl+click, middle-click or "Open in New Tab" open a new tab after
  the active one. Back/forward: ⌘[ / ⌘] (View menu), mouse buttons 4/5, the arrows in the tab strip;
  entries of notes that no longer exist are skipped.
- ⌘W closes the tab (the right neighbour becomes active; without tabs the editor shows its empty
  state, the window stays); ⇧⌘W closes the window (macOS). ⇧⌘T reopens the most recently closed
  tab at its former position (40 remembered per vault). Ctrl+Tab / Ctrl+⇧Tab cycle, ⌘1…⌘8 pick by
  position, ⌘9 the last tab. Drag a tab to reorder; middle-click or × closes it.
- Persisted per vault in `localStorage` under `boostnote.tabs:<vault root>`: ordered tab paths, the
  active index and the closed-tab stack (`TabsSnapshot`); trails stay in memory. Restoring skips
  notes that no longer exist. App renames/moves (notes and folders) rebase tabs, trails and closed
  tabs; app deletes close their tabs; after a list refresh, background tabs whose note vanished on
  disk are dropped (the active one keeps the "removed" bar until the user decides).

### Properties panel

Toggle with ⇧⌘P (View > Toggle Properties) or the ⓘ button. It edits the open note's frontmatter:
tags as chips (Enter/comma adds, Backspace removes the last, autocomplete from the vault's tags via a
`<datalist>`), starred, created/updated read-only, and every other key by type (text, number,
checkbox, `YYYY-MM-DD` date, list of scalars as comma-separated text); keys can be renamed, removed
and added. Mappings and nested lists are shown read-only with a note; frontmatter that is not valid
YAML stays in the body (the panel says so). Each committed change is one `POST /api/notes/save`
with the whole `frontmatter`; the server keeps the original YAML of keys sent back unchanged and
the vault splices changed keys in place. A renamed key is rewritten after the others (the vault
treats it as remove + add). The saved summary updates the sidebar's tag and starred counts.

### Preferences and settings

⌘, (app menu "Settings…" on macOS, File > Preferences… elsewhere) opens a modal; every change is
saved and applied immediately through `POST /api/preferences` (any subset of `UiPreferences`,
validated field by field: unknown keys or bad values are `400`). `GET /api/preferences` and the page's
SSR props carry `{ ui, hotkeyRegistered }`.

| Preference | Effect |
| --- | --- |
| `theme` `system`/`light`/`dark` | main sets `nativeTheme.themeSource`, which drives the renderer's `prefers-color-scheme`: `base.css` and the editor (`setTheme`, mermaid `dark`) switch without a reload |
| `editorFont`, `fontSize`, `lineWidth` (`0` = full width) | `--editor-font`, `--editor-font-size`, `--editor-max-width` on the workspace root |
| `spellcheck` | `session.defaultSession.setSpellCheckerEnabled` |
| `confirmDelete` | ask before moving notes/folders to the Trash |
| `globalHotkey` (default `CommandOrControl+Shift+Space`; `''` = off) | recorded by key capture; main registers it with `globalShortcut.register` before storing it. If the OS refuses (another app has it) the route answers `409 HOTKEY_UNAVAILABLE`, the previous hotkey stays registered and nothing is stored. The hotkey hides the app when it is focused, else shows and focuses the window |
| `panes` | sidebar/list widths, sidebar/list collapsed, properties open |

`AppServices.preferences` (`src/main/preferences.ts` in the app, a fake in tests) is the Electron
side; `SettingsStore.ui` normalises the stored section (invalid fields fall back to defaults).

### Menus and shortcuts

Every app shortcut is a native menu accelerator (`ACCELERATORS` in
`src/app/actions/public/workspace/shortcuts.ts`, shared by `src/main/menu.ts`): File (New Note ⌘N,
New Folder ⇧⌘N, Open Folder ⌘O, Import, Reveal ⌥⌘R, Close Tab ⌘W, Reopen Closed Tab ⇧⌘T), Edit (roles,
Find… ⌘F → the editor's search panel), View (Toggle Sidebar ⇧⌘E, Toggle Note List ⇧⌘J, Toggle
Properties ⇧⌘P, Back ⌘[, Forward ⌘], reload/devtools, zoom roles, full screen), Window (Next/Previous
Tab Ctrl+Tab / Ctrl+⇧Tab, Select Tab ⌘1…⌘9), Help (GitHub, these notes, Report an Issue). Items reach
the renderer as SSE `menu` events (`{ command, index? }`). The renderer binds none of these keys
itself; a capture-phase `keydown` listener only stops their propagation (without `preventDefault`)
so CodeMirror's own bindings (Mod-[ / Mod-] indent, Mod-F) don't act as well. Each shortcut thus fires
exactly once, through the menu. Mouse back/forward buttons and Cmd/Ctrl/middle-click are handled in
the renderer (no menu equivalent).

### Note-list excerpts

`excerptOf` (`src/vault/note.ts`) produces plain text: no leftover frontmatter, fenced code, math
blocks, HTML tags/comments, images, link URLs, footnotes, table pipes or markdown markers; the first
H1 is skipped, whitespace collapsed, at most 160 characters.

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
