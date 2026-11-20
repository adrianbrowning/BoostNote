# Deferred observations

Structure, naming and style observations that reviews raised and the user chose to defer, one entry
per finding: id, location, title, problem and suggested fix. Later factory runs add theirs here
(`.omp/factory.json` → `deferred`). An entry that a later slice fixed says so in a **Status** line.

## issue-22-md-case (slices 02 and 03)

### thermo-lower-case-entries-name-stale

- Location: `src/vault/names.ts:11`
- Title: lowerCaseEntries now returns NFC name keys, but its name still says lower-case
- Problem: After this fix, lowerCaseEntries returns `nameKey`s: NFC-normalized and lower-cased. Its doc was updated but its name was not, and callers (planTitleRenames, restore, deleteFolder, import planning) read as if the set held only lower-cased names. Someone adding a check could then build keys with `.toLowerCase()` to match the name, and bring back the NFC split the fix item just closed.
- Suggested fix: Rename lowerCaseEntries to something like `entryKeys` (or `nameKeysOf`) so the name matches nameKey.

### holistic-assets-flag-two-sources-of-truth

- Location: `src/vault/vault.ts:544`
- Title: Whether a twin's assets folder moved is decided twice: by each caller's flag and by the vault's disk check
- Problem: The fact that the shared assets folder stayed behind now reaches link updates in two ways. (1) Each caller passes `LinkMove.assets`, and each does it differently: CLI `relocated` (src/cli/commands.ts) and applyTitleRenames always set `assets: assetsLeftBehind === undefined` (true or false), while the app's linkMovesAfterRelocate (relocate.ts) sets only `assets: false` and leaves the field out otherwise. (2) The vault's new `#withAssetsState` works the flag out again from the disk (the old `<stem>.assets` still exists and is not the target) whenever the field is missing. For the app's ordinary renames the server decides, for its twin renames the client decides, and for the CLI the result object decides. All three agree today. But the rule lives in three places with two conventions, and a later change to one (for example, the case-only-rename inode check in #withAssetsState) can quietly disagree with the flag a caller sends, because an explicit flag skips the disk check.
- Suggested fix: Pick one owner. Either let the vault always decide (drop the explicit flag from `relocated`, applyTitleRenames' moves and linkMovesAfterRelocate, and keep #withAssetsState), or require the flag on note moves and remove #withAssetsState. If both stay, at least use one convention: always send `assets` explicitly, or never send `true`.
- **Status:** fixed in slice 04 (one convention): the app's `linkMovesAfterRelocate` now always sends `assets` (`true` when the folder moved, `false` for a twin), as the CLI and `applyTitleRenames` do. `Vault.#withAssetsState` stays only for callers that leave the field out.

### react-ts-relocate-input-restates-assets-left-behind-shape

- Location: `src/app/actions/public/workspace/relocate.ts:21`
- Title: linkMovesAfterRelocate types its input with a hand-written `{ id; assetsLeftBehind? }` instead of the exported AssetsLeftBehind type
- Problem: relocate.ts declares `result: { id: string; assetsLeftBehind?: string }` even though `AssetsLeftBehind` is exported from types.ts (and already used by api.ts for `client.restore` and `client.deleteNote`). Because the field is optional and the callers pass non-literal objects (NoteDocument, the restore and delete responses), the structural match is only checked loosely. If `AssetsLeftBehind`'s field is renamed or reshaped, `renamed`, `moved` and `restored` still compile against this hand-written shape: `assetsLeftBehind` would just be missing, so the sticky warning and the `assets: false` link move would stop happening without any type error. `assetsStayedText` in src/cli/main.ts (`{ assetsLeftBehind }: { assetsLeftBehind?: string }`) has the same issue for the CLI text.
- Suggested fix: Type the input as `{ id: string } & AssetsLeftBehind` (imported from ./types.ts), and type assetsStayedText's parameter as `AssetsLeftBehind`. Then a change to the shared field fails to compile at these sites.

### react-ts-relocate-outcome-handling-repeated-in-model

- Location: `src/app/actions/public/workspace/model.ts:641`
- Title: WorkspaceModel repeats the same 'show relocate outcome' steps after rename, move, trash and restore
- Problem: #renameFile (641-643) and moveNote (676-678) each run the same three lines: call linkMovesAfterRelocate, `if (outcome.notice) this.notify('info', outcome.notice, [], outcome.sticky)`, then `for (const move of outcome.moves) void this.#offerLinkUpdates(move, outcome.warning)`. deleteNote and restore repeat the notice half by hand again. relocate.ts was added so the model has one place for this rule, yet the model rebuilds how an outcome is applied in four places. If one of them changes (for example how the warning reaches the link-update notice), the others can be missed.
- Suggested fix: Add one private WorkspaceModel method, for example `#showRelocateOutcome(outcome: RelocateOutcome)`, that shows the notice (sticky when set) and offers each link move with the warning. Call it from #renameFile, moveNote, deleteNote and restore.

### react-ts-relocate-result-id-forced-for-trash

- Location: `src/app/actions/public/workspace/model.ts:743`
- Title: linkMovesAfterRelocate makes trash and restore pass an id it never reads, so deleteNote builds a fake one
- Problem: `linkMovesAfterRelocate` requires `result.id`, but it reads it only when `from` is set (rename and move). WorkspaceModel's delete path has no note result, so it builds `{ id, ...trashed }`. The real `noteDelete` response is the whole TrashEntry (controller.ts:214 returns `vault.deleteNote(...)`), and its own `id` (the trash id) comes after the note id in the spread and replaces it. This only works because `client.deleteNote` is typed `post<AssetsLeftBehind>`, which is narrower than the actual payload, and because the id is never read. The function's docs ("renamed, moved or restored", "restore (no `from`)") also leave out trash, which the model now sends through it. Today this is harmless, but the type does not describe what callers must supply, and the object it builds has the wrong id.
- Suggested fix: Make the input type say what is used: e.g. `{ move?: { from: string; to: string }; assetsLeftBehind?: string; done?: string }`, or keep `result` only on the rename/move branch. Then deleteNote passes `trashed.assetsLeftBehind` directly with no fake id. Mention trash in the docs.
- Status: partly fixed in slice 04: the relocate.ts docs now name trash. The type half (the forced `id`) remains.

### thermo-assets-left-behind-conditional-spread-repeated

- Location: `src/vault/vault.ts:905`
- Title: 'Assets stayed' is re-derived and spread in by hand in four places
- Problem: deleteNote, restore, #relocateNote and applyTitleRenames each repeat `...(assetsLeftBehind ? { assetsLeftBehind } : {})` (or the ternary push), and each turns the same optional string into `assets: assetsLeftBehind === undefined` / `assetsMove`. Each new operation must copy all three steps.
- Suggested fix: Have one small helper (for example `withAssetsLeftBehind(result, path)`) build the result shape and the matching LinkMove, or return a single typed relocation result from #relocateNote that holds both.

### thermo-extension-swap-composed-inline-at-each-call-site

- Location: `src/vault/vault.ts:406`
- Title: The extension 'swap' is put together by hand at five call sites
- Problem: The ticket asks for one shared helper that 'splits or swaps' a note's extension, but only the split was added. Every caller rebuilds the swap as `${stem}${splitNoteExtension(id).extension}`: renameNote, planTitleRenames, moveNote, deleteNote and restore. links.ts likewise builds `${splitNoteExtension(x).base}${ASSETS_SUFFIX}` twice, and sharedAssetsOf does it once more. The 'keep the note's extension' rule (decision 2) is therefore repeated in each place, not owned in one.
- Suggested fix: Add a `withNoteStem(id, stem)` (or `renameStem`) helper in src/shared/vault-ids.ts that returns `stem` plus `id`'s own extension, and an assets-folder-of-id helper. Use them at each call site.

### thermo-name-collision-helpers-added-to-oversized-vault-file

- Location: `src/vault/vault.ts:1078`
- Title: New filesystem name-collision helpers go into vault.ts, already over 1000 lines, not names.ts
- Problem: vault.ts was already over 1000 lines; this diff brings it to about 1100. It adds `nameTaken` and `sharedAssetsOf`, which are directory-scan name policies like `uniqueStem` and `lowerCaseEntries`, both owned by src/vault/names.ts. The rules for which names are taken in a folder are now split across two modules.
- Suggested fix: Move `nameTaken` and `sharedAssetsOf` into src/vault/names.ts beside uniqueStem, and import them from there.

### thermo-nfd-extension-case-test-seeds-unused-twins

- Location: `tests/vault/vault.test.ts:383`
- Title: NFD extension-case rename test calls seedTwins only as a file-system probe
- Problem: 'refuses to rename onto an NFD name that differs from the target only in extension case' calls `seedTwins()`, which writes `work/a.md`, `work/a.MD` and `work/a.assets/x.png`, only to learn whether the file system is case-sensitive. None of those files play a part in the behaviour under test (renaming `x.md` onto `Café` beside an NFD `Café.MD`). A reader has to work out that the twins are irrelevant, and a later change to seedTwins (more files, different names) changes this test's setup without reason.
- Suggested fix: Add a small `caseSensitive()` probe helper (write `probe.md`, `probe.MD`, count entries) and use it here, or seed only the files this test needs and check the folder entry count as the neighbouring tests do.

### thermo-notify-positional-sticky-after-details

- Location: `src/app/actions/public/workspace/model.ts:1268`
- Title: notify grows a positional boolean behind an optional array, so callers pass `[]` to reach it
- Problem: `notify(kind, text, details = [], sticky = false)` adds `sticky` as a fourth positional boolean after the optional `details`. All four new callers write `this.notify('info', notice, [], sticky)`, passing an empty array only to reach the flag. In the call, a bare `true`/`false` or `outcome.sticky` in fourth position does not say what it controls. The next notice option would be a fifth positional argument.
- Suggested fix: Replace the trailing positional arguments with an options object, e.g. `notify(kind, text, { details, sticky })`, or let callers pass a Notice-shaped value.

### thermo-operation-result-merged-into-note-entity

- Location: `src/app/actions/public/workspace/types.ts:68`
- Title: An operation result (`assetsLeftBehind`) is merged into the Note/NoteDocument entity types
- Problem: NoteDocument now extends AssetsLeftBehind, and Vault.renameNote, moveNote and #relocateNote return `Note & AssetsLeftBehind`. The field only means something right after a rename or move, but it now sits on the type that readNote, save and the editor session use. Every consumer of NoteDocument sees an optional field it can never get, and the result travels into `session.relocated(renamed)` as part of the note. toNoteDocument has to spread it in conditionally. This is an optional field used in place of a real result shape.
- Suggested fix: Return the operation result separately, e.g. `{ note: Note; assetsLeftBehind?: string }` from renameNote and moveNote (and a `{ note: NoteDocument, assetsLeftBehind? }` response from the rename and move routes), so NoteDocument and Note keep describing only a note.

### thermo-rebase-note-links-self-move-restated

- Location: `src/vault/vault.ts:927`
- Title: Callers of rebaseNoteLinks restate the note's own move to set one flag
- Problem: rebaseNoteLinks takes `fromId`, `toId` and an optional `moves` list that defaults to the note's own move `{ from: fromId, to: toId, kind: 'note' }`. To pass the new `assets` flag, #relocateNote (vault.ts:927) and restore (vault.ts:645) now each build that same self-move by hand, `[{ from, to, kind: 'note', assets }]`, repeating the from/to they already pass as positional arguments. So the self-move is defined in three places (the default and two call sites), and the positional from/to and the list's from/to could disagree without any error.
- Suggested fix: Give rebaseNoteLinks one way to describe the note's own move. For example, accept a `LinkMove` for the note (`rebaseNoteLinks(markdown, move, moves = [move])`), or add an `assets` option that the default self-move uses. Then the two note callers pass only the flag.

### thermo-relocate-outcome-sticky-derived-field

- Location: `src/app/actions/public/workspace/relocate.ts:31`
- Title: `sticky` is stored next to `warning` but is always just `warning !== undefined`
- Problem: RelocateOutcome has both `warning` and `sticky`, and linksUpdatedNotice and linkUpdateFailedNotice also return `sticky: warning !== undefined`. The fields cannot disagree, so `sticky` is derived state stored as a second field and computed in three places. A reader has to check that they always agree, and a later change to one rule (for example, a sticky notice with no warning) would have to be made in every copy.
- Suggested fix: Either drop `sticky` and let the one caller that shows a notice pass `warning !== undefined`, or keep `sticky` as the only output and compute it in one place (one small helper all three functions use).

### thermo-shared-assets-own-stem-key

- Location: `src/vault/names.ts:16` (`isExtensionCaseTwin`, called from sharedAssetsOf in `src/vault/vault.ts:1150`)
- Title: sharedAssetsOf compares twin stems with its own NFC-only key, not nameKey
- Problem: This diff adds `nameKey` in src/vault/names.ts (NFC plus lower case) as the key under which two names in a folder clash, and nameTaken, uniqueStem, planTitleRenames and import all use it. sharedAssetsOf builds a third key by hand: `noteStem(file).normalize('NFC')` compared against `noteStem(entry.name).normalize('NFC')`, which is NFC but keeps case. Its doc says stems are compared 'after NFC normalization as `nameTaken` does', but nameTaken also lower-cases, so the doc and the code disagree. The stem test is only a pre-filter (the real decision is `theirs === ours || sameDirectory(ours, theirs)`), so using the shared key costs nothing. Keeping a separate key means the next change to the clash rule (nameKey) has to find this copy too, and a `A.md` beside `a.MD` whose assets folders resolve to the same directory (for example through a symlink, as the NFD symlink test sets up) is never even checked.
- Suggested fix: Pre-filter candidates with `nameKey(noteStem(entry.name)) === nameKey(noteStem(file))` and fix the doc to say the stems are compared by nameKey, the same as nameTaken.
- Slice 04: the check moved to `isExtensionCaseTwin`: `noteStem(a).normalize('NFC') === noteStem(b).normalize('NFC')`. Applying the nameKey fix also flips the `['a.md', 'A.md', false]` row in `tests/vault/names.test.ts`, which pins the case-keeping comparison; change that row with it.

### thermo-stem-taken-predicate-copied-three-times

- Location: `src/vault/vault.ts:448`
- Title: The 'stem is taken' check and its reservation are copied in three places
- Problem: The rule for when a stem is taken in a folder (`names.has(`${key}.md`) || names.has(`${key}${ASSETS_SUFFIX}`)`) is written out in uniqueStem (names.ts:25-26), planTitleRenames (vault.ts:448-449) and import-files pickNoteId (import-files.ts:158-159). The reservation step (`names.add(`${nameKey(x)}.md`)` plus `names.add(`${nameKey(x)}${ASSETS_SUFFIX}`)`) is copied in planTitleRenames (451-452) and pickNoteId (161-162). This fix had to change all three copies to switch them to nameKey, which shows the drift this causes: the next change to the rule (another reserved suffix, a different key) has to find every copy again.
- Suggested fix: Add `stemTaken(names, stem)` and `reserveStem(names, stem)` to src/vault/names.ts. Have uniqueStem, planTitleRenames (keeping its `key !== own` exclusion around the call) and pickNoteId call them.

### thermo-links-updated-notice-dead-fallback

- Location: `src/app/actions/public/workspace/relocate.ts:37`
- Title: linksUpdatedNotice adds a `?? done` fallback that can never be used
- Problem: joinNotice returns `string | undefined` so that linkMovesAfterRelocate can return no notice. linksUpdatedNotice always passes a defined `done`, so joinNotice cannot return undefined there, and `?? done` is never used. It exists only to narrow the type. A reader has to work out that the fallback can never run.
- Suggested fix: Build the text directly here (`warning === undefined ? done : `${done}. ${warning}``). Or give joinNotice an overload, or a required first part, that returns `string` when that part is defined.
- Slice 04: `linkUpdateFailedNotice` in the same file adds a second dead fallback (`joinNotice(message, warning) ?? message`); the fix should cover it too.

### thermo-split-note-extension-redundant-check

- Location: `src/shared/vault-ids.ts:60`
- Title: splitNoteExtension checks isNoteFileName twice; the second check can never decide
- Problem: `isNoteFileName(lastSegment(id)) && isNoteFileName(id)`: when the last segment is longer than 3 characters and ends in `.md`, the whole id is too, so the second call always returns true. It makes a reader look for an edge case that does not exist.
- Suggested fix: Drop `&& isNoteFileName(id)`.

### testing-argv-test-manual-tempdir-cleanup

- Location: `tests/main/argv.test.ts:10`
- Title: argv test manages its temp dir with beforeEach/afterEach instead of `await using`
- Problem: The new markdownFilesIn test creates and removes its temp directory in beforeEach/afterEach through a shared mutable `cwd`. The repo already has the disposable pattern (`[Symbol.asyncDispose]` plus `await using`, in tests/lint/e2e-rules.test.ts). Testing rule 7 prefers that pattern for temp directories.
- Suggested fix: Build the temp dir with an async-disposable helper inside the test and bind it with `await using`.

### thermo-export-page-names-reimplement-unique-name

- Location: `src/markdown/export.ts:120`
- Title: Export page numbering re-implements uniqueName with an `n > 2` sentinel
- Problem: src/markdown/export.ts:120 | `for (let n = 2; taken.has(nameKey(page)) || (n > 2 && own.has(nameKey(page))); n++) page = `${base} ${n}.html`` hand-rolls the `base`, `base 2`, `base 3` search that `uniqueName` in src/vault/paths.ts already owns, and uses `n > 2` as a hidden 'this is a numbered candidate' flag (at n = 2 the page is still the unnumbered one). The behaviour is correct, but a reader has to trace the loop to see that the note's own page is exempt from the `own` check. The ' N' suffix rule now lives in two places, so a change to it (separator, start number) has to be made twice.
- Suggested fix: Use the existing helper: `const stem = uniqueName(base, (c) => taken.has(`${c}.html`) || (c !== base && own.has(`${c}.html`)))`, then `page = `${stem}.html``.
- Slice 04: the listing loop (`for (let n = 2; ; n++)` at `src/markdown/export.ts:111`) is a second copy of the same `n > 2` sentinel search. Move both to `uniqueName`.

### thermo-html-page-name-rule-in-two-modules

- Location: `src/markdown/render.ts:239`
- Title: The 'note id → .html page' rule is written inline three times across export.ts and render.ts
- Problem: Decision 5's rule (swap the note's `.md` in any case for `.html`) appears as `${splitNoteExtension(x).base}.html` in export.ts:90 (the `own` set), export.ts:95 (the first candidate), and render.ts:239 (the noteLinkToHtml fallback when `pages` has no entry). render.ts and export.ts each own one half of the page-naming policy. If the page rule changes (for example, encoding or a different extension), the fallback in render.ts can drift from the pages export writes, and links would point at files that do not exist.
- Suggested fix: Add one named helper, e.g. `htmlPageOf(id)` in render.ts next to noteLinkToHtml (or in export.ts and import it), and use it at all three sites.

### thermo-export-pages-lookup-cast

- Location: `src/markdown/export.ts:103`
- Title: Second export loop reads the page back from the map with an `as string` cast
- Problem: src/markdown/export.ts:103 | `(pages.get(note.id) as string)` casts away the `undefined` of a Map lookup to get a value the first loop computed a few lines earlier for the same `notes`. The cast is safe today only because both loops go over the same array. It hides that invariant from the type checker, so a later filter on one loop and not the other would compile and then crash at `.slice`.
- Suggested fix: Keep the pairing explicit: have the first loop build `const paged = notes.map((note) => ({ note, page }))` (and fill `pages` from it), then loop over `paged`; no lookup or cast is needed.

### test-validity-twin-export-test-only-runs-on-case-sensitive-fs

- Location: `tests/markdown/render.test.ts:225`
- Title: Extension-case twin export test (decision 8) only runs on ext4; a fakeVault version would run everywhere
- Problem: tests/markdown/render.test.ts | 'gives extension-case twins their own pages, the second one "a 2.html", and links each to its own page' | The test skips on default APFS and NTFS, so it runs only on the ubuntu CI runner. A local green run on the developer's macOS proves nothing about decision 8. exportFolderHtml reads only `vault.notes()` and `readNote`, and the same file already has a `fakeVault` helper, so the `a.md` / `a.MD` page naming and cross-links can be tested with no filesystem dependency. That is what the A.md/a.md and NFC/NFD cases already do. The on-disk case only adds the real vault scan, which slice 01 tests.
- Suggested fix: Add a fakeVault case with `a.md` and `a.MD` linking to each other, asserting `a.html` / `a 2.html` content and the cross-links, so decision 8 is checked on every runner. Keep the on-disk test as the ext4 integration check if wanted.

### thermo-export-pages-name-overloaded

- Location: `src/markdown/export.ts:98`
- Title: exportFolderHtml gives `pages` and `page` three meanings each
- Problem: src/markdown/export.ts:98 | This diff adds `const pages = new Map<string, string>()`, which maps a note id to its page path. In the same function, the listing loop at line 118 (`for (const [group, pages] of [...byFolder]...)`) shadows it with an array of `{ href, title }`, and its `pages.map((page) => ...)` reuses `page`, which the allocator loop just above uses for a page-path string. The function also returns `{ pages: notes.length }`, a count. A reader of the listing loop, or someone who later moves code between the two loops, can easily read the wrong `pages`. For example, using the id→page map inside the listing block silently gets the shadowing array.
- Suggested fix: Rename the new map so it describes what it holds (for example `pageOf` or `pageById`), or rename the listing loop's binding (`entries`, `links`) so nothing in the function is shadowed.

### thermo-export-page-allocation-buried-in-io

- Location: `src/markdown/export.ts:95`
- Title: The page-name decision is inlined in the export's filesystem orchestration, so it can only be tested by writing and reading HTML files
- Problem: src/markdown/export.ts:89-104 | Which page each note gets (any-case extension swap, nameKey collisions, twin numbering `a 2.html`, skipping names other notes own, the reserved listing name with its folder prefix) is a pure function of the note ids, the prefix and the listing name. This diff writes it inline in exportFolderHtml, between `mkdir(targetDir)` and the writeFile loop. Every test of the rule (twins, `A.md`/`a.md`, NFC/NFD, `_contents.md`) therefore needs a fake or real vault, a temp output directory, a full markdown render and file reads, and the setup is far bigger than the behaviour under test. The cases still uncovered (a numbered twin page skipping another note's own `a 2.html`, the listing reservation inside a subfolder export) would each be a one-line assertion against a pure function, but against this shape each needs a whole export.
- Suggested fix: Extract the allocator into a pure exported helper, for example `exportPages(ids: readonly string[], prefix: string, listing: string): Map<string, string>`, call it from exportFolderHtml, and unit-test the naming rules against it directly. Keep one end-to-end export test as the tracer bullet.

### thermo-on-disk-case-variant-export-test-duplicates-fake-vault-case

- Location: `tests/markdown/render.test.ts:256`
- Title: On-disk A.md/a.md export test restates the fakeVault naming rule and works out page names with a string trick
- Problem: tests/markdown/render.test.ts | 'on disk, gives A.md and a.md distinct pages' asserts the same page-naming rule (when names clash by nameKey, the second note gets '<stem> 2.html') as the fakeVault test 'gives notes differing only in name case or normalization distinct pages'. The fakeVault test runs on every filesystem. The on-disk test runs only on ext4. What only the on-disk test adds is that the real vault.refresh()/notes() scan passes both case-variant notes to export, but neither its name nor a comment says so. It also builds the expected file names with `${first.slice(0, 1)}.html` and `${second.slice(0, 1)} 2.html`, so a reader has to work out that the first character of the id is the stem. When the naming rule changes, both tests need updating, and this one is the harder to read.
- Suggested fix: Write the expected page names out in full, keyed by id (`{ 'A.md': 'A.html', 'a.md': 'a 2.html' }` from scan order), and narrow the test to what only it covers: the real vault scan keeping A.md and a.md as two notes into export. Leave the page-naming rule to the fakeVault test.

### comments-export-page-allocator-comment-repeats-doc

- Location: `src/markdown/export.ts:94`
- Title: Inline page-allocator comment repeats the exportFolderHtml doc
- Problem: src/markdown/export.ts:94-101 | `// Page of each note as a vault id (...). Names are compared by `nameKey` (...). A numbered page skips names another note has as its own (`a 2.md` keeps `a 2.html`), the folders the notes sit in (...) and the listing's name. The listing is named first: it skips those folders (...), and only a numbered listing name also skips the notes' own pages, so the plain listing name wins over a note's own page (`_contents.md` beside `index.md` → `_contents 2.html`).` | The JSDoc a few lines above already states the same rules: nameKey comparison, ` N` suffixes, the reserved listing name, the folder clash, and the A.md/a.md example. Two copies of one rule can drift apart.
- Suggested fix: Cut the inline comment down to what the JSDoc leaves out: page values are vault ids (prefix included), and the `n > 2 && own` clause lets a numbered candidate skip another note's own page. For example: `// pages: note id → page as a vault id (`work/Plan.MD` → `work/Plan.html`). `taken` starts with the listing; a numbered candidate also skips another note's own page (`a 2.md` keeps `a 2.html`).`

### comments-vault-session-test-mdx-comment-restates

- Location: `tests/main/vault-session.test.ts:351`
- Title: Test comment restates the .mdx/.markdown drop assertion below it
- Problem: tests/main/vault-session.test.ts:351 | `// `.mdx` and `.markdown` files are not notes and are dropped.` | The comment says what the next five lines do: they write `a.mdx` and `b.markdown`, request to open both, and expect `takeOpenRequest()` to return undefined. It tells a reader nothing the code does not already show.
- Suggested fix: Delete the comment. The file names and the `toBeUndefined()` assertion already say that these files are dropped.

