# Boostnote modernisation

Boostnote (Electron 4, React/Redux, a bundler + task-runner + Babel build, Stylus, CSON storage) is being rebuilt on a
current, much smaller stack. The work lands as a stack of PRs on `adrianbrowning/BoostNote`, one per
phase. The legacy code is deleted in phase 1; read it with `git show origin/master:<path>` (for
example `browser/main/lib/dataApi/`, `browser/lib/markdown.js`, `tests/fixtures/`).

## Decisions

- **No bundler, task runner, Babel, Stylus, React or Redux.** The UI is [Remix 3](https://remix.run)
  (`remix@3.1.0`): components are `function C(handle) { return () => <jsx/> }`, state lives in setup
  scope, `handle.update()` re-renders, events use `mix={on('click', …)}`. Remix 3 is not React and
  shares no APIs with Remix 2 / React Router; the installed docs are in `node_modules/remix/INDEX.md`.
- **The router runs in the Electron main process.** Main registers the privileged `boost://` scheme
  and answers every request with `router.fetch(request)`. Pages are server-rendered with
  `remix/component/server`; interactive pieces are `clientEntry(...)` components hydrated by `run()`.
  Browser JS/CSS is compiled on demand by the `remix/assets` server mounted on the same router.
- **Secure renderer.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, one
  minimal preload for drop import only (see "Drop import (phase 12)"). Every page carries a nonce-based Content-Security-Policy. All disk access happens in main.
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
  Playwright `_electron` for end-to-end smoke tests (`pnpm test:e2e`, `tests/e2e`).
- CI (`.github/workflows/ci.yml`): `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build` and the
  e2e suite (under `xvfb-run` on Linux) on macOS and Ubuntu; `v*` tags also package installers (see
  "Export and release (phase 6)").

### Loading TypeScript/JSX in the main process: `remix/node-tsx`, no transpile step

Electron 45 ships Node 24.22, which supports synchronous module customisation hooks
(`module.registerHooks`). `remix/node-tsx` uses exactly that, so it works in Electron's main process
unchanged. `src/main/index.js` (the only hand-written JavaScript file) imports `remix/node-tsx` and
then dynamically imports `src/main/main.ts`; everything after that, including the Remix app in
`src/app`, is TS/TSX loaded through the hook. The browser side is compiled on demand by the Remix
asset server, which needs the sources at runtime anyway, so a separate esbuild/tsc emit step would
only add a second compiler and a `build/` directory without removing the runtime one.

Consequences:

- `pnpm build` does not emit files. It type-checks and then renders `/` and `/export/mermaid` with
  production settings and fetches every asset they reference (`scripts/verify-assets.ts`), so broken
  browser code fails before packaging.
- The packaged app ships `src/`, `tsconfig.json` (node-tsx and the asset server read its JSX settings)
  and `remix.json`, and is packaged **without asar** (`asar: false`). Re-checked in phase 6 with
  `asar: true` + `asarUnpack: ["**/*.node"]`: node-tsx loads the main process from the archive (Node's
  `fs` is asar-aware), but the asset server resolves and compiles browser modules with native code
  (oxc-resolver, oxc, lightningcss) that sees only the real filesystem, so nothing inside `app.asar`
  exists for it, `getScriptEntry` in `assets.ts` fails and no window ever opens. Unpacking everything
  the asset server reads (`src/` plus the browser packages) would amount to no asar.
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
┌──────────────── Renderer (sandboxed Chromium, no Node, 1-function preload) ──────────────┐
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
  the selection is outside them. Blocks inside a quote or list item stay as source. While the view is
  unfocused (`live-preview/selection.ts` tracks focus in state via `EditorView.focusChangeEffect`) the
  selection counts as absent, so the whole note renders, including the construct under the cursor.
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
| `POST /api/links/plan {moves}` · `POST /api/links/apply {moves}` | After a rename/move: links in other notes to the old place, dry run / rewrite → `{ notes: [{ id, title, links }], total }` (phase 10) |
| `POST /api/folders/create {parent, name}` · `rename` · `move` · `delete` · `color {id, color\|null}` | Folder CRUD and colour |
| `POST /api/trash/restore {id}` · `empty` | Trash |
| `POST /api/assets?note=&ext=` (raw body, ≤ 50 MB) | Editor `saveAsset` → `{ href: "./<stem>.assets/<hash>.<ext>" }` |
| `GET /api/import/candidates` · `POST /api/import/pick {purpose}` · `POST /api/import/run {source, target, dryRun, force}` | Importer: storages found on this machine, folder dialog, dry run / run → summary |
| `POST /api/open-external {url}` | http(s) links only |
| `GET /api/preferences` · `POST /api/preferences {…UiPatch}` | `{ ui, hotkeyRegistered }`; save validates every field, `409 HOTKEY_UNAVAILABLE` when the OS refuses the global hotkey (phase 5) |
| `POST /api/export/note {id, format: html\|pdf\|markdown\|print}` · `POST /api/export/folder {folder}` | Export (phase 6) → `{ path }` (`null`: cancelled / printed) |
| `POST /api/open-request` | Takes the oldest queued "open this `.md`" request → `{ kind: 'note', vault, id }` or `null` when the queue is empty (phase 6) |
| `GET /export/mermaid` | Hidden page that lays out mermaid diagrams for export (phase 6) |

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
- The note's name above the editor is its file name (or frontmatter `title`) and is renamed in place
  (see Note names (phase 7)). Relative `.md` links open inside the app, http(s) links open in the
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
New Folder ⇧⌘N, Open Folder ⌘O, Import, Export ▸ Note as HTML/PDF/Markdown, Folder/Vault as HTML,
Print ⌘P, Reveal ⌥⌘R, Close Tab ⌘W, Reopen Closed Tab ⇧⌘T), Edit (roles,
Find… ⌘F → the editor's search panel), View (Toggle Sidebar ⇧⌘E, Toggle Note List ⇧⌘J, Toggle
Properties ⇧⌘P, Back ⌘[, Forward ⌘], reload/devtools, zoom roles, full screen), Window (Next/Previous
Tab Ctrl+Tab / Ctrl+⇧Tab, Select Tab ⌘1…⌘9), Help (GitHub, these notes, Report an Issue). Items reach
the renderer as SSE `menu` events (`{ command, index? }`); each item's `id` is its command, so
`Menu.getApplicationMenu().getMenuItemById(command)` finds it (the e2e tests click items that way). The renderer binds none of these keys
itself; a capture-phase `keydown` listener only stops their propagation (without `preventDefault`)
so CodeMirror's own bindings (Mod-[ / Mod-] indent, Mod-F) don't act as well. Each shortcut thus fires
exactly once, through the menu. Mouse back/forward buttons and Cmd/Ctrl/middle-click are handled in
the renderer (no menu equivalent).

### Note-list excerpts

`excerptOf` (`src/vault/note.ts`) produces plain text: no leftover frontmatter, fenced code, math
blocks, HTML tags/comments, images, link URLs, footnotes, table pipes or markdown markers; the first
H1 is skipped, whitespace collapsed, at most 160 characters.

## Export and release (phase 6)

### Renderer (`src/markdown`)

Plain Node, no Electron. `renderMarkdown(markdown, { resolveImage, rewriteLink, renderMermaid })`
strips frontmatter and renders with markdown-it: GFM tables, strikethrough, linkify autolinks, task
lists (disabled checkboxes, GitHub's classes), footnotes (`markdown-it-footnote`), GitHub-style
heading ids (deduplicated `-1`, `-2`), math with the editor's rules (`src/markdown/math.ts` mirrors
`src/editor/syntax/math.ts`: `$…$` not before a digit, `$$…$$`, ```` ```math ````) rendered by the
editor's own KaTeX call, and fenced code highlighted server-side with the editor's parsers
(`@codemirror/language-data` + `highlightCode`) and the same tag groups/colours as its highlight style.

Sanitising: markdown-it runs with `html: true`, then `sanitize-html` applies an allow-list (no
scripts, styles, frames, forms, event handlers or `javascript:`; `input` only as a disabled checkbox;
classes limited to the ones the renderer emits; `text-align` the only style). Generated KaTeX,
highlighted code and mermaid SVG are inserted *after* sanitising through slot tokens carrying a
per-render random nonce, so a note cannot forge one. Relative image `src`s are resolved after
sanitising too (`resolveImage`, async); relative link `href`s go through `rewriteLink`.

`htmlDocument` wraps the body in a standalone page: inline CSS (the editor's light palette), KaTeX's
stylesheet with its WOFF2 fonts inlined as `data:` URIs (only when the note has math), and a CSP meta
tag that forbids scripts and any fetch except images. `noteToHtml` inlines a note's images
(`vault.assetPath` → `data:` URI); `exportFolderHtml` writes one page per note at the same relative
path, `.md` links rewritten to `.html`, plus an `index.html` listing (`_contents.html` when the folder
has its own `index.md`, which then becomes `index.html`); `exportNoteMarkdown` copies the file and its
`<stem>.assets/` (renamed after the new file name, links rewritten).

### Mermaid, PDF and printing (`src/main/export.ts`)

Mermaid needs a DOM to measure text. Main lazily opens a hidden, sandboxed window on
`boost://app/export/mermaid`, whose only script (`public/mermaid-renderer.ts`) exposes
`window.boostRenderMermaid(source)` built on the editor's `renderMermaid` (`securityLevel: 'strict'`,
light theme), and calls it with `executeJavaScript`; errors come back as values and render as an error
box. The window closes after a minute idle. PDF: the finished document is written to a temp file,
loaded into a hidden window, `document.fonts.ready` is awaited, then `webContents.printToPDF` (A4,
backgrounds). Print (⌘P) does the same with `webContents.print`, i.e. the system print dialog. Save
dialogs (`dialog.showSaveDialog`, default folder Documents) and folder pickers run in main; all of
this is `AppServices.exports`, faked in tests. The workspace saves the open note before exporting
and shows "Exported to …"; folder exports create `<name> (HTML)` (or `… 2`) inside the chosen folder
and reveal it. Sidebar folder menus have "Export as HTML…".

### Opening `.md` files

`electron-builder.yml` declares a `.md` file association (role Editor, rank Alternate). macOS
delivers files through `open-file` (also before `ready`), Windows/Linux through argv (first launch)
or `second-instance` argv. Main queues the file (`VaultSession.requestOpen`) and pushes SSE
`open-request`; the workspace takes requests (`POST /api/open-request`) until the queue is empty,
after hydrating and on that event. `takeOpenRequest` resolves the file's real path and drops files
that are gone or not `.md`. A file inside the open vault, else inside a recent vault (roots compared
as real paths), is that vault's note (`work/plan.md` for a subfolder); any other file's folder becomes
the vault. The workspace saves the open note, switches vaults when needed, and opens the note in a new
tab (or its existing tab). A request made before the window exists is therefore not lost, and a
second quick request does not replace the first.

### End-to-end tests (`tests/e2e`, `pnpm test:e2e`)

Playwright `_electron` launches the app from source with a temp vault and `--user-data-dir` profile
(settings preset with `lastVault` and the global hotkey off) and waits for the SSE connection before
sending menu commands. Native dialogs are answered by replacing `dialog.showSaveDialog` /
`showOpenDialog` in main via `electronApp.evaluate`. Covered: a note renders mermaid SVG and KaTeX
(fully rendered while unfocused); typing is saved to disk; an external write live-reloads; tabs survive
a reload; importing the legacy fixture storage through the dialog; HTML export contains mermaid `<svg>`
and KaTeX markup (and is screenshotted in a window); PDF export; a `.md` passed on argv and via
`open-file`. `pnpm test` stays unit-only (Vitest excludes `tests/e2e`).

### Packaging and release

`pnpm dist` on macOS (arm64) builds `Boostnote-<version>-arm64.dmg` and `-mac.zip`; the app from the
dmg launches (`app.isPackaged`), renders mermaid/KaTeX and exports PDF/HTML (phase 6 smoke run).
No asar (see Toolchain). App id `io.boostnote.app`, product name Boostnote, existing icons from
`resources/`. Local builds may pick up unrelated signing identities from the keychain; set
`CSC_IDENTITY_AUTO_DISCOVERY=false` for an unsigned build. On `v*` tags CI builds macOS, Windows and
Linux installers on their own runners (`release` job) and attaches them to a draft GitHub release
(`publish` job). Signing is optional: `CSC_LINK`/`CSC_KEY_PASSWORD` secrets enable it, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` notarisation; without them artifacts are unsigned.

## Note names (phase 7)

The file name **is** the note's name (as in Obsidian/Hubble); the first `# H1` is just content.

- **Displayed name** (`noteTitle`, `src/vault/note.ts`): frontmatter `title` when it is a non-empty
  string, else the file name stem. Used by the index (and its search title field), the note list,
  editor header, tabs, trash list and exports (document `<title>`, folder index pages).
- **One sanitiser** (`noteFileName` / `sanitizeFileName`, `src/vault/paths.ts`) for new notes,
  renames, folders and the importer: `/ \ : * ? " < > |` and control characters → `-`, whitespace
  collapsed, leading dots and trailing dots/spaces stripped, a trailing `.assets` dropped, capped at
  120 characters / 200 UTF-8 bytes on a grapheme boundary, Windows device names suffixed with `-`
  (`CON` → `CON-`, `con.txt` → `con-.txt`); empty → `Untitled` (`sanitizeFileName` returns `''`
  so renames can refuse it). Names are unique per folder ignoring case, with ` 2`, ` 3`, …
  (also for moves, trash slots and restores). `createNote` makes `Untitled.md`, `Untitled 2.md`, … with an
  empty body. Link paths encode space, `#`, `%`, `(`, `)`, `<`, `>`.
- **Inline rename:** click the name in the editor header (or focus it and press F2/Enter); Enter or
  blur commits through `POST /api/notes/rename`, Esc cancels, `EXISTS`/`INVALID_PATH` show inline. A
  note whose name comes from a frontmatter `title` edits that key instead (tooltip says so; clearing
  it shows the file name again).
- **Importer:** `<folder>/<noteFileName(title)>.md`; frontmatter `title` only when the file name
  can't spell the legacy title (see MIGRATION.md).
- **Rename Files From Titles…** (File menu; `vault.planTitleRenames()` → `GET /api/notes/title-renames`,
  `vault.applyTitleRenames(plan)` → `POST /api/notes/title-renames/apply`) for vaults imported with
  slug names. A note is eligible only when its stem is `slugify(oldTitle)` (optionally `-N`), where
  `oldTitle` = frontmatter `title` ?? first H1 ?? stem, and `noteFileName(oldTitle)` differs from the
  stem; user-named files (`Craig.md` starting `# 2026-09-18`) are listed as skipped. Originals sort
  before their `-2` duplicates so they keep the plain name. Apply renames each file (assets folder
  and own links follow, as `renameNote`), removes a frontmatter `title` equal to the new stem
  (in-place YAML edit), then rewrites incoming links with the shared pass of Link updates (phase 10),
  without asking (the plan dialog is the confirmation). Renames that no longer apply are reported as
  skipped. The workspace saves the open note first, rebases tabs old id → new id and reloads the open
  note. `slugify` survives only for this recognition.

## Update notice (phase 8)

Notice only: no electron-updater, no downloads, no installs.

- **Checker** (`src/main/updates.ts`, plain Node): `GET https://api.github.com/repos/adrianbrowning/BoostNote/releases/latest`
  (`Accept: application/vnd.github+json`, `User-Agent: Boostnote/<version>`, 10 s timeout). That endpoint
  returns only the newest published, non-draft, non-prerelease release; `404` (none yet) = `current`.
  `tag_name` (leading `v` stripped) is compared with `app.getVersion()` by semver precedence
  (prerelease < release, build metadata ignored); an invalid version never yields an update. Result:
  `{ status: 'update', version, url } | { status: 'current' } | { status: 'error', message }`.
- **Schedule** (`createUpdater`): only when `app.isPackaged` and `ui.checkUpdates` (default on) — 10 s
  after start, then every 24 h; the last update found is kept in memory and broadcast as SSE
  `update` `{ version, url }`. `POST /api/preferences { checkUpdates }` starts/stops the timer.
  `BOOSTNOTE_UPDATE_URL` (honoured only when not packaged) points the checker at another server and
  enables the schedule — used by smoke tests.
- **Notice:** `GET/POST /api/preferences` return `update` (or `null` when `ui.dismissedUpdate` equals
  its version); the status bar shows it with Download (`/api/open-external`, http(s) only) and ×
  (stores `ui.dismissedUpdate`).
- **Menu:** "Check for Updates…" (id `check-updates`) under About in the macOS app menu, in Help on
  Windows/Linux; works in development too and answers with a native message box (Download/Later,
  up to date with the current version, or the error).
- **Releasing:** bump `version` in `package.json`, commit, tag `vX.Y.Z` and push the tag; CI builds a
  **draft** release — publish it. The notice only sees published releases.

## Link updates (phase 10)

Renaming or moving a note or folder asks each time whether to update links pointing at it (Obsidian
style).

- **Moves** (`LinkMove`, `src/vault/links.ts`): `{ from, to, kind: 'note' | 'folder' }`, ids before →
  after. A note move also covers its `<stem>.assets/`; a folder move is a path-prefix map over every
  note, asset and subfolder under it. The most specific (longest) prefix wins.
- **Vault:** `planLinkUpdates(moves)` (dry run, writes nothing) and `applyLinkUpdates(moves)` →
  `{ notes: [{ id, title, links }], total }`, run under the vault's mutation queue. One private pass
  (`#rewriteIncomingLinks`, also used by `applyTitleRenames`) resolves every relative link of every
  indexed note (so never `.trash`) against its folder and maps targets through the moves; `#anchor` /
  `?query` kept, `./` kept where the result stays below the note's folder, paths `%20`-encoded, fenced
  code and code spans untouched. Writes are atomic and tracked by hash (no self-events). A moved note
  (or a note inside a moved folder) is skipped for its own move: the move already re-based its links.
- **Moves re-base the moved notes themselves** (no question asked): `renameNote`/`moveNote` re-base the
  note's relative links on its new folder, and links to itself or its assets follow; a folder
  rename/move does the same for every note inside it, so links out of the folder gain/lose `../` and
  links between notes inside it stay valid.
- **Workspace:** after a successful inline rename, Rename…, Move to…, drag onto a folder, or a folder
  rename/move, the model calls `POST /api/links/plan`; with `total > 0` it shows "Update links? N links
  in M notes point to “old name”." with the notes listed (scrolls past eight). **Update links**
  (focused, Enter) flushes the open note's pending save, calls `POST /api/links/apply`, reloads the open
  note through the live-reload path if it was rewritten (`setDoc` with `preserveSelection` when clean,
  the conflict bar when dirty), refreshes the lists and shows "Updated N links". **Don’t update** (Esc)
  writes nothing. With nothing to update no dialog appears.

## CLI and MCP (phase 11)

`boostnote` gives scripts and AI agents read + write access to a vault without the app. Nothing is
deleted for good: `trash` moves a note to `.trash/` (restorable), there is no empty-trash command.

- **One command layer** (`src/cli/commands.ts`, plain Node): each operation takes an open `Vault`
  (`openVault`, no watcher) and returns plain JSON data; errors are `CommandError`s (`USAGE`,
  `NOT_FOUND`, `CONFLICT`, `AMBIGUOUS`, `INVALID`, `EXISTS`) mapped from `VaultError`. Both the CLI
  (`src/cli/main.ts`, `runCli(argv, io)`) and the MCP server (`src/cli/mcp.ts`, `createMcpServer(vault)`)
  call it, so they behave alike and `boostnote --json` prints exactly what the MCP tools return.
- **Operations:** `list` (folder, `--recursive`, tag, starred, sort, limit), `search` (the index's
  `search`; id, title, excerpt, score), `read` (document with frontmatter, body and `hash`; `--raw`
  the file), `create`, `write` (body only, frontmatter kept), `append`, `set-props` / MCP
  `update_properties { set, remove }` (`writeNote` with the edited frontmatter, so YAML of keys not
  named keeps its bytes; `created` is always kept by the vault), `rename` / `move` (then
  `applyLinkUpdates` for the move, as the app's "Update links"; `--no-update-links` reports
  `planLinkUpdates`' count instead), `trash`, `restore`, `tags`, `folders`, `tasks` (the app's
  `taskProgress`). All writes go through the vault (atomic, traversal-safe, serialised).
- **Conflicts:** `write --base-hash` passes `baseHash` to `writeNote` (checked on entry and just
  before the rename); `append`/`set-props` always write against the hash they just read and also
  take `--base-hash`. A mismatch is `CONFLICT` (exit 3) with the current hash in the details.
- **Ids:** vault-relative POSIX paths, `.md` optional; else a bare name matching one note's file stem
  or title (exact, then case-insensitive). Several matches → `AMBIGUOUS` listing them (exit 1).
- **Vault selection** (`src/cli/vault-dir.ts`): `--vault`, else `$BOOSTNOTE_VAULT`, else `lastVault`
  from `<appData>/Boostnote Modern/settings.json` (read with the app's `SettingsStore`, never written;
  appData resolved per platform like Electron does). None → usage error.
- **Arguments:** a small parser instead of `util.parseArgs`, so markdown such as `- [ ] task` is an
  argument and `--body "- item"` works. Bodies come from `--body` or piped stdin; stdin is read only
  when it is a pipe or a file (never blocks on a terminal). Exit codes: 0 ok, 1 error, 2 usage,
  3 conflict, 4 not found.
- **MCP** (`@modelcontextprotocol/sdk` 1.x, `McpServer` + stdio): 14 tools mirroring the commands
  with zod input schemas and read-only/destructive annotations; results are the JSON text, errors
  `isError` with `CODE: message` (+ details). Server instructions and the write tools' descriptions
  say to read first and pass `baseHash`. Notes are resources `boostnote://note/{+id}` (id segments
  URI-encoded, `text/markdown`, the raw file). Each call starts with `vault.refresh()` so changes by
  the app, git or an editor are seen. The protocol owns stdout; logs go to stderr.
- **Running it:** `src/cli/index.js` registers `remix/node-tsx` and imports `main.ts`, like
  `src/main/index.js`. Checkout: `pnpm cli …` or `node src/cli/index.js …` (`bin.boostnote` in
  package.json). Packaged: `ELECTRON_RUN_AS_NODE=1 <app binary> <app>/src/cli/index.js …` (asar is
  off, so the sources and `node_modules` are on disk; the RunAsNode fuse is left at its default).
- **Install Command Line Tool…** (id `install-cli`; macOS app menu, Help on Linux;
  `src/cli/install.ts`): writes a `#!/bin/sh` shim that `exec`s the current app binary that way into
  `/usr/local/bin` when writable, else `~/.local/bin` (created). It never replaces a `boostnote` it
  did not write (marker comment) and reports whether the folder is on the login shell's PATH (Dock
  apps get a minimal `PATH`, so it asks `$SHELL -ilc`). Rerun it after moving the app. Windows
  ("Command Line Tool…") shows the PowerShell/cmd command instead.
- **With the app running:** CLI/MCP writes are external writes to the app: its watcher reloads the
  open note (clean) or shows the conflict bar (dirty). Nothing new was needed.

## Drop import (phase 12)

Drag `.md`/`.markdown` files and folders from Finder/Explorer onto the window to **copy** them into
the vault. The originals are only read: never moved, renamed or changed.

- **Targets** (`src/app/actions/public/workspace/drop-import.ts`, `sidebar.tsx`): a sidebar folder
  row takes the drop for that folder (highlighted on dragover, like note/folder drags); anywhere else
  (note list, editor, empty state) uses the folder selected in the sidebar, else the vault root. Only
  drags carrying OS files (`dataTransfer.types` has `Files`) are handled; note → folder, folder →
  folder and tab drags are untouched. A window-level capture-phase `drop` listener runs before
  CodeMirror, so a `.md` dropped on the editor is imported rather than pasted as text; a drop of
  nothing but images onto the editor is left to the editor (stored as assets of the open note, as
  before). No vault open → "Open a vault first".
- **Paths: the one preload** (`src/main/preload.cjs`). Folder drops and the images next to a dropped
  note need real file-system paths. A sandboxed, context-isolated renderer cannot read them from a
  `File` (`File.path` is gone since Electron 32), and `webUtils.getPathForFile` exists only on the
  preload side, so there is no way to do this through the router. The preload (CommonJS, as
  sandboxed preloads must be) exposes exactly `window.boostnote.grantDroppedFiles(files)` and
  nothing else; `sandbox`, `contextIsolation` and `nodeIntegration: false` stay as they were.
- **Drop tickets, not paths.** The preload sends the paths over IPC (`drop:grant`) straight to
  main, which accepts them only from the app window's main frame on `boost://app/`, stores them as
  a one-time ticket (60 s, `src/app/drop-grants.ts`) and returns `{ ticket, count }`. The page then
  posts `POST /api/import-files { ticket, folder }`. Page script therefore never names a path:
  it can only get tickets for `File`s that carry a path, which come from the user (a drop, a file
  picker or a paste of copied files); `new File(...)` has none. Unknown, used or expired tickets
  get `403`.
- **Route checks** (`readImportPaths` in the API controller), on the ticket's paths: 1–200 paths,
  each an absolute string without NUL that exists and is a regular file or a directory; then
  `vault.importFiles(paths, folder)` (the folder id is validated by the vault). Reply `201` with
  the report.
- **`Vault.importFiles(sources, folder, limits?)`** (`src/vault/import-files.ts` plans, `vault.ts`
  writes; under `#exclusive`, atomic writes, `#track`ed so no self-events). Planning reads everything
  first and writes nothing, so a refused import (over 2000 files or 512 MB: `TOO_LARGE`, `413`)
  leaves no partial copy.
  - Names: `noteFileName(stem)`, unique ignoring case in the target folder (` 2`, ` 3`…, also
    against `<stem>.assets`); `.markdown` becomes `.md`. A folder becomes a new folder of the same
    (sanitised, unique) name with its Markdown files in their sub-folders; dot-entries and `*.assets`
    folders are not walked, symlinks are skipped, folders without notes are not created.
  - Content: the source's bytes, frontmatter included; no frontmatter is added. The file's mtime
    (and atime) are copied from the source. Only rewritten links change the text (frontmatter
    untouched, the body via `rewriteRelativeLinks`, so code spans/blocks are skipped and `%20`,
    `<dest>`, `./`, `../`, `#fragment` work as for link updates).
  - Links: a relative link (markdown or `src`/`href`) to another note of the same drop → its new
    path; to an existing file under what was dropped (the file's folder for a dropped file, the
    dropped folder for a folder) that is not a `.md` → copied to `<stem>.assets/<sha256-12>.<ext>`
    (same naming as `saveAsset`) and linked as `./<stem>.assets/…`. Web links, absolute paths,
    missing files, files outside the drop and `.md` files not in the drop stay as written and are
    listed in `report.unresolved`.
  - Skips (`report.skipped`): non-Markdown files (unless a note linked to them), missing paths, a
    source directly in the target folder ("already in …", nothing written: dropping a vault note on
    its own folder is a no-op; onto another folder it is copied like any file), a folder containing
    the target.
- **After the import** (`WorkspaceModel.importDropped`): lists refresh; a single dropped file that
  became one note opens in a new tab; the notice says "Imported N notes into <folder> (M images
  copied, K skipped)" and lists skips and links left alone (a notice with details stays until
  dismissed).
- **Tests:** `tests/vault/import-files.test.ts` (names, bytes, mtime, assets, links, folders, skips,
  no-op, limits, nothing written outside the vault), route checks in `tests/app/api.test.ts`,
  `tests/e2e/drop.spec.ts`. Playwright cannot perform an OS drag, so the e2e tests put real `File`s
  from a file input (`setInputFiles`) into a `DataTransfer` and dispatch `dragover`/`drop`: the real
  handler, the real preload (`webUtils.getPathForFile` returns the files' paths) and the real route
  run. A folder cannot be put in a file input, so folder drops are covered by the vault/route tests
  and the manual smoke run, not by e2e.

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
6. `modernise/06-export-release` — export renderer, HTML/PDF/Markdown export (notes, folders, vault),
   print, `.md` file associations, unfocused fully rendered editor, Playwright smoke tests, packaging
   verification and tag releases, README/contributing rewrite.
7. `modernise/07-note-names` — the file name is the note's name: shared file-name sanitiser, inline
   rename in the editor header, readable importer names, File › Rename Files From Titles….
8. `modernise/08-update-notice` — release check and status-bar update notice.
9. `modernise/09-rename-tasks` — inline-rename typing fix, import dialog fix, task progress bar.
10. `modernise/10-link-updates` — ask-each-time link updates after renaming/moving notes and folders.
11. `modernise/11-cli-mcp` — `boostnote` command line and MCP server over the vault, Install Command
    Line Tool… menu item.
12. `modernise/12-drop-import` — drag and drop `.md` files and folders into the vault (copies, with
    linked images and links between dropped notes), the one-function preload.

## Remix notes

Remix 3 gotchas in this setup (routing over `boost://`, startup deadlocks, SSR of client entries,
styles and CSP, the asset server, controlled inputs, testing) are in
[`REMIX-NOTES.md`](REMIX-NOTES.md).

## Vault notes

`src/vault` (public entry `src/vault/index.ts`) is plain Node, no Electron. Things consumers need to know:

- **Entry point:** `openVault(root, { watch: true })` returns a `Vault`: `tree()`, `index` (titles, tags,
  starred, `search()`), `readNote`/`writeNote`/`createNote`/`renameNote`/`moveNote`/`deleteNote`,
  `listTrash`/`restore`/`emptyTrash`, folder CRUD + colours/order, `saveAsset`/`assetPath`,
  `planTitleRenames`/`applyTitleRenames` (phase 7). Errors are
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
  extra reconcile runs a second after `startWatching` (on its own timer, so early events can't cancel
  it); `vault.refresh()` forces one (e.g. on window focus).
- **Frontmatter writes edit the YAML text in place:** unchanged keys keep their exact bytes (quotes,
  comments, flow lists); invalid YAML is treated as body, so nothing is ever lost.
