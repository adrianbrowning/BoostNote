# Agent notes

- Trunk is `master`. Work lands as stacked PRs (`gh stack`), one layer per concern.
- Remix 3 is not React: read `node_modules/remix/INDEX.md`, then
  [`docs/modernisation/REMIX-NOTES.md`](docs/modernisation/REMIX-NOTES.md) for this app's gotchas.
- Architecture, decisions and per-feature behaviour (vault, links, tabs, export, CLI/MCP, drop
  import): [`docs/modernisation/PLAN.md`](docs/modernisation/PLAN.md), one section per feature.
- Smoke-run the real app on a copy of a vault with `pnpm smoke` (see `scripts/smoke.ts`); never point
  the app or a test at the user's own vault.
