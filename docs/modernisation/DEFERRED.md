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
- **Status:** run issue-17-18 slice 03: the vault now owns the flag for every app and CLI relocation: `renameNote`/`moveNote` build each move with an explicit `assets` and return it, and the app and CLI pass the returned moves as they are. `#withAssetsState` serves only moves built by hand outside the vault.

### react-ts-relocate-input-restates-assets-left-behind-shape

- Location: `src/app/actions/public/workspace/relocate.ts:21`
- Title: linkMovesAfterRelocate types its input with a hand-written `{ id; assetsLeftBehind? }` instead of the exported AssetsLeftBehind type
- Problem: relocate.ts declares `result: { id: string; assetsLeftBehind?: string }` even though `AssetsLeftBehind` is exported from types.ts (and already used by api.ts for `client.restore` and `client.deleteNote`). Because the field is optional and the callers pass non-literal objects (NoteDocument, the restore and delete responses), the structural match is only checked loosely. If `AssetsLeftBehind`'s field is renamed or reshaped, `renamed`, `moved` and `restored` still compile against this hand-written shape: `assetsLeftBehind` would just be missing, so the sticky warning and the `assets: false` link move would stop happening without any type error. `assetsStayedText` in src/cli/main.ts (`{ assetsLeftBehind }: { assetsLeftBehind?: string }`) has the same issue for the CLI text.
- Suggested fix: Type the input as `{ id: string } & AssetsLeftBehind` (imported from ./types.ts), and type assetsStayedText's parameter as `AssetsLeftBehind`. Then a change to the shared field fails to compile at these sites.
- **Status:** run issue-17-18 slice 03: `linkMovesAfterRelocate` is gone; the hand-written `{ assetsLeftBehind?; done? }` input shape is now on `relocateNotice` (relocate.ts), and `assetsStayedText` is unchanged. Still open under the new name.

### react-ts-relocate-outcome-handling-repeated-in-model

- Location: `src/app/actions/public/workspace/model.ts:641`
- Title: WorkspaceModel repeats the same 'show relocate outcome' steps after rename, move, trash and restore
- Problem: #renameFile (641-643) and moveNote (676-678) each run the same three lines: call linkMovesAfterRelocate, `if (outcome.notice) this.notify('info', outcome.notice, [], outcome.sticky)`, then `for (const move of outcome.moves) void this.#offerLinkUpdates(move, outcome.warning)`. deleteNote and restore repeat the notice half by hand again. relocate.ts was added so the model has one place for this rule, yet the model rebuilds how an outcome is applied in four places. If one of them changes (for example how the warning reaches the link-update notice), the others can be missed.
- Suggested fix: Add one private WorkspaceModel method, for example `#showRelocateOutcome(outcome: RelocateOutcome)`, that shows the notice (sticky when set) and offers each link move with the warning. Call it from #renameFile, moveNote, deleteNote and restore.
- **Status:** run issue-17-18 slice 03: the outcome (`RelocateNotice`) no longer has moves, and `#showRelocateOutcome(outcome: RelocateOutcome)` would no longer fit. Still open: the notice half is repeated in #renameFile, moveNote, deleteNote and restore, and `#offerLinkUpdates(x.moves, outcome.warning)` in #renameFile and moveNote.
- **Status:** run issue-17-18 slice 04: renames and moves of notes and folders now run in `Relocation` (`relocation.ts`), which shows their notice (`#report`) and offers the link update in one place each; the model no longer has those copies. Still open: deleteNote and restore in model.ts each show their `relocateNotice` by hand.

### react-ts-relocate-result-id-forced-for-trash

- Location: `src/app/actions/public/workspace/model.ts:743`
- Title: linkMovesAfterRelocate makes trash and restore pass an id it never reads, so deleteNote builds a fake one
- Problem: `linkMovesAfterRelocate` requires `result.id`, but it reads it only when `from` is set (rename and move). WorkspaceModel's delete path has no note result, so it builds `{ id, ...trashed }`. The real `noteDelete` response is the whole TrashEntry (controller.ts:214 returns `vault.deleteNote(...)`), and its own `id` (the trash id) comes after the note id in the spread and replaces it. This only works because `client.deleteNote` is typed `post<AssetsLeftBehind>`, which is narrower than the actual payload, and because the id is never read. Today this is harmless, but the type does not describe what callers must supply, and the object it builds has the wrong id.
- Suggested fix: Make the input type say what is used: e.g. `{ move?: { from: string; to: string }; assetsLeftBehind?: string; done?: string }`, or keep `result` only on the rename/move branch. Then deleteNote passes `trashed.assetsLeftBehind` directly with no fake id. Mention trash in the docs.
- Status: partly fixed in slice 04: the relocate.ts docs now name trash. Fixed in run issue-17-18 slice 03: `linkMovesAfterRelocate` is gone; `relocateNotice({ assetsLeftBehind, done })` takes only what it uses, and deleteNote passes `trashed.assetsLeftBehind` with no fake id.

### thermo-assets-left-behind-conditional-spread-repeated

- Location: `src/vault/vault.ts:905`
- Title: 'Assets stayed' is re-derived and spread in by hand in four places
- Problem: deleteNote, restore, #relocateNote and applyTitleRenames each repeat `...(assetsLeftBehind ? { assetsLeftBehind } : {})` (or the ternary push), and each turns the same optional string into `assets: assetsLeftBehind === undefined` / `assetsMove`. Each new operation must copy all three steps.
- Suggested fix: Have one small helper (for example `withAssetsLeftBehind(result, path)`) build the result shape and the matching LinkMove, or return a single typed relocation result from #relocateNote that holds both.
- **Status:** partly fixed in run issue-17-18 slice 03: `#relocateNote` now returns one `NoteRelocation` holding the move and `assetsLeftBehind`. The conditional spread is still written out in deleteNote, restore and applyTitleRenames.

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
- **Status:** fixed in run issue-17-18 slice 03: `renameNote`/`moveNote` return `{ note, moves, assetsLeftBehind? }`, the routes send `{ note: NoteDocument, moves, assetsLeftBehind? }`, and NoteDocument no longer extends AssetsLeftBehind.

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
- **Status:** run issue-17-18 slice 03: `RelocateOutcome` is now `RelocateNotice` (from `relocateNotice`); the problem is otherwise unchanged.

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
- **Status:** run issue-17-18 slice 03: `linkMovesAfterRelocate` is now `relocateNotice`, which is the caller that needs `joinNotice`'s `undefined`; the problem is otherwise unchanged.

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
- Suggested fix: Use the existing helper: `const stem = uniqueName(base, (c) => taken.has(nameKey(`${c}.html`)) || (c !== base && own.has(nameKey(`${c}.html`))))`, then `page = `${stem}.html``.
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

- Location: `src/markdown/export.ts:104`
- Title: exportFolderHtml gives `pages` and `page` three meanings each
- Problem: src/markdown/export.ts:104 | This diff adds `const pages = new Map<string, string>()`, which maps a note id to its page path. In the same function, the listing loop at line 137 (`for (const [group, pages] of [...byFolder]...)`) shadows it with an array of `{ href, title }`, and its `pages.map((page) => ...)` reuses `page`, which the allocator loop just above uses for a page-path string. The function also returns `{ pages: notes.length }`, a count. A reader of the listing loop, or someone who later moves code between the two loops, can easily read the wrong `pages`. For example, using the id→page map inside the listing block silently gets the shadowing array.
- Suggested fix: Rename the new map so it describes what it holds (for example `pageOf` or `pageById`), or rename the listing loop's binding (`entries`, `links`) so nothing in the function is shadowed.

### thermo-export-page-allocation-buried-in-io

- Location: `src/markdown/export.ts:95`
- Title: The page-name decision is inlined in the export's filesystem orchestration, so it can only be tested by writing and reading HTML files
- Problem: src/markdown/export.ts:89-104 | Which page each note gets (any-case extension swap, nameKey collisions, twin numbering `a 2.html`, skipping names other notes own, the reserved listing name with its folder prefix) is a pure function of the note ids, the prefix and the listing name. This diff writes it inline in exportFolderHtml, between `mkdir(targetDir)` and the writeFile loop. Every test of the rule (twins, `A.md`/`a.md`, NFC/NFD, `_contents.md`, a numbered twin page skipping another note's own `a 2.html`, the listing reservation inside a subfolder export) therefore needs a fake or real vault, a temp output directory, a full markdown render and file reads, and the setup is far bigger than the behaviour under test. Against a pure function each would be a one-line assertion.
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
- Suggested fix: Cut the inline comment down to what the JSDoc leaves out: page values are vault ids (prefix included), and the `n > 2 && own` clause lets a numbered candidate skip another note's own page. For example: `// pages: note id → page as a vault id (`work/Plan.MD` → `work/Plan.html`). `taken` starts with the folders the notes sit in, then the listing; a numbered candidate also skips another note's own page (`a 2.md` keeps `a 2.html`).`

### comments-vault-session-test-mdx-comment-restates

- Location: `tests/main/vault-session.test.ts:351`
- Title: Test comment restates the .mdx/.markdown drop assertion below it
- Problem: tests/main/vault-session.test.ts:351 | `// `.mdx` and `.markdown` files are not notes and are dropped.` | The comment says what the next five lines do: they write `a.mdx` and `b.markdown`, request to open both, and expect `takeOpenRequest()` to return undefined. It tells a reader nothing the code does not already show.
- Suggested fix: Delete the comment. The file names and the `toBeUndefined()` assertion already say that these files are dropped.


## issue-22 (slices 01 and 02, retro)

### issue-22/01: Consumer list in link-cases JSDoc has a doubled 'and'

Run: issue-22
Slice: 01 "Editor images use the shared relative-link rule"
Review: 01-r1

### [observation] comments-link-cases-consumer-list-grammar

- Location: tests/shared/link-cases.ts:4
- Title: Consumer list in link-cases JSDoc has a doubled 'and'
- Problem: tests/shared/link-cases.ts:2-5 | "the shared resolver (...), export's `noteLinkToHtml` (...) and the vault's link rewriting (...) and the editor's image rendering (...) are all asserted against." | The list now reads 'A, B and C and D'. The content is correct, but the doubled 'and' makes the list harder to read. Rewrite it.
- Fix: Turn the list into one series: "the shared resolver (`tests/shared/vault-ids.test.ts`), export's `noteLinkToHtml` (`tests/markdown/render.test.ts`), the vault's link rewriting (`tests/vault/link-updates.test.ts`) and the editor's image rendering (`tests/editor/inline.test.ts`) are all asserted against."
- Fix prompt: In tests/shared/link-cases.ts, edit the top JSDoc so the consumers form one comma-separated list. Replace ' and the vault's link rewriting (`tests/vault/link-updates.test.ts`) and the editor's image' with ', the vault's link rewriting (`tests/vault/link-updates.test.ts`) and the editor's image'. Leave the rest of the comment unchanged.

### issue-22/01: Image src resolution ternary is duplicated in blocks.ts and inline.ts

Run: issue-22
Slice: 01 "Editor images use the shared relative-link rule"
Review: 01-r3

### [observation] react-ts-image-src-resolution-duplicated

- Location: src/editor/render/inline.ts:71
- Title: Image src resolution ternary is duplicated in blocks.ts and inline.ts
- Problem: The rule 'resolve when isRelativeLink, else keep as written' is written out twice: `isRelativeLink(src) ? resolveAssetUrl(src) : src` here and `isRelativeLink(image.url) ? host.resolveAssetUrl(image.url) : image.url` in src/editor/live-preview/blocks.ts:67. blocks.ts already imports linkDestination from this module, so the two editor image paths share the unwrap step but not the resolve step. The ticket's goal is that both editor image paths follow one rule. With two copies, one can change without the other.
- Fix: Export one helper from src/editor/render/inline.ts, for example `imageSrc(rawDestination, resolveAssetUrl)`, that unwraps with linkDestination and then applies the isRelativeLink choice. Use it in renderInlineMarkdown's Image case and in buildPreviewWidgets' Image case.
- Fix prompt: In src/editor/render/inline.ts add an exported function imageSrc(raw: string, resolveAssetUrl: (relPath: string) => string): string that returns `const dest = linkDestination(raw); return isRelativeLink(dest) ? resolveAssetUrl(dest) : dest`. Use it in the Image case of renderInlineMarkdown. In src/editor/live-preview/blocks.ts, replace the inline ternary at the Image case (`isRelativeLink(image.url) ? host.resolveAssetUrl(image.url) : image.url`) with the helper, and drop the isRelativeLink import from blocks.ts if nothing else uses it. parseImage may keep the raw or unwrapped URL, as long as the destination is unwrapped exactly once. Run tests/editor/inline.test.ts and tests/editor/live-preview.test.ts.

### issue-22/01: Angle-bracket unwrap gets a helper in the table renderer while three other copies remain

Run: issue-22
Slice: 01 "Editor images use the shared relative-link rule"
Review: 01-r3

### [observation] thermo-link-destination-owned-by-table-renderer

- Location: src/editor/live-preview/blocks.ts:8
- Title: Angle-bracket unwrap gets a helper in the table renderer while three other copies remain
- Problem: src/editor/live-preview/blocks.ts:8 | The diff adds linkDestination as a named helper for the CommonMark `<...>` destination rule, but puts it in the table-cell renderer (render/inline.ts), so live preview now depends on the renderer for a syntax rule. The same unwrap already exists, written differently, in src/editor/links.ts:14 and src/editor/live-preview/markers.ts:91 (`.replace(/^<(.*)>$/, '$1')`) and by hand in src/vault/links.ts:91-92. A new single source of truth was added next to the old copies instead of replacing them: there are now four copies in two forms, with no clear owner.
- Fix: Make linkDestination the one `<...>` unwrap rule, in a module that owns destination rules (for example src/shared/vault-ids.ts beside isRelativeLink/linkPath), and replace the other copies with it.
- Fix prompt: Move linkDestination out of src/editor/render/inline.ts into a module that owns link-destination rules, such as src/shared/vault-ids.ts (browser-safe, already holds isRelativeLink and linkPath). Import it in src/editor/render/inline.ts and src/editor/live-preview/blocks.ts. Replace the `.replace(/^<(.*)>$/, '$1')` copies in src/editor/links.ts linkAt and src/editor/live-preview/markers.ts (Link case) with it. In src/vault/links.ts rewriteRelativeLinks, use it for `destination` while keeping the local `bracketed` flag for re-encoding. Keep the existing tests passing.

### issue-22/02: [high] tests/editor/inline.test.ts:51: AC3 row `![a]( "t")` → src '' is not met; tests assert the opposite

Run: issue-22
Slice: 02 "Editor link and image destinations agree across table cells and live preview"
Review: 02-r4

### [high] scope-titled-empty-image-destination-not-empty-src

- Location: tests/editor/inline.test.ts:51
- Title: AC3 row `![a]( "t")` → src '' is not met; tests assert the opposite
- Problem: Acceptance criterion 3 says literally: "`![a]( "t")` renders as an image with src ''." There are no commits since 02-r3 (fix diff: none), so the code is unchanged. src/editor/render/inline.ts (Image case) and src/editor/live-preview/blocks.ts parseImage still use the lezer URL node ` "t"` as the destination. tests/editor/inline.test.ts:51-60 and tests/editor/live-preview.test.ts:170-185 assert src 'asset:"t"' and a resolveAssetUrl call with '"t"'. Only decisions 5 and 6 withdraw this row. Both carry the [AUTONOMOUS] marker, so they were recorded by a headless run without the user. Under the review rules they cannot waive or drop the gap, even though decision 6's text claims user confirmation.
- Fix: Either have the user record a real (non-autonomous) decision that withdraws the row, or edit the ticket's criterion 3 wording. Otherwise make `![a]( "t")` render with src '' in both editor paths.
- Fix prompt: Acceptance criterion 3 of slice 02 requires `![a]( "t")` to render as an image with src ''. The code and the tests in tests/editor/inline.test.ts and tests/editor/live-preview.test.ts take the CommonMark destination '"t"' instead. Decisions 5 and 6, which withdraw the row, are marked [AUTONOMOUS] and cannot waive it. Do one of two things. Get the user to confirm the withdrawal through the factory's decision flow, so the decision is recorded without the AUTONOMOUS marker, or change the criterion's wording in the ticket. Otherwise change renderInlineMarkdown's Image case and blocks.ts parseImage so that a URL that is only a quoted title gives src ''. Update both tests to match.

### issue-22/02: Image destination extraction is still written out in both image paths

Run: issue-22
Slice: 02 "Editor link and image destinations agree across table cells and live preview"
Review: 02-r1

### [observation] thermo-image-destination-extraction-written-twice

- Location: src/editor/live-preview/blocks.ts:142
- Title: Image destination extraction is still written out in both image paths
- Problem: src/editor/live-preview/blocks.ts:141-144 and src/editor/render/inline.ts:72-77 | Both image paths now repeat the same steps: `node.getChild('URL')`, then `!url && !isInlineImage(node, slicer)` → not an image, then `url ? linkDestination(slice(url)) : ''`, each with its own copy of the comment. isInlineImage takes a slicer callback only so that both callers can wrap it the same way. The slice made inline.ts the single owner of 'what an image's destination is', but the decision is split into two helpers that every caller has to compose in the same order. A third image path, or a change such as treating `![a]( )` differently, has to be made twice. In parseImage the old `marks.length < 2` guard is now dead too: a URL child or a `(` mark means there are at least three LinkMarks.
- Fix: Replace isInlineImage with one helper that returns the destination, for example `imageDestination(node, slice): string | undefined`. It returns undefined for reference and shortcut images, '' for `![a]()`, and the unwrapped destination otherwise. Both callers then do `const src = imageDestination(...); if (src === undefined) return <text>`. Drop the dead `marks.length < 2` guard in parseImage.
- Fix prompt: In src/editor/render/inline.ts, replace isInlineImage with `export function imageDestination(node: SyntaxNode, slice: (from: number, to: number) => string): string | undefined`. It returns undefined when the node has no URL child and no third LinkMark (reference `![a][ref]` or shortcut `![a]`), '' when there is a `(` mark but no URL (`![a]()`), and linkDestination(slice(url.from, url.to)) otherwise. Use it in renderInlineMarkdown's Image case and in parseImage in src/editor/live-preview/blocks.ts so neither caller looks up the URL child or calls linkDestination itself. Remove parseImage's now-dead `if (marks.length < 2) return undefined`. Existing tests in tests/editor/inline.test.ts and tests/editor/live-preview.test.ts cover the behavior.

### issue-22/02: isInlineImage takes a text-slice callback for a check the tree already answers

Run: issue-22
Slice: 02 "Editor link and image destinations agree across table cells and live preview"
Review: 02-r1

### [observation] thermo-is-inline-image-slice-callback-unneeded

- Location: src/editor/render/inline.ts:23
- Title: isInlineImage takes a text-slice callback for a check the tree already answers
- Problem: src/editor/render/inline.ts:23-26 | isInlineImage needs a `slice` callback only to compare the third LinkMark's text with '('. In @lezer/markdown only the inline `(...)` form emits a third LinkMark: reference and collapsed forms emit a LinkLabel node instead. So `getChildren('LinkMark').length > 2` gives the same answer from the node alone. The callback makes both callers write an adapter lambda (`(from, to) => state.sliceDoc(from, to)` and `(from, to) => text.slice(from, to)`) for a comparison that can never fail.
- Fix: Make it a pure node predicate, `node.getChildren('LinkMark').length > 2`, and drop the slice parameter and the two adapter lambdas. Or fold it into the single destination helper from the related finding.
- Fix prompt: In src/editor/render/inline.ts, change isInlineImage to `(node: SyntaxNode): boolean => node.getChildren('LinkMark').length > 2`, with a JSDoc saying that only the inline `(...)` form has a third LinkMark (reference images carry a LinkLabel). Remove the slice argument at both call sites: renderInlineMarkdown's Image case and parseImage in src/editor/live-preview/blocks.ts. If you take the imageDestination refactor instead, apply the same simplification inside it.

### issue-22/02: Third copy of the recording editorHost setup in live-preview tests

Run: issue-22
Slice: 02 "Editor link and image destinations agree across table cells and live preview"
Review: 02-r1

### [observation] thermo-recording-host-setup-copied-again

- Location: tests/editor/live-preview.test.ts:153
- Title: Third copy of the recording editorHost setup in live-preview tests
- Problem: tests/editor/live-preview.test.ts:153-161 | The new test builds the same recording host, with resolveAssetUrl pushing into `resolved` and returning `asset:${relPath}`, plus the saveAsset and onOpenLink stubs, as the table test at lines 113-121. A third near-copy sits at 131-135. The setup is longer than the behavior it checks, and each new image test copies it again.
- Fix: Extract a small `recordingHost(prefix = 'asset:')` test builder that returns `{ host, resolved }` and use it in the three image tests.
- Fix prompt: In tests/editor/live-preview.test.ts, add a helper near the top: `function recordingHost(prefix = 'asset:') { const resolved: string[] = []; const host = editorHost.of({ resolveAssetUrl: (p) => { resolved.push(p); return prefix + p }, saveAsset: async () => '', onOpenLink: () => {} }); return { host, resolved } }`. Use it in 'unwraps <...> image destinations in table cells…', 'renders images through resolveAssetUrl with alt text and size' (prefix 'boost://app/vault-asset/') and 'renders an empty image destination as an empty src…'. Do not change any assertion.

### issue-22/retro: User-confirmed decision in a resumed headless run is still marked AUTONOMOUS

Run: issue-22
Retro finding (factory, information-access, high)

In run issue-22, the user confirmed decision 5 in chat after `/factory resume`. factory_decide still recorded the confirmation (decision 6) with the [AUTONOMOUS] marker, because the run mode stays headless. The validator then kept scope-titled-empty-image-destination-not-empty-src in reviews 02-r2, 02-r3 and 02-r4, two fix rounds made no commits, and the slice ended as 'accepted unresolved', although the user had waived the row. Fix: after a resume of a paused headless run, factory_decide should record decisions that the user confirms without the AUTONOMOUS marker (or offer a confirm dialog), or the run should switch to interactive when the user resumes it.

### issue-22/retro: Check acceptance examples against the real parser before planning

Run: issue-22
Retro finding (factory, coding-standards, medium)

The orchestrator wrote the slice 02 acceptance row `![a]( "t")` → src '' from a reviewer's fix prompt without checking the syntax. Under CommonMark, ` "t"` is the destination. The implementer proved this with lezer and markdown-it, but only after it built the slice. The row cost 1 pause, 3 fix rounds and 4 reviews. Fix: in the planning and follow-up steps, tell the orchestrator to check every input/output example in an acceptance criterion against the parser or the function it names (one throwaway eval) before factory_plan or factory_follow_up.

### issue-22/retro: Find and fix the flaky vitest test in pnpm run test

Run: issue-22
Retro finding (repo, automated-checks, medium)

`pnpm run test` failed one time and passed on the rerun in slice 02 of this run (46s, exit 1), and also in slice 05 of issue-22-md-case. factory_checks marks the run flaky but does not name the test in a way that persists. Fix: find the flaky vitest file (run `pnpm run test --repeat` or `vitest --sequence.shuffle` a few times) and fix or quarantine it, so that the checks become deterministic.

### issue-22/retro: One owner for the `<...>` link-destination rule

Run: issue-22
Retro finding (repo, coding-standards, low)

The CommonMark `<...>` destination unwrap is written four times: src/editor/render/inline.ts linkDestination, src/editor/links.ts:14, src/editor/live-preview/markers.ts:91 and src/vault/links.ts:92. The reviewers had to find this by hand (01-r3, deferred). Fix: move linkDestination into src/shared/vault-ids.ts beside linkPath and isRelativeLink, use it in all four places, and add one line to CODING_STANDARDS.md: link-destination and link-path rules live in src/shared/vault-ids.ts only.

## issue-17-18 (slice 04)

### bug-title-rename-both-twins-numbered-plain-name-unused

- Location: `src/vault/vault.ts:495` (`planTitleRenames`)
- Title: When both extension-case twins are title-renamed, neither gets the plain name ("Hello 2" and "Hello 3", no "Hello")
- Problem: Take `work/hello.md` and `work/hello.MD` on a case-sensitive disk, both titled `Hello`, so both are slug-named. Each finds a name-key count of 2, so `own` is undefined for both. The first planned gets `Hello 2.MD` (the plain `Hello` is taken by both existing entries), and the second gets `Hello 3.md`. Once the first rename is applied, the second note's case-only rename to `Hello.md` would be free, so the plan numbers both notes and leaves the plain name unused. The apply succeeds, so nothing breaks, but the user ends up with `Hello 2` and `Hello 3` and no `Hello`. Raised in review 04-r3 of issue-22-md-case (deferred there); the user put it out of scope for issue #17.
- Suggested fix: In `planTitleRenames`, count the earlier picks of the same plan: once a twin has been planned away from the shared name key, the next twin may take the plain name. Add a `pnpm test:case-sensitive` test with two twins titled the same.

## issue-75/01: Doc comments on MenuWebContents and MenuSession restate their Pick declarations

Run: issue-75
Slice: 01 "Native spelling and edit context menu for editable fields"
Review: 01-r1
Reviewed commit: ab2fc2550ef80ac31d2937235e1450583d95c4a4

### [observation] comments-narrow-type-docs-restate-pick

- Symbol: MenuWebContents
- Location at filing time: src/main/context-menu.ts:5
- Title: Doc comments on MenuWebContents and MenuSession restate their Pick declarations
- Problem: src/main/context-menu.ts:5 and :9 | "/** The parts of `webContents` the menu uses. */" and "/** The parts of `session` the menu uses. */" | delete | The Pick<WebContents, 'replaceMisspelling'> and Pick<Session, 'isSpellCheckerEnabled' | 'addWordToSpellCheckerDictionary'> declarations already say exactly which parts are used; the comments add no reason, constraint or contract beyond the type.
- Fix: Delete both one-line doc comments, or rewrite them to state the non-obvious why (for example: narrowed so tests can pass a fake EventEmitter and session instead of real Electron objects).
- Fix prompt: In src/main/context-menu.ts, delete the doc comments `/** The parts of `webContents` the menu uses. */` above `MenuWebContents` and `/** The parts of `session` the menu uses. */` above `MenuSession`, since the Pick types already state the same thing. Alternatively, replace them with one comment that explains why the types are narrowed (so tests can pass fakes instead of real Electron objects).

## issue-75/02: Spelling test threads poll state through a mutable outer variable and a try/catch skip

Run: issue-75
Slice: 02 "Editor spelling replacement saves and undoes (end-to-end)"
Review: 02-r1
Reviewed commit: d50b197a4a35648904e89e6e1bc414c2da10d9c6

### [observation] thermo-spelling-poll-leaks-state-through-mutable-first

- Symbol: a spelling suggestion from the native menu replaces the word, is saved and undoes
- Location at filing time: tests/e2e/spelling.spec.ts:44
- Title: Spelling test threads poll state through a mutable outer variable and a try/catch skip
- Problem: The poll callback writes `first` (reset to undefined, then set), the catch block reads it to decide whether to skip, and after the poll the code re-checks `first` for undefined/'No suggestions'. Three places interpret one mutable value, and the 'no spelling items' case is inferred from the magic label 'Cut' (Electron's role label for the first edit item). It works, but the control flow is hard to follow and the sentinel silently depends on the EDIT item order in src/main/context-menu.ts.
- Fix: Extract a small helper, e.g. `rightClickUntilSpellingMenu(page, menus, point): Promise<string[] | 'no-spelling'>`, that polls until the last popped menu either leads with a non-edit item or the timeout passes, and returns the last seen labels. The test then does one branch: skip off macOS when the result has no spelling item, fail on 'No suggestions', otherwise use labels[0].
- Fix prompt: In tests/e2e/spelling.spec.ts, replace the mutable `first` variable shared between the expect.poll callback, the catch block and the post-poll checks with a helper that right-clicks the word until a menu pops up whose first item is not an edit role item, and returns the last seen menu labels (or a marker when only edit-item menus were seen before the timeout). Make the test branch once on that result: test.skip off darwin with the platform-naming reason when no spelling item was seen, throw on 'No suggestions', otherwise click labels[0]. Keep the behaviour and reason text unchanged.

## issue-75/03: Install test still passes when installEditContextMenu hard-codes the test's own params

Run: issue-75
Slice: 03 "Tighten context-menu install and spelling-skip tests"
Review: 03-r3
Reviewed commit: d0061820c12f320ca034ee9a492c6be2e6dfd0e4

### [observation] test-validity-install-test-passes-with-hardcoded-teh-params

- Symbol: pops up the built menu on the window for an editable target
- Location at filing time: tests/main/context-menu.test.ts:97
- Title: Install test still passes when installEditContextMenu hard-codes the test's own params
- Problem: tests/main/context-menu.test.ts | 'pops up the built menu on the window for an editable target' | The test emits one payload, { misspelledWord: 'teh', dictionarySuggestions: ['the'] }, and asserts the labels and click that this payload produces. If installEditContextMenu ignored the event and called buildEditContextMenu({ misspelledWord: 'teh', dictionarySuggestions: ['the'] }, webContents, session), the labels would still be ['the', 'Add to Dictionary'] and the click would still call replaceMisspelling('the'), so the test passes. The acceptance criterion, read literally, says: "fails if `installEditContextMenu` passes empty or fixed params ... to the builder". This one fixed value gets through. Escaping bug: params forwarding replaced by a constant (for example a debugging leftover) would not be caught.
- Fix: Keep the prescribed 'teh'/'the' assertions, and add a second context-menu event in the same test (or a second test) with a different payload, for example { isEditable: true, misspelledWord: 'wrod', dictionarySuggestions: ['word', 'wood'] }. Assert that its template starts with 'word', 'wood', 'Add to Dictionary', and that clicking 'word' calls replaceMisspelling with 'word'. No fixed payload can then satisfy both events.
- Fix prompt: In tests/main/context-menu.test.ts, in 'pops up the built menu on the window for an editable target', keep the existing 'teh' -> ['the'] emit and its assertions on labels, click->replaceMisspelling('the') and popup({ window }). Then clear the mocks (buildFromTemplate.mockClear(), popup.mockClear(), webContents.replaceMisspelling.mockClear()), or use mock.calls[1], and emit a second event { isEditable: true, misspelledWord: 'wrod', dictionarySuggestions: ['word', 'wood'] }. Assert that the second template's labels start with ['word', 'wood', 'Add to Dictionary'] and that clicking its first item calls replaceMisspelling exactly once with 'word'. A hard-coded params object in installEditContextMenu would then fail one of the two events.

## issue-75/retro: No local way to run the e2e suite off macOS

Run: issue-75
Retro finding (repo, information-access, high)

The off-macOS skip and fail branches of tests/e2e/spelling.spec.ts never ran in this run: every implementer worked on macOS, and the repo has no way to run the Playwright e2e suite on Linux locally (`pnpm test:linux` runs only the Vitest paths). Three review rounds (02-r1, 02-r3, 03-r1) found bugs in that skip logic that no run could show. Add e2e support to scripts/test-linux.sh (Docker with Electron, xvfb and a hunspell dictionary), or name in AGENTS.md the CI job that runs e2e on Linux.

## issue-75/retro: AGENTS.md smoke pointer implies an interactive session

Run: issue-75
Retro finding (repo, navigation, medium)

AGENTS.md says to smoke-run the real app with `pnpm smoke`, but scripts/smoke.ts closes the app at once when neither `--steps` nor `--shot` is given. The slice 02 implementer wrote a manual check in docs/modernisation/PLAN.md around that command, and review 02-r1 blocked it. State in the AGENTS.md smoke line that `pnpm smoke` is scripted (needs `--steps` or `--shot`) and is not an interactive session, or add an interactive flag to scripts/smoke.ts.

## issue-75/retro: Validator gets advisor notes about scope fix-item verdicts

Run: issue-75
Retro finding (factory, no-ops, medium)

In targeted reviews 02-r2, 02-r4 and 03-r2 the validator got an advisor note asking it to give verdicts on the fix items, which is the scope reviewer's job through factory_review_submit. Each validator spent a turn refusing the note. Fix the advisor or gate text so it addresses the scope reviewer, not the validator.

## issue-75/retro: Platform-only behaviors get no follow-up after seenRed false

Run: issue-75
Retro finding (factory, automated-checks, low)

For a behavior that runs only on another platform (the off-macOS skip in the spelling e2e test), the implementer cannot see a test fail first, so fix rounds 02-f2 and slice 03 reported seenRed false with an Open note. The factory accepted it, but nothing marks such behaviors for a later run on that platform. Consider a report field for platform-bound behaviors that lists them in the PR body for a manual or CI check.

## issue-75/02: [high] Manual spelling check command uses `$(mktemp -d)`, which PowerShell and cmd cannot run, though the doc sends Windows users to it

Run: issue-75
Slice: 02 "Editor spelling replacement saves and undoes (end-to-end)"
Review: 02-r6
Reviewed commit: 14268b59c4ffdf3931a84f49ec09c3ea9de0271d

### [high] holistic-manual-spelling-check-command-fails-on-windows-shells

- Location at filing time: docs/modernisation/PLAN.md:542
- Title: Manual spelling check command uses `$(mktemp -d)`, which PowerShell and cmd cannot run, though the doc sends Windows users to it
- Problem: PLAN.md says the manual check applies where Chromium marks no word, naming "Windows or Linux without one", and then gives `pnpm dev --user-data-dir="$(mktemp -d)"` as the command. `mktemp` is a POSIX tool. In PowerShell `$(mktemp -d)` fails with "mktemp is not recognized", and cmd does not expand `$(...)` at all, so it passes the literal text as the profile path. A Windows developer following the documented fallback either cannot start the app or gets a profile folder literally named `$(mktemp -d)` inside the repo instead of a fresh temp one. The repo treats Windows as a supported dev and CI platform: ci.yml runs windows-latest, and src/cli/install.ts `windowsCommands` gives separate PowerShell and cmd commands. The fallback this slice's acceptance criterion requires therefore cannot be followed as written on one of the two platforms it names.
- Fix: Keep the POSIX command for macOS and Linux, and add a Windows form that makes a fresh temp profile, for example PowerShell: `pnpm dev --user-data-dir="$(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid())))"`, or tell the reader to make an empty folder and pass its path.
- Fix prompt: In docs/modernisation/PLAN.md, "End-to-end tests" section, the manual spelling check currently says `pnpm dev --user-data-dir="$(mktemp -d)"`. That command only works in a POSIX shell, but the paragraph sends Windows users to this check. Keep the POSIX command for macOS and Linux shells, and add the Windows PowerShell equivalent that creates a fresh empty temp folder and passes it as the profile, for example `pnpm dev --user-data-dir="$(New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid())))"`. Alternatively, tell the reader to create an empty temp folder and pass its path to `--user-data-dir`. Keep the rest of the manual steps unchanged: the fresh profile keeps your own settings and vaults out of it, open a scratch copy of tests/fixtures/sample-vault, type a misspelled word followed by a space, right-click it, choose a suggestion, check the file on disk, press Ctrl+Z.

## issue-75/03: Skip branch reads main-process state in two sequential evaluate calls

Run: issue-75
Slice: 03 "Tighten context-menu install and spelling-skip tests"
Review: 03-r4
Reviewed commit: eb5f21164ea636cda8324e15fce97ceccc816645

### [observation] thermo-skip-reads-main-state-in-two-round-trips

- Symbol: a spelling suggestion from the native menu replaces the word, is saved and undoes
- Location at filing time: tests/e2e/spelling.spec.ts:73
- Title: Skip branch reads main-process state in two sequential evaluate calls
- Problem: tests/e2e/spelling.spec.ts:72-73 | The catch block makes two independent electronApp.evaluate round trips in sequence (recorded misspelledWords, then isSpellCheckerEnabled) to feed one skip decision. Both read the same main-process state at the same moment; splitting them adds a round trip and spreads one decision's inputs over two calls.
- Fix: Read both values in one evaluate that returns { reported, spellcheck }, then build the skip predicate from that object.
- Fix prompt: In tests/e2e/spelling.spec.ts, in the catch block of 'a spelling suggestion from the native menu replaces the word, is saved and undoes', replace the two electronApp.evaluate calls with one: `const { reported, spellcheck } = await electronApp.evaluate(({ session }) => ({ reported: (globalThis as SpellingCapture).misspelledWords ?? [], spellcheck: session.defaultSession.isSpellCheckerEnabled() }))`. Keep the test.skip predicate and reason unchanged.

## issue-75/retro: No local way to run the e2e suite off macOS

Run: issue-75
Retro finding (repo, information-access, high)

The off-macOS skip and fail branches of tests/e2e/spelling.spec.ts never ran in this run: every implementer worked on macOS, and the repo has no way to run the Playwright e2e suite on Linux locally (`pnpm test:linux` runs only the Vitest paths). Review rounds 02-r1, 02-r3, 03-r1 and 03-r4 found or suspected bugs in that skip logic that no run could show. Add e2e support to scripts/test-linux.sh (Docker with Electron, xvfb and a hunspell dictionary), or name in AGENTS.md the CI job that runs e2e on Linux.

## issue-75/retro: No safe, cross-platform command for an interactive app session

Run: issue-75
Retro finding (repo, navigation, high)

Docs that tell a developer to run the app by hand (the manual spelling check in docs/modernisation/PLAN.md) first used `pnpm smoke`, which closes the app at once without `--steps` or `--shot`, then `pnpm dev` on the default profile, which reopens the developer's own vaults (src/main/vault-session.ts). Slice 02 was reopened for it, and the fix (`--user-data-dir="$(mktemp -d)"`) still fails in PowerShell and cmd (accepted unresolved in 02-r6). Add one cross-platform command for an interactive session on a temp profile with a vault copy (for example an `--interactive` flag on scripts/smoke.ts), and point AGENTS.md and the docs at it.

## issue-75/retro: Validator gets advisor notes about scope fix-item verdicts

Run: issue-75
Retro finding (factory, no-ops, medium)

In targeted reviews 02-r2, 02-r4 and 03-r2 the validator got an advisor note asking it to give verdicts on the fix items, which is the scope reviewer's job through factory_review_submit. Each validator spent a turn refusing the note. Address that note to the scope reviewer, not the validator.

## issue-75/retro: Reviewers missed a doc step that breaks an AGENTS.md rule

Run: issue-75
Retro finding (factory, automated-checks, medium)

No reviewer of slice 02 r1 to r5 saw that the manual check it documented would start the app on the user's real profile, against the repo rule in AGENTS.md (never point the app at the user's own vault). Only an outside review found it after hand-over. Give the bug or holistic reviewer the repo's AGENTS.md rules as a checklist for doc steps that run the app.

## issue-75/retro: Platform-only behaviors get no follow-up after seenRed false

Run: issue-75
Retro finding (factory, automated-checks, low)

For a behavior that runs only on another platform (the off-macOS skip in the spelling e2e test), the implementer cannot see a test fail first, so fix round 02-f2 and slice 03 reported seenRed false with an Open note. Nothing marks such behaviors for a later run on that platform. Consider a report field for platform-bound behaviors that lists them in the PR body for a manual or CI check.

## issue-73/02: --table-max-width rule lives as a nested ternary inside the render closure

Run: issue-73
Slice: 02 "Table width preference and wider tables in the reader pane"
Review: 02-r1
Reviewed commit: 839f8efda42ba1c8132ae8df950e3d486a273c99

### [observation] thermo-table-max-width-rule-inline-in-render

- Symbol: Workspace
- Location at filing time: src/app/actions/public/workspace/workspace.tsx:237
- Title: --table-max-width rule lives as a nested ternary inside the render closure
- Problem: The rule 'none when lineWidth is 0 or tableWidth is full, else the larger of px and line width' (decision 2) is written inline in the Workspace render's css() variables. It is the only place the rule exists, so its four cases can only be proven through Playwright (tests/e2e/reader-tables.spec.ts), and slice 03 will need the same value for live-preview tables.
- Fix: Extract a small pure helper, e.g. `tableMaxWidth(lineWidth, tableWidth): string`, next to the UiPreferences types and use it in Workspace; a unit test can then cover the four cases cheaply.
- Fix prompt: In src/app/actions/public/workspace/workspace.tsx, move the `--table-max-width` ternary into a named pure function `tableMaxWidth(lineWidth: number, tableWidth: TableWidthPreference): string` (placed beside the other UI preference helpers) and call it from the css() variables. Optionally add a unit test for line/full/px-below-line/px-above-line/lineWidth 0.

## issue-73/02: openInReader doc restates the helper

Run: issue-73
Slice: 02 "Table width preference and wider tables in the reader pane"
Review: 02-r1
Reviewed commit: 839f8efda42ba1c8132ae8df950e3d486a273c99

### [observation] comments-open-in-reader-doc-restates-code

- Symbol: openInReader
- Location at filing time: tests/e2e/reader-tables.spec.ts:23
- Title: openInReader doc restates the helper
- Problem: tests/e2e/reader-tables.spec.ts:23 | `/** Opens the note in the reader and returns the reader's body. */` | Restates the function name and its three-line body (openLooseFile, locate `[data-reader-body]`, return it); adds nothing the code does not show.
- Fix: Delete the JSDoc; the name `openInReader` and the `Promise<Locator>` return type already say it.
- Fix prompt: In tests/e2e/reader-tables.spec.ts, delete the comment `/** Opens the note in the reader and returns the reader's body. */` above `openInReader`.

## issue-73/03: One chained test covers four criteria, decision 4, the px width and the click

Run: issue-73
Slice: 03 "Live-preview tables grow to the table width"
Review: 03-r1
Reviewed commit: 3b91e7ce5ddee735cddb98f358ea18f0cc53010c

### [observation] test-validity-single-chained-test-masks-later-criteria

- Symbol: lets live-preview tables grow from the text column to the pane while prose keeps the line width
- Location at filing time: tests/e2e/live-preview-tables.spec.ts:88
- Title: One chained test covers four criteria, decision 4, the px width and the click
- Problem: tests/e2e/live-preview-tables.spec.ts:88 | lets live-preview tables grow… | The default-width, full-width, narrow-table, list-table, too-wide scroll, 700px and click-to-source checks all run in one test, each starting from the state the previous step left. The name describes only the growth case. A failure in an early step (for example the full-width poll) hides whether the narrow, list, scroll, px and click behaviours still hold, and the failure title does not say which behaviour broke.
- Fix: Split it into focused tests that share the fixture: default width keeps tables in the column; full width grows wide tables, centred, while prose and narrow tables keep their box; a nested list table keeps the column; a too-wide table scrolls and a click reveals its source; a px width caps the table. Set `tableWidth` through the `ui` fixture where the dialog path is not the behaviour under test.
- Fix prompt: In tests/e2e/live-preview-tables.spec.ts, split the 'lets live-preview tables grow…' test into separate tests inside the 'the table width' describe, one per behaviour (default width, full-width growth with prose and narrow tables unchanged, list-nested table, too-wide scroll plus click-to-source, 700px cap). Each test should set its `tableWidth` through `test.use({ ui: … })`, or through the dialog once, rather than relying on the previous step's state.

## issue-73/03: --lp-line-width re-derives the .cm-content max-width rule

Run: issue-73
Slice: 03 "Live-preview tables grow to the table width"
Review: 03-r1
Reviewed commit: 3b91e7ce5ddee735cddb98f358ea18f0cc53010c

### [observation] thermo-lp-line-width-duplicates-content-max-width

- Symbol: baseTheme
- Location at filing time: src/editor/theme.ts:173
- Title: --lp-line-width re-derives the .cm-content max-width rule
- Problem: `.cm-lp-table`'s `--lp-line-width` restates the text column's width rule (the `46rem` default, `none` meaning the pane) that `.cm-content` already holds in `maxWidth: 'var(--editor-max-width, 46rem)'`. The table's `maxWidth: calc(100% + var(--lp-table-width) - var(--lp-line-width))` only works while these two match exactly, because it relies on `100%` being `--lp-line-width` minus the content padding. If someone changes the content default or the `none` handling in one place and not the other, tables are capped at the wrong width and no error shows.
- Fix: Define the line width once, for example `--lp-line-width` on `.cm-scroller`, and use it in both `.cm-content` maxWidth and the table rule, so the default and the `none` handling exist in one place.
- Fix prompt: In src/editor/theme.ts, move the `--lp-line-width` definition (`if(style(--editor-max-width: none): 100cqw; else: min(var(--editor-max-width, 46rem), 100cqw))`) to one rule that is an ancestor of both `.cm-content` and `.cm-lp-table` and sits inside the size container. Note that `cqw` needs a container ancestor, so either define it on `.cm-content` or keep the `46rem` default in a single custom property that both rules read. Then make `.cm-content` maxWidth and the `.cm-lp-table` maxWidth calc both read that one source, so the 46rem default and the `none` case live in one place. Keep tests/e2e/live-preview-tables.spec.ts green.

## issue-73/03: Section comments in the table-width test restate the assertions below them

Run: issue-73
Slice: 03 "Live-preview tables grow to the table width"
Review: 03-r1
Reviewed commit: 3b91e7ce5ddee735cddb98f358ea18f0cc53010c

### [observation] comments-table-width-test-section-comments-restate-assertions

- Symbol: lets live-preview tables grow from the text column to the pane while prose keeps the line width
- Location at filing time: tests/e2e/live-preview-tables.spec.ts:115
- Title: Section comments in the table-width test restate the assertions below them
- Problem: tests/e2e/live-preview-tables.spec.ts:101, 115, 120, 127, 134, 139, 144, 156 | e.g. `// Prose keeps the line width.` above `toHaveCSS('max-width', '600px')`, `// The pane itself never scrolls sideways.` above `scrollWidth <= clientWidth`, `// A pixel table width caps tables at that width.` above the 700px poll | Each comment repeats what the next one to four assertions already say. Line 101 also adds change narration ('as before') and says 'every table' while only the wide table is checked. Line 131 is the exception: it explains why the vertical position is left out, so keep it.
- Fix: Delete the restating comments at lines 101, 115, 120, 127, 134, 139, 144 and 156, keeping line 131. If labels are wanted, split the test into test.step calls with names, or name the measured boxes (e.g. `withinPane(wideAfter)`) so the assertions read for themselves.
- Fix prompt: In tests/e2e/live-preview-tables.spec.ts, in the test 'lets live-preview tables grow from the text column to the pane while prose keeps the line width', delete the section comments at lines 101, 115, 120, 127, 134, 139, 144 and 156, which restate the assertions that follow them. Keep the comment at line 131, which explains why only the horizontal extent is compared. If section labels are still wanted, wrap each group in `await test.step('<label>', async () => { ... })` instead of a comment.

## issue-73/04: Blockquote-table width check compares one .cm-line with another, so it is always true

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r1
Reviewed commit: 4148d9d1c0c38a8f75e8a5a6e03a0fbb88bb9c3a

### [observation] testing-blockquote-line-width-assertion-always-true

- Symbol: lets live-preview tables grow from the text column to the pane while prose keeps the line width
- Location at filing time: tests/e2e/live-preview-tables.spec.ts:164
- Title: Blockquote-table width check compares one .cm-line with another, so it is always true
- Problem: `inQuote` is a `.cm-line` and `column` is the box of another `.cm-line` (the paragraph). Every `.cm-line` is a block child of `.cm-content`, so its box always spans exactly the text column whatever the table width setting does; the two `inQuoteBox` assertions cannot fail. Decision 10 accepts asserting on the quoted source lines, and the regression it guards (a blockquote table turning into a growing widget) is still caught, but only indirectly by `toHaveCount(4)` and by `inQuote` no longer resolving, not by the width check the comment describes.
- Fix: Make the blockquote check say what actually protects decision 4/10: assert the quoted table stays as source (for example the `.cm-line` containing '> | Quoted | Table |' is visible and the widget count stays 4), or measure the quoted line's text extent with a Range instead of the line's block box.
- Fix prompt: In tests/e2e/live-preview-tables.spec.ts, in 'lets live-preview tables grow from the text column to the pane while prose keeps the line width', replace or supplement the two `inQuoteBox` assertions: assert `await expect(editor.locator('.cm-line', { hasText: '> | Quoted | Table |' })).toBeVisible()` after switching to 'full' (the quote stays as source lines, decision 10) and keep `toHaveCount(4)` as the guard that no widget is drawn for it. If a width check is kept, measure the text extent of the quoted line with a DOM Range's getBoundingClientRect rather than the `.cm-line` box, which always equals the column.

## issue-73/04: Reader centring is checked on a table that fills the article, so the check passes whether or not the table is centred

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r1
Reviewed commit: 4148d9d1c0c38a8f75e8a5a6e03a0fbb88bb9c3a

### [observation] test-validity-reader-centring-checked-on-pane-filling-table

- Symbol: lets a wide top-level table grow to the pane while prose keeps the line width
- Location at filing time: tests/e2e/reader-tables.spec.ts:65
- Title: Reader centring is checked on a table that fills the article, so the check passes whether or not the table is centred
- Problem: tests/e2e/reader-tables.spec.ts:65 | a full table width › lets a wide top-level table grow to the pane while prose keeps the line width | At tableWidth 'full', `& > table` has `max-width: none` and auto width. The wide 5-column table's max-content (four ~100-character sentences) is far wider than the reader, so shrink-to-fit makes it exactly as wide as the article's content box. The test confirms this with `scrollWidth <= clientWidth`. A table that fills its container has no free space for its auto margins to share, so its centre is the content-box centre with `margin: auto` and with `margin: 0`. The paragraph's centre is also the content-box centre, so the 1px check holds whatever the table's horizontal margins are. Escaping bug: a table-only rule that drops the auto margins (for example `'& table': { borderCollapse: 'collapse', margin: 0 }`) left-aligns every table whose natural width is between the line width and the pane width, or that is capped at a px width below the pane width. That breaks decision 3 ('stays centred on the text column'), and the test stays green. The narrow-table check in the dialog test does not catch it either, because it compares the narrow table only with itself before and after the change.
- Fix: Check centring on a table that leaves free space on both sides. Either assert that the narrow two-column table's centre equals the paragraph centre within 1px, or check the wide table's centre in a px-width case after first asserting that the table is narrower than the article's content box. Keep the existing assertion if you like, but do not rely on it alone.
- Fix prompt: In tests/e2e/reader-tables.spec.ts, in 'a full table width › lets a wide top-level table grow to the pane while prose keeps the line width', add a centring check that can fail: get the narrow table's box with `reader.locator('> table').nth(1).boundingBox()` and assert `Math.abs(narrowBox.x + narrowBox.width / 2 - (paragraphBox.x + paragraphBox.width / 2)) <= 1`. Alternatively, in the dialog test after the table width is set to 900, assert that the wide table's width is less than the reader's clientWidth minus its horizontal padding, then assert that its centre equals the `> p` centre within 1px. Check that the new assertion fails when you temporarily add `margin: 0` to the `'& table'` rule in src/app/actions/public/workspace/reader-pane.tsx.

## issue-73/04: Reader spec re-implements the `box`/`across` helpers of the live-preview spec

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r1
Reviewed commit: 4148d9d1c0c38a8f75e8a5a6e03a0fbb88bb9c3a

### [observation] thermo-reader-horizontal-helper-duplicates-across-and-box

- Symbol: the preferences dialog sets the table width and the reader follows without a reload
- Location at filing time: tests/e2e/reader-tables.spec.ts:93
- Title: Reader spec re-implements the `box`/`across` helpers of the live-preview spec
- Problem: tests/e2e/reader-tables.spec.ts:93 and :63 | The new `horizontal` closure returns `{ x, width, height }` of a bounding box, which is exactly what `across` in tests/e2e/live-preview-tables.spec.ts does, and the centring check inlines `boundingBox()` + `if (!a || !b) throw new Error('not visible')`, which is `box`. The two specs now carry two versions of the same measurement helpers with different names (`horizontal` vs `across`) and different null handling (`horizontal` returns null, `box` throws). The name `horizontal` is also wrong: it includes `height`.
- Fix: Move `box` and `across` into tests/e2e/fixtures.ts (or a small shared helper module) and use them in both specs; drop `horizontal` and the inline boundingBox/throw.
- Fix prompt: Move the `box` and `across` helpers from tests/e2e/live-preview-tables.spec.ts into tests/e2e/fixtures.ts and export them. In tests/e2e/reader-tables.spec.ts replace the `horizontal` closure with `across(narrow)` and replace the inline `boundingBox()` + throw in the centring check with `await box(table)` / `await box(reader.locator('> p'))`. Import them in both specs.

## issue-73/04: The 8-column too-wide table fixture and its scroll assertions are written twice

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r1
Reviewed commit: 4148d9d1c0c38a8f75e8a5a6e03a0fbb88bb9c3a

### [observation] thermo-too-wide-table-fixture-and-assertions-duplicated

- Symbol: a too-wide live-preview table scrolls inside its widget within the pane
- Location at filing time: tests/e2e/live-preview-tables.spec.ts:201
- Title: The 8-column too-wide table fixture and its scroll assertions are written twice
- Problem: tests/e2e/live-preview-tables.spec.ts:201 | The new lineWidth-0 describe rebuilds the same 8-column table (`Array(8).fill('Wide')`, `Array(8).fill('---')`, `Array(8).fill('y'.repeat(60))`) that the 'the table width' fixture already builds with `cell`, and repeats the same 'within the pane / scrollWidth > clientWidth' assertions. The overflow-x check sits in one copy and the wheel check in the other, so the two halves of 'the user can scroll it' live in different tests and will drift when the fixture or the widget changes.
- Fix: Extract a `tooWideTable` constant (or `wideTableRows(cell)`) at module scope and use it in both fixtures; put the scrollability checks (overflow-x auto|scroll, scrollWidth > clientWidth, wheel increases scrollLeft) in one `expectScrollsInside(widget, pane)` helper called from both tests where possible.
- Fix prompt: In tests/e2e/live-preview-tables.spec.ts, add a module-level `const tooWideTable = [ `| ${Array(8).fill('Wide').join(' | ')} |`, `| ${Array(8).fill('---').join(' | ')} |`, `| ${Array(8).fill('y'.repeat(60)).join(' | ')} |` ]` and spread it into both the widths.md and wide.md fixtures. Add a helper that asserts a widget lies within the pane, has scrollWidth > clientWidth and computed overflow-x auto|scroll, and use it in both the chained test and the lineWidth-0 test (keep the wheel check in the lineWidth-0 test per decision 11).

## issue-73/04: New live-preview test comments restate the steps below them

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r3
Reviewed commit: e7adbbc8b1678c58f718347b47dfea40147b6b8c

### [observation] comments-live-preview-new-comments-restate-assertions

- Symbol: a too-wide live-preview table scrolls inside its widget within the pane
- Location at filing time: tests/e2e/live-preview-tables.spec.ts:224
- Title: New live-preview test comments restate the steps below them
- Problem: tests/e2e/live-preview-tables.spec.ts:224 `// A user scrolls it with a horizontal wheel.` sits above `widget.hover(); page.mouse.wheel(200, 0)`, and :163 `// So does a table in a blockquote.` sits above the inQuoteBox column assertions. Both repeat what the next lines do and give no reason. The useful reason (a script that sets scrollLeft also works under overflow-x: hidden, so only a real wheel proves the user can scroll) is not stated.
- Fix: Delete :163. Delete :224, or rewrite it to give the reason: `// A real wheel, not a scripted scrollLeft: scrollLeft can be set even under overflow-x: hidden.`
- Fix prompt: In tests/e2e/live-preview-tables.spec.ts, delete the comment `// So does a table in a blockquote.` (line 163). Replace `// A user scrolls it with a horizontal wheel.` (line 224) with `// A real wheel, not a scripted scrollLeft: scrollLeft can be set even under overflow-x: hidden.` or delete it.

## issue-73/04: New reader test comments restate the assertions below them

Run: issue-73
Slice: 04 "Harden table-width tests"
Review: 04-r3
Reviewed commit: e7adbbc8b1678c58f718347b47dfea40147b6b8c

### [observation] comments-reader-new-comments-restate-assertions

- Symbol: lets a wide top-level table grow to the pane while prose keeps the line width
- Location at filing time: tests/e2e/reader-tables.spec.ts:62
- Title: New reader test comments restate the assertions below them
- Problem: tests/e2e/reader-tables.spec.ts:62 `// The wide table stays centred on the text column.` sits above the centre-difference <= 1 assertion, and :103 `// A narrow table keeps its natural box.` sits above `expect(await narrow.boundingBox()).toEqual(narrowBefore)`. Each one repeats what its assertion already says and gives no reason the code cannot show.
- Fix: Delete both comments, or name the comparison in code instead, for example a `centreX(box)` helper so the assertion reads as centring.
- Fix prompt: In tests/e2e/reader-tables.spec.ts, delete the comments `// The wide table stays centred on the text column.` (line 62) and `// A narrow table keeps its natural box.` (line 103). If the centring arithmetic needs a label, extract a `centreX = (b) => b.x + b.width / 2` helper and compare `centreX(tableBox)` with `centreX(paragraphBox)`.

## issue-73/retro: E2E layout tests were weak in the first pass

Run: issue-73
Retro finding (repo, coding-standards, medium)

Reviews of slices 01-03 kept 7 missing-test or test-validity observations (asserting on the inner table instead of the widget, scrollWidth instead of real scrolling, one chained e2e test for many behaviours, centring checked on a pane-filling table). They needed a whole follow-up slice. Add a short e2e testing section to the repo's coding standards or a test-writing doc: one behaviour per Playwright test, measure the element the user sees, prove scrolling with a real wheel, and check layout on cases that leave free space.

## issue-73/retro: Document which nested blocks the live preview renders as widgets

Run: issue-73
Retro finding (repo, navigation, medium)

The live preview draws no table widget for a table inside a blockquote (blocks.ts skips lines after a quote marker). The orchestrator did not know this and wrote an acceptance criterion for slice 04 that a test-only slice could not meet. Add a line on which Markdown blocks become live-preview widgets (and where nested blocks are skipped) to the live-preview section of docs/modernisation/PLAN.md.

## issue-73/retro: Possible lost wheel events after closing the preferences dialog

Run: issue-73
Retro finding (repo, information-access, medium)

In slice 04 the implementer saw that after the preferences dialog is opened and closed with Escape, no wheel events reach the page in the e2e window. It was not investigated (recorded as out of scope). It may be a real app bug (an overlay or pointer-events left behind). File it as an app issue so someone reproduces it.

## issue-73/retro: Implementers keep writing comments that restate assertions in tests

Run: issue-73
Retro finding (factory, coding-standards, low)

Comments reviewers kept 5 observations about test comments that restate the next assertion, across slices 02-04. Implementers keep writing them. A line in the implementer guidance (no section comments in tests that only restate assertions; use test.step names instead) would stop the repeat.
