<h1 align="center">Boostnote</h1>

<p align="center">A note-taking app for programmers: plain Markdown files, a live-preview editor, math and diagrams.<br>
macOS, Windows and Linux. Built with Electron and Remix 3.</p>

![Boostnote with a note showing KaTeX math and a mermaid diagram](docs/modernisation/screenshot.png)

This is a modernised fork of [BoostNote-Legacy](https://github.com/BoostIO/BoostNote-Legacy). The old
React/Redux app and its CSON storage are gone; notes are now ordinary `.md` files in a folder you
choose, so any editor, `git` or sync tool works with them. The background and decisions are in
[docs/modernisation/PLAN.md](docs/modernisation/PLAN.md).

## Features

- **Vaults of plain Markdown.** A vault is any folder: notes are `.md` files with optional YAML
  frontmatter (`title`, `tags`, `starred`, `created`, `updated`, and any keys of your own, kept
  verbatim), folders are directories, pasted images live next to the note in `<note>.assets/`.
- **One live-preview editor** (CodeMirror 6, Obsidian/Typora style): markers hide when the cursor
  leaves a construct, and an unfocused note looks fully rendered. Images, task checkboxes, tables,
  KaTeX math (`$…$`, `$$…$$`, ```` ```math ````) and ```` ```mermaid ```` diagrams render in place.
  Syntax-highlighted fenced code, `/` slash commands, markdown shortcuts, list continuation, image
  paste/drop, HTML paste → Markdown.
- **Live reload.** Edit a note in another app and it updates; edits on both sides end in a conflict
  bar instead of silent data loss.
- **Organise:** folder tree with colours, tags, starred notes, full-text search, sort, a Trash with
  restore, drag and drop.
- **Tabs** with per-tab back/forward, restored per vault. A **properties panel** for frontmatter.
- **Export:** a note as standalone HTML (math, diagrams and images included, no scripts), PDF, or
  Markdown with its assets; print; a folder or the whole vault as a static HTML site.
- **Open `.md` files** from Finder/Explorer: the file's folder opens as a vault.
- **Preferences:** light/dark/system theme, editor font, size and width, spellcheck, a global
  show/hide hotkey. Every command has a native menu item and shortcut.

## Install

Download an installer from the [releases](https://github.com/adrianbrowning/BoostNote/releases)
(macOS `.dmg`/`.zip`, Windows NSIS `.exe`, Linux `.AppImage`/`.deb`). Builds are unsigned unless
signing secrets are configured, so macOS may ask you to confirm the first launch (right-click → Open).

## Coming from Boostnote (legacy)

Use **File → Import Boostnote Storage…** (or `pnpm migrate <legacyStorageDir> <targetVaultDir>`). The
importer only reads the old storage and writes a new vault: folders, tags, starred state, dates,
attachments and snippet notes (converted to Markdown with fenced code) carry over. Details and the
full mapping: [docs/modernisation/MIGRATION.md](docs/modernisation/MIGRATION.md).

## Development

Requires Node.js 24+ and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run the app from source; browser modules recompile on change (reload the window), main-process changes need a restart. |
| `pnpm check` / `pnpm fix` | Biome lint + format check / apply safe fixes. |
| `pnpm typecheck` | TypeScript (strict, `noEmit`). |
| `pnpm test` | Vitest unit tests (`tests/`, excluding `tests/e2e`). |
| `pnpm test:e2e` | Playwright smoke tests driving the real Electron app (`tests/e2e`). |
| `pnpm build` | Typecheck, then render the app with production settings and compile every browser asset. |
| `pnpm dist` | `pnpm build`, then installers in `dist/` via electron-builder (build each on its own OS). |
| `pnpm migrate <src> <dst>` | Convert a legacy Boostnote storage into a vault from the command line. |

See [contributing.md](contributing.md) for the workflow and project layout.

## Architecture

- **Electron main process** (`src/main`) runs TypeScript directly through `remix/node-tsx`; there is
  no bundler. It owns the window, native menus, dialogs, the settings file and every disk access.
- **Remix 3 router in main** (`src/app`): the renderer loads `boost://app/`, and `protocol.handle`
  answers each request with `router.fetch()`: server-rendered pages, a JSON API, browser modules
  compiled on demand by `remix/assets`, and one Server-Sent Events stream for pushes (menu commands,
  file changes).
- **Sandboxed renderer:** `contextIsolation`, `sandbox`, no Node, no preload, a nonce-based CSP.
- `src/vault` — storage core (notes, frontmatter, folders, assets, trash, watcher, search index).
- `src/editor` — the CodeMirror 6 live-preview editor. `src/markdown` — the export renderer
  (markdown-it, KaTeX, server-side highlighting, sanitising; mermaid laid out in a hidden window).
- `src/migrate` — legacy CSON importer.

## License

[GPL v3](./LICENSE). Copyright © 2016-2026 BoostIO, Inc. and contributors.
