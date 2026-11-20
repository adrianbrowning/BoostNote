# Agent notes

- Trunk is `master`. Work lands as stacked PRs (`gh stack`), one layer per concern.
- Remix 3 is not React: read `node_modules/remix/INDEX.md`, then
  [`docs/modernisation/REMIX-NOTES.md`](docs/modernisation/REMIX-NOTES.md) for this app's gotchas.
- Architecture, decisions and per-feature behaviour (vault, links, tabs, export, CLI/MCP, drop
  import): [`docs/modernisation/PLAN.md`](docs/modernisation/PLAN.md), one section per feature.
- Smoke-run the real app on a copy of a vault with `pnpm smoke` (see `scripts/smoke.ts`); the committed
  sample vault works out of the box: `pnpm smoke --vault-copy tests/fixtures/sample-vault`. Never point
  the app or a test at the user's own vault.
- Tests that skip on the default macOS disk (extension-case twins `a.md` beside `a.MD`, NFC/NFD names) run with
  `pnpm test:linux [paths]` (Docker, ext4) and `pnpm test:case-sensitive [paths]` (macOS, temporary case-sensitive
  APFS image as TMPDIR); see `scripts/test-linux.sh` and `scripts/test-case-sensitive.sh`.
