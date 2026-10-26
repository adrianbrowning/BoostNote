# Contributing to Boostnote

Thanks for helping. Bugs and ideas go to the [issue tracker](https://github.com/adrianbrowning/BoostNote/issues)
(there is a template; screenshots with the developer tools console open help a lot). Code goes in
pull requests (there is a template for those too).

## Setup

- Node.js 24 or newer and pnpm 10 (`corepack enable` picks the version pinned in `package.json`).
- `pnpm install` downloads Electron 45 and the native compiler bindings for your platform.
- `pnpm dev` runs the app from source.

## Toolchain

| Tool | Use |
| --- | --- |
| TypeScript (strict, ESM) | All code. `tsc` only type-checks (`noEmit`); nothing is transpiled ahead of time. |
| `remix/node-tsx` | Loads TS/JSX in the Electron main process (`src/main/index.js` registers it). |
| Remix 3 (`remix@3`) | Router, server rendering, client entries and the asset server. Not React: read `node_modules/remix/INDEX.md` and the package READMEs before using an API. |
| Biome | Lint and format (`pnpm check`, `pnpm fix`). |
| Vitest | Unit tests in `tests/` mirroring `src/` (`happy-dom` where a DOM is needed). |
| Playwright `_electron` | End-to-end smoke tests in `tests/e2e/` against the real app. |
| electron-builder | Installers (`electron-builder.yml`). |

## Before you open a pull request

```sh
pnpm check && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e   # launches Electron windows; on Linux run it under xvfb-run
```

`pnpm install` also installs a pre-commit hook (`.githooks/pre-commit`: `pnpm check` and
`pnpm typecheck`). CI runs all of the above on macOS and Ubuntu; in CI a test that passes only on
its retry fails the run. A failed e2e run leaves `test-results/results.json` (every failure's
message and location) and traces of the failed tests, so read those before running it again.

To try a change on real notes, run the app on a copy: `pnpm smoke --vault-copy ~/MyVault
[--steps steps.ts] [--shot /tmp/shot.png]` (`--steps` gets the launched app, as in
`tests/e2e/fixtures.ts`). The copy and a temp profile go to a temp folder; the source is only read.

A CI job shown as `cancelled` with no steps run never got a runner (GitHub-hosted macOS runners can
queue for a long time); re-run it with `gh run rerun <run-id> --failed`.

Add or update tests with your change, and update
[docs/modernisation/PLAN.md](docs/modernisation/PLAN.md) when you change architecture or behaviour
it describes. Reviews follow [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Project layout

```
src/main/      Electron main: lifecycle, window, menus, boost:// protocol, SSE hub, settings, export windows
src/app/       Remix app: routes, router, controllers (actions/), server UI (ui/), browser code in **/public/
src/vault/     storage core (plain Node, no Electron)
src/editor/    CodeMirror 6 live-preview editor (browser-only, framework-agnostic)
src/markdown/  Markdown → standalone HTML for export, PDF and printing
src/migrate/   legacy CSON storage importer + CLI
src/cli/       boostnote command line + MCP server (one command layer over src/vault)
tests/         unit tests; tests/e2e Playwright smoke tests
```

Things that are easy to get wrong:

- Controllers never import Electron: anything native (dialogs, `shell`, windows) goes through
  `AppServices` (`src/app/services.ts`), which tests replace with fakes.
- Browser modules must be reachable through `remix.json` (`allowFiles`, `allowPackages`); packages
  that only ship CommonJS cannot be served (mermaid is vendored, see `src/app/vendor.ts`).
- Never top-level `await app.whenReady()` in the main-process import graph: Electron emits `ready`
  only after the entry module has evaluated.
- Every app keyboard shortcut is a native menu accelerator (`shortcuts.ts`), delivered to the
  renderer as an SSE `menu` event.

## Debugging

- Renderer: View → Toggle Developer Tools.
- Main process: `pnpm exec electron --inspect=9229 .`, then attach `chrome://inspect` or your editor.

## Packaging

`pnpm dist` builds installers for the current OS into `dist/` (`-- --mac --dir` for just the app).
Build each platform on its own OS and architecture: pnpm installs native bindings for the host only.
Tagging `v*` makes CI build macOS, Windows and Linux installers and attach them to a draft release;
signing is optional (`CSC_LINK`/`CSC_KEY_PASSWORD`, plus `APPLE_*` secrets for notarisation).

## Concerning Copyright

By making a pull request you agree to transfer ownership of your code to BoostIO.

This doesn't mean Boostnote will become a paid app. If we want to earn money, we will find other way. Potentially some kind of cloud storage, mobile app integration, or some premium features.
GPL v3 is too strict to be compatible with another license, so we thought it might be necessary to replace the license with a more open one (like BSD, MIT) eventually.
