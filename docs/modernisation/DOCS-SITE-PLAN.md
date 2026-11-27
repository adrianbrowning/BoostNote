# User guide site: plan

Status: plan only. Nothing is built yet. Research and sources: [`DOCS-SITE-RESEARCH.md`](DOCS-SITE-RESEARCH.md).

## Goal

A user guide for Boostnote, hosted on GitHub Pages. It answers two questions for each feature:
**What can I do?** and **How do I do it?** It is for people who use the app, not for people who
work on its code. Internals (CSP, asset server, the relocation sequence) stay in `PLAN.md`.

Each page is a set of tasks. Each task has:

1. A title in the user's words ("Insert a table", not "Table widget").
2. Numbered steps: the menu path, the shortcut, or the control to click.
3. A screenshot of what the user sees after the steps.
4. Tips and limits that a user cares about.

Shortcuts show both forms: <kbd>⌘</kbd> on macOS, <kbd>Ctrl</kbd> on Windows and Linux.

## Pages

| # | Page | Tasks |
|---|---|---|
| 0 | Home | What Boostnote is, a hero screenshot, download link, links to each page |
| 1 | Get started | Install; open a folder as a vault; tour the window (sidebar, note list, editor, status bar, resize and hide panes); open a `.md` file from Finder/Explorer (reader tab); use several vaults; come from old Boostnote (import a storage) |
| 2 | Write notes | Create a note; rename it (the file name is the note name); live preview; format with shortcuts; slash commands (full list of all 17); insert a table (size grid); tasks and the progress bar; math, diagrams and code; images (paste, drop, `/image`); links between notes; find in a note; fix spelling (right-click); edits from other apps and the conflict bar; MDX notes |
| 3 | Organise notes | Folders and colours; move notes and folders (drag and drop); keep links working after a rename or move; tags; star; pin; properties panel (frontmatter); Trash and restore; sort the list; show the file on disk |
| 4 | Find notes | Search all notes; browse All notes, folders, tags, Starred; note-list previews |
| 5 | Tabs | Open, close and switch tabs; back and forward per tab; tabs come back per vault |
| 6 | Quick capture | New scratch note; the global Quick capture hotkey; keep, reopen, discard, or save a scratch note to a vault; show or hide Boostnote from anywhere |
| 7 | Share and export | Export a note as HTML, PDF or Markdown; export a folder or the vault as a website; print |
| 8 | Bring notes in | Drag `.md`/`.mdx` files and folders into the app; add a read-only file to the vault; import old Boostnote |
| 9 | Customise | Every preference: values, default, effect (table from the inventory); updates and the update notice |
| 10 | Terminal and AI tools | Install the `boostnote` command; choose the vault; every CLI command with an example; the MCP server, its tools, config snippets for Claude Desktop, Cursor and Claude Code |
| 11 | Keyboard shortcuts | One reference table, generated from `src/shared/commands.ts` so it stays correct |

The full task inventory, with steps, sources and the way to reach each UI state, is in
[`DOCS-SITE-INVENTORY.md`](DOCS-SITE-INVENTORY.md).

## Screenshots

- **What makes them:** shot specs in `tests/docs/*.shot.ts` with their own Playwright config
  (one project per theme), run by hand with `pnpm docs:shots`. A small fixture calls the e2e
  `launchApp` with `vaultCopyOf` (a temp copy, so no real vault is touched), sets the window content
  to 1200×760, and then uses `clickMenu`, `writeFiles`, `openLooseFile` and `pressGlobalShortcut`.
  The e2e fixture does not change.
- **Demo vault:** `tests/fixtures/docs-vault/` (the sample vault has only two notes). It holds nested
  folders, a showcase note (headings, an image, a table, math, a Mermaid diagram, code, tasks),
  tags, starred and pinned notes, custom properties, notes that link to each other, and enough text
  for search.
- **Light and dark:** each shot is taken twice. A `<Shot>` component shows both images with
  Starlight's `dark:sl-hidden` and `light:sl-hidden` classes, so the reader sees the one that
  matches the site theme.
- **Format:** PNG at 2× (made on a Retina Mac), committed under `site/src/assets/shots/`. Astro's
  image pipeline writes optimised WebP at build time, so the shot script does no conversion.
- **One spec per page:** a UI change means one command to make the shots again. Make them again
  before each release, because nothing checks them against the UI.
- **Not possible:** native menus, native dialogs, native context menus, the print dialog and terminal
  output. The pages show the menu path in text, and terminal output in code blocks from real runs.

## Delivery

One stacked PR per layer (`gh stack`), bottom to top:

1. **Site skeleton and deploy:** generator, config, home page, a GitHub Actions workflow that builds
   and deploys to Pages. One human step: set Pages source to "GitHub Actions" in the repo settings.
2. **Screenshot tool and demo vault:** the capture script, the demo vault, a `pnpm` script.
3. **Pages 1–4:** get started, write, organise, find.
4. **Pages 5–9:** tabs, quick capture, export, bring notes in, customise.
5. **Pages 10–11:** terminal and AI tools, keyboard shortcuts.
6. **Links:** README points to the site; `PLAN.md` says which page owns each user-visible feature, so a
   new feature also gets a guide entry.

## Tooling

From [`DOCS-SITE-RESEARCH.md`](DOCS-SITE-RESEARCH.md):

- **Generator:** Astro Starlight 0.43 (on Astro 7), pinned. Chosen over VitePress for `<Steps>`
  (numbered steps), `<Tabs syncKey="os">` (the reader picks macOS or Windows/Linux once, and every
  page follows), `<Aside>` (tips and warnings), and Pagefind search. Its cost is about 184 MB in
  274 packages, against about 101 MB for VitePress. Pages are `.mdx` so they can use the
  components.
- **Location:** `site/` is its own package with its own lockfile, not a pnpm workspace member. So the
  app's CI installs nothing extra, electron-builder never ships it, and `docs/modernisation/` stays the
  developer docs. Biome checks `site/**/*.ts` and `.astro` files and skips `.md` and `.mdx` files.
- **Deploy:** `.github/workflows/pages.yml` with `configure-pages@v6`, `upload-pages-artifact@v5`
  and `deploy-pages@v5`. It runs only when `site/**`, `src/shared/commands.ts` or the workflow
  changes. Pull requests build the site (this catches dead links) but do not deploy.
- **Shortcuts page:** an Astro component imports `src/shared/commands.ts` at build time and
  writes "⌘N on macOS, Ctrl+N on Windows and Linux". Keys such as `Ctrl+Tab` stay Ctrl on every
  platform.

## Risks and open questions

| Risk | Plan |
|---|---|
| **Dark shots come out light.** The research says Playwright's `_electron` makes the page light by default, so the theme setting alone may not work. The inventory says `page.emulateMedia` can put the editor and Mermaid out of step with the app theme. | First task of layer 2: a spike that sets both `ui.theme` and `emulateMedia({ colorScheme })` and checks one dark shot by eye. |
| Starlight is before 1.0, so a minor version can break the config. | Pin exact versions with a lockfile. Read the release notes before an update. |
| Not checked: the Astro build can import `../src/shared/commands.ts` from outside `site/`. | Spike in layer 1. If not, a small script writes `commands.json` before the build. |
| Native UI (menus, title bar, dialogs, context menus, print) cannot be captured. | Menu paths in text, for example **File › Export › Note as HTML…**. |
| Shots look like macOS and need a Retina Mac. | Accept it. The pages say so where Windows or Linux differ. |

## Human steps

- Enable Pages: **Settings › Pages › Source: GitHub Actions**, or
  `gh api -X POST repos/adrianbrowning/BoostNote/pages -f build_type=workflow`. The Pages API returns
  404 today, so Pages is off.
