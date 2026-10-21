# Development

## Requirements

- Node.js 24 or newer
- pnpm 10 (`corepack enable` picks the version pinned in `package.json`)

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies (downloads Electron 45). |
| `pnpm dev` | Launch the app from source in development mode. Browser modules under `src/` are recompiled when they change; reload the window (View → Reload, `Cmd/Ctrl+R`) to pick them up. Main-process changes need a restart. |
| `pnpm check` | Biome lint + format check (`pnpm fix` applies safe fixes). |
| `pnpm typecheck` | TypeScript, `noEmit`. |
| `pnpm test` | Vitest unit tests in `tests/`. |
| `pnpm build` | Typecheck, then render the app with production settings and compile every browser asset it references. Nothing is transpiled ahead of time (see below). |
| `pnpm dist` | `pnpm build`, then package with electron-builder into `dist/` (mac dmg+zip, win nsis, linux AppImage+deb). Add `--mac --dir` (etc.) for an unpacked app. |

Build installers on the operating system (and CPU architecture) you are targeting: pnpm only installs
the native compiler bindings (oxc, lightningcss) for the host platform.

## How the app runs

- `src/main/index.js` is Electron's entry. It registers `remix/node-tsx`, a synchronous Node module
  hook that strips TypeScript and compiles JSX on load, then imports `src/main/main.ts`. No build step
  produces JavaScript for the main process.
- The main process registers the privileged `boost://` scheme and serves every `boost://app/...`
  request from the Remix router in `src/app/router.ts` (pages, `/assets/*`, `/events`).
- Browser code lives in `public/` directories (and `src/editor/`). The Remix asset server compiles
  those modules on request; `remix.json` lists what is browser-reachable.
- The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node integration) and only talks to the
  main process over `boost://app/` HTTP plus the `/events` Server-Sent Events stream.

See [`docs/modernisation/PLAN.md`](modernisation/PLAN.md) for the architecture and the decisions behind it.

## Debugging

- Renderer: View → Toggle Developer Tools.
- Main process: `pnpm exec electron --inspect=9229 .`, then attach Chrome (`chrome://inspect`) or your
  editor's Node debugger.
