# Agent notes

- Trunk is `master`. Work lands as stacked PRs (`gh stack`), one layer per concern.
- Remix 3 is not React: read `node_modules/remix/INDEX.md`, then
  [`docs/modernisation/REMIX-NOTES.md`](docs/modernisation/REMIX-NOTES.md) for this app's gotchas.
- Architecture, decisions and per-feature behaviour (vault, links, tabs, export, CLI/MCP, drop
  import): [`docs/modernisation/PLAN.md`](docs/modernisation/PLAN.md), one section per feature.
- The user guide (task-based, for people who use the app) is the Starlight site in `site/`, published to
  GitHub Pages: `pnpm docs:dev`, `pnpm docs:build`. A user-visible change updates its page in
  `site/src/content/docs/`; when the UI changes, run `pnpm docs:shots [tests/docs/<page>.shot.ts]` (real app
  on a copy of `tests/fixtures/docs-vault`, light and dark PNGs) and look at the images. Shortcuts in pages
  come from `src/shared/commands.ts` through `<Shortcut command="…" />`. See
  [`docs/modernisation/DOCS-SITE-PLAN.md`](docs/modernisation/DOCS-SITE-PLAN.md).
- Smoke-run the real app on a copy of a vault with `pnpm smoke` (see `scripts/smoke.ts`); the committed
  sample vault works out of the box: `pnpm smoke --vault-copy tests/fixtures/sample-vault`. Never point
  the app or a test at the user's own vault.
- Tests that skip on the default macOS disk run elsewhere: `pnpm test:linux [paths]` (Docker, ext4) runs the
  extension-case twins (`a.md` beside `a.MD`) and the tests where NFC and NFD names are two files;
  `pnpm test:case-sensitive [paths]` (macOS, temporary case-sensitive APFS image as TMPDIR) runs the twins and the
  NFD-twin case that needs case-sensitive, normalization-insensitive APFS. See `scripts/test-linux.sh` and
  `scripts/test-case-sensitive.sh`.
