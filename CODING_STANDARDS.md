# Coding standards (review)

Rules a reviewer checks on a diff. Mechanical rules live in Biome, `tsc` and the tests instead.

## Trust boundary

- **Paths come from main, never from the page.** A route that touches the filesystem outside the
  open vault takes its path from main: a native dialog (`services.pickFolder`, save dialogs) or a
  ticket main granted (`DropGrants`). A route body that carries an absolute path the page chose is a
  finding, even when the page "got it from a drop".
- **Vault access goes through `src/vault`.** Controllers and the CLI read and write notes through
  `Vault` methods (atomic, traversal-checked, `#track`ed); a direct `fs` write into the vault is a
  finding.
- **Saves are conditional.** Writes that replace a note the user or an agent may have edited pass the
  hash they are based on (`baseHash`), and a `CHANGED` result becomes a conflict, not an overwrite.

## UI (Remix 3)

- **Controlled inputs update.** An input with `value={x}` sets `x` and calls `handle.update()` in its
  input handler. Code that writes into a field from an async task while the user may be typing is a
  finding (offer the value as a button). See `docs/modernisation/REMIX-NOTES.md`.

## Tests

- **Typing is typed.** An e2e test of a text field uses `page.keyboard.type`, not `fill()`.
- **Fixtures stay put.** The shared `test.use({ files })` fixture of a spec is not changed for a new
  test; the new test seeds its own files (`writeFiles` then wait for the note, or its own
  `test.describe` with `test.use`).
- **Smoke on copies.** Scripts and tests open temp vaults or copies (`pnpm smoke --vault-copy`), with
  a temp `--user-data-dir`; a path to a real vault (`~/…`) in a test or script is a finding.
