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

## issue-78

### issue-78/01: renameNote re-encodes the note-extension rule in its own regex

Run: issue-78
Slice: 01 "One note-extension rule: .mdx files are notes"
Review: 01-r1
Reviewed commit: ceb4b9a690fdaf14f3eec4f26873448a99443698

### [observation] thermo-rename-guard-duplicates-note-extension-rule

- Symbol: Vault.renameNote
- Location at filing time: src/vault/vault.ts:447
- Title: renameNote re-encodes the note-extension rule in its own regex
- Problem: The slice's goal is to define the note extensions once in src/shared/vault-ids.ts (NOTE_EXTENSION). renameNote keeps a second, hand-written copy of the same policy, /^\.(?:[mM][dD]|mdx)$/, to refuse a name that is only an extension. A regex search of src shows this and NOTE_EXTENSION are the only two encodings of the rule (argv, VaultSession, resolveNoteId, links and render all go through isNoteFileName/splitNoteExtension). If the extension set changes, vault-ids.ts is updated and this guard silently drifts: renameNote(id, '.newext') would then produce a file named '.newext<ext>' instead of INVALID_PATH. This is the duplicated canonical policy the slice exists to remove.
- Fix: Expose the rule from vault-ids.ts (e.g. export `isNoteExtension(name)` that returns whether `name` is exactly a note extension, implemented with NOTE_EXTENSION) and use it in renameNote instead of the inline regex.
- Fix prompt: In src/shared/vault-ids.ts add and export a helper, e.g. `export function isNoteExtension(name: string): boolean { return NOTE_EXTENSION.exec(name)?.[0] === name }`, documented as 'whether name is only a note extension (`.md` any case, `.mdx`)'. In src/vault/vault.ts renameNote, replace `/^\.(?:[mM][dD]|mdx)$/.test(name.trim())` with `isNoteExtension(name.trim())` and import it. Keep the existing tests in tests/vault/vault.test.ts ('keeps a note’s own extension on rename…') passing; add rows to tests/shared/vault-ids.test.ts for the helper ('.md', '.MD', '.mdx' true; '.MDX', 'a.md', '' false).

### issue-78/01: NOTE_EXTENSION comment restates the regex

Run: issue-78
Slice: 01 "One note-extension rule: .mdx files are notes"
Review: 01-r3
Reviewed commit: dd447ebd923ca663a0d537587539dd344a1b5f37

### [observation] comments-note-extension-comment-restates-regex

- Symbol: NOTE_EXTENSION
- Location at filing time: src/shared/vault-ids.ts:53
- Title: NOTE_EXTENSION comment restates the regex
- Problem: src/shared/vault-ids.ts:53 | "A note extension at the end of a name: `.md` in any letter case, or `.mdx` in lower case only." | This spells out what `/(?:\.[mM][dD]|\.mdx)$/` already says. It does not explain why `.mdx` is lowercase only, which is the one fact a later cleanup could break by adding an `i` flag.
- Fix: Rewrite the comment to give the reason (for example: `// .mdx is lowercase only on purpose: .MDX/.Mdx files are not notes (scan, argv, open requests skip them); do not add an i flag.`), or delete it.
- Fix prompt: In src/shared/vault-ids.ts, replace the doc comment above NOTE_EXTENSION, which restates the regex, with one that says why .mdx matches lowercase only: .MDX and .Mdx files are deliberately not notes, so the regex must not get a case-insensitive flag. If you cannot state that reason briefly, delete the comment.

### issue-78/02: isExtensionCaseTwin now detects stem twins, but its name still says extension case

Run: issue-78
Slice: 02 "Stem clashes between .md and .mdx notes"
Review: 02-r1
Reviewed commit: fcbb5c6885c5262c63efde9b771e17a0b8708a62

### [observation] react-ts-is-extension-case-twin-name-outdated

- Symbol: isExtensionCaseTwin
- Location at filing time: src/vault/names.ts:19
- Title: isExtensionCaseTwin now detects stem twins, but its name still says extension case
- Problem: The function now returns true for `a.md`/`A.mdx` and `a.md`/`A.md`, pairs whose extensions or stem case differ, not only their extension case. The diff renames the concept to "stem twins" in every doc comment (`hasStemTwin`, `sharedAssetsOf`, vault-ids.ts, PLAN.md), but the function keeps its old name. A reader of `sharedAssetsOf` sees `isExtensionCaseTwin` and expects only `a.md`/`a.MD`.
- Fix: Rename `isExtensionCaseTwin` to `isStemTwin` (with its test describe block), to match `hasStemTwin` and the docs.
- Fix prompt: Rename the function isExtensionCaseTwin in src/vault/names.ts to isStemTwin. Update its one caller, sharedAssetsOf in src/vault/vault.ts, and the comment there that names it. Rename the `describe('isExtensionCaseTwin', ...)` block in tests/vault/names.test.ts to match. Keep no alias.

### issue-78/02: lowerCaseEntries keeps a second reader of a folder's name keys beside readFolderNames

Run: issue-78
Slice: 02 "Stem clashes between .md and .mdx notes"
Review: 02-r3
Reviewed commit: 28f7d3912e38ec031b0f0d560c6ee02f34be4f24

### [observation] thermo-lower-case-entries-duplicates-folder-names

- Symbol: lowerCaseEntries
- Location at filing time: src/vault/names.ts:97
- Title: lowerCaseEntries keeps a second reader of a folder's name keys beside readFolderNames
- Problem: The slice adds `readFolderNames` (one readdir → `FolderNames.entries`, keyed by `nameKey`, ENOENT → empty) but keeps `lowerCaseEntries`, which does the same readdir/nameKey/ENOENT work into a `Set`. The two are now used for the same question, whether a folder name is taken: `pickFolderId` in import-files.ts asks `names.entries.has(nameKey(candidate))`, while `restore` (folder branch) and `deleteFolder` in vault.ts ask `lowerCaseEntries(dir).has(nameKey(c))`. Two readers with copied ENOENT handling for one fact.
- Fix: Delete `lowerCaseEntries` and have the folder branches of `restore` and `deleteFolder` read `(await readFolderNames(dir)).entries` (or add a small `entryTaken(names, name)` helper used by all three folder-name checks).
- Fix prompt: In src/vault/names.ts remove `lowerCaseEntries`. In src/vault/vault.ts, in the folder branch of `restore` and in `deleteFolder`, replace `const names = await lowerCaseEntries(dir)` and `names.has(nameKey(c))` with `const names = await readFolderNames(dir)` and `names.entries.has(nameKey(c))`, matching `pickFolderId` in src/vault/import-files.ts. Drop the unused import.

### issue-78/03: noteSource hand-codes the lowercase-.mdx rule beside NOTE_EXTENSION

Run: issue-78
Slice: 03 "Drop import and OS file association accept .mdx"
Review: 03-r1
Reviewed commit: a479b6e03b186798a41999e2aa0d442239745fc3

### [observation] thermo-note-source-re-encodes-mdx-rule

- Symbol: noteSource
- Location at filing time: src/vault/import-files.ts:119
- Title: noteSource hand-codes the lowercase-.mdx rule beside NOTE_EXTENSION
- Problem: Slice 01 made `NOTE_EXTENSION` / `splitNoteExtension` in src/shared/vault-ids.ts the one place that says which extensions are notes (`.md` in any case, `.mdx` in lowercase only). `noteSource` adds a third copy of that rule (`name.endsWith('.mdx')` plus `MARKDOWN`), next to the renameNote regex already deferred under 01-r1. Import does need one extra rule of its own: `.markdown` turns into `.md`. But the `.md`/`.mdx` part is the shared policy. If the note-extension set changes in vault-ids.ts, drop import drifts without anyone noticing. The function also checks MARKDOWN twice (`test`, then `replace`).
- Fix: Derive the note case from splitNoteExtension and keep only the `.markdown` mapping local.
- Fix prompt: In src/vault/import-files.ts, rewrite noteSource(name) on top of splitNoteExtension from src/shared/vault-ids.ts. If isNoteFileName(name) is true, take { base, extension } from splitNoteExtension(name) and return { stem: base, extension: extension === '.mdx' ? '.mdx' : '.md' }. Otherwise, if name matches /\.markdown$/i and its stem is not empty, return the stem with '.md'. In every other case return undefined. Narrow MARKDOWN to the .markdown-only rule, or remove it, so that the lowercase-.mdx policy lives only in vault-ids.ts. Keep the behaviour pinned by the existing import-files tests.

### issue-78/04: exportNote picks the .mdx filter with its own `id.endsWith('.mdx')` instead of the shared note-extension split

Run: issue-78
Slice: 04 "MDX syntax renders as plain Markdown; edit and export .mdx notes"
Review: 04-r1
Reviewed commit: 0b807f9d8ae8922af37c2c4b70f74329f7e343da

### [observation] holistic-export-filter-hand-codes-mdx-extension

- Symbol: exportNote
- Location at filing time: src/app/actions/api/export.ts:44
- Title: exportNote picks the .mdx filter with its own `id.endsWith('.mdx')` instead of the shared note-extension split
- Problem: The line right after this one calls `noteStem(id)`, which goes through `splitNoteExtension` in src/shared/vault-ids.ts, the one place meant to define the note extensions. The filter choice instead checks `id.endsWith('.mdx')` by hand. The result is correct today, because `vault.readNote(id)` has already accepted `id` as a note, so a `.mdx` ending can only be the lowercase note extension. But it adds one more hand-written copy of the `.mdx` rule, next to the copies in renameNote and noteSource that earlier reviews deferred. Taking the extension from `splitNoteExtension(id)` would keep the stem and the filter on the same split.
- Fix: Take the extension from `splitNoteExtension(id)` once, and use it for both the stem and the filter choice.
- Fix prompt: In src/app/actions/api/export.ts, in exportNote, replace `id.endsWith('.mdx')` and the separate `noteStem(id)` call with one call: `const { base, extension } = splitNoteExtension(lastSegment(id))`. Choose MDX_FILTER when `format === 'markdown' && extension === '.mdx'`, and use `base` as the stem. Import splitNoteExtension from src/shared/vault-ids.ts, and drop the noteStem import if nothing else uses it. The behavior stays the same, so the test in tests/app/export.test.ts stays as it is.

### issue-78/04: MDX filter comment mostly restates the ternary below it

Run: issue-78
Slice: 04 "MDX syntax renders as plain Markdown; edit and export .mdx notes"
Review: 04-r1
Reviewed commit: 0b807f9d8ae8922af37c2c4b70f74329f7e343da

### [observation] comments-mdx-filter-comment-restates-ternary

- Symbol: exportNote
- Location at filing time: src/app/actions/api/export.ts:43
- Title: MDX filter comment mostly restates the ternary below it
- Problem: src/app/actions/api/export.ts:43 | "// An .mdx note exports as .mdx, so the copy stays the note's kind; .md notes keep .md." | The next line already says this: `format === 'markdown' && id.endsWith('.mdx') ? MDX_FILTER : SAVE_FILTERS[format]`. The only extra part, "so the copy stays the note's kind", is a weak reason. The comment also leaves out the one fact a later reader could get wrong: the check is case-sensitive on purpose, because only lowercase `.mdx` is a note (`.MDX` is not).
- Fix: Delete the comment, or rewrite it to give the non-obvious fact, e.g. `// Case-sensitive on purpose: only lowercase .mdx is a note extension (see NOTE_EXTENSION).`
- Fix prompt: In src/app/actions/api/export.ts, in exportNote, replace the comment above the `const filter = ...` line with `// Case-sensitive on purpose: only lowercase .mdx is a note extension (see NOTE_EXTENSION in src/shared/vault-ids.ts).`, or delete the comment.

### issue-78/05: Title-rename planner hand-copies #relocateNote's refusal rule and resolves each folder twice

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r1
Reviewed commit: ddc21900b407f418f5fadfe26d815e544422095c

### [observation] thermo-title-planner-re-derives-relocate-refusal

- Symbol: Vault.planTitleRenames
- Location at filing time: src/vault/vault.ts:519
- Title: Title-rename planner hand-copies #relocateNote's refusal rule and resolves each folder twice
- Problem: The own-stem exemption (`ownFree`: stemShared plus sameOrMissing on the target .assets) re-encodes, in a different form, what #relocateNote/stemTakenByOthers refuses at apply time. The new comment says so: 'as `#relocateNote` would refuse it'. The plan stays right only while the two predicates agree. In this diff one is count-based (stemShared over FolderNames) and the other is identity-based (inode exclusion of self and own assets), so they can drift. The loop also calls resolveInside for every planned note, even when nameKey(target) !== nameKey(stem), although the folder was already resolved for the FolderNames cache a few lines up.
- Fix: Keep the resolved dir next to the cached FolderNames: one map entry { dir, names }. Compute dir/file only when nameKey(target) === nameKey(stem). Better still, give the plan and the apply step one shared 'own stem is free' predicate, so the planner does not mirror #relocateNote by comment.
- Fix prompt: In src/vault/vault.ts planTitleRenames, cache { dir, names } per folder instead of calling resolveInside again for each note. Only compute `file` and the sameOrMissing assets check when nameKey(target) === nameKey(stem). Consider pulling the 'own stem is free' rule into one helper that both the planner and #relocateNote use.

### issue-78/05: vault.ts is 1262 lines and keeps gaining name-clash helpers

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r1
Reviewed commit: ddc21900b407f418f5fadfe26d815e544422095c

### [observation] thermo-vault-ts-over-1000-lines

- Symbol: stemTakenByOthers
- Location at filing time: src/vault/vault.ts:1205
- Title: vault.ts is 1262 lines and keeps gaining name-clash helpers
- Problem: src/vault/vault.ts is over 1000 lines. This slice adds more folder-name clash logic to it (stemTakenByOthers, the planner's assets check), while names.ts is the module that owns the clash rules (stemTaken, folderNamesOf, stemShared). Name policy is now split between the two files.
- Fix: Move stemTakenByOthers, and the sameOrMissing/assetsDirOf helpers it needs, into src/vault/names.ts or a small clash module, so vault.ts keeps orchestration only.
- Fix prompt: Move the file-system clash helpers from src/vault/vault.ts (stemTakenByOthers, and sameOrMissing/sharedAssetsOf if they fit) into src/vault/names.ts or a new src/vault/clashes.ts. Import them from vault.ts to bring it back toward 1000 lines.

### issue-78/05: No test for a case-only rename refused because a stem twin already has the target's name

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r2
Reviewed commit: d554c5a4dec6747fb8bcff9f6dd365430f56f0a9

### [observation] testing-case-only-rename-onto-twin-name-untested

- Symbol: stemTakenByOthers
- Location at filing time: src/vault/vault.ts:1226
- Title: No test for a case-only rename refused because a stem twin already has the target's name
- Problem: The fix adds a branch in stemTakenByOthers: on a case-only rename, a stem twin is skipped unless its nameKey equals the target file name (`if (entryKey=<REDACTED> nameKey(name)) return true`). The doc comment calls this out ('though an entry of the target's own name by nameKey still clashes'). Only the skip side has a test ('renames a.md to A beside its .mdx twin a.mdx'). No test reaches the refusal side, for example on a case-sensitive disk `work/a.md` beside `work/A.MD`, where renameNote('work/a.md', 'A') targets `A.md`, whose nameKey matches `A.MD`. If that return were dropped, the rename would go through and leave `A.md` beside `A.MD`, and no test would fail. The exact-path case is already caught by sameOrMissing(from, to), so the only effect is an extra stem twin, which is why this does not block.
- Fix: Add a case-sensitive-disk test (skip elsewhere) where a case-only rename lands on a name a stem twin already holds by nameKey, and expect EXISTS with both files unchanged.
- Fix prompt: In tests/vault/vault.test.ts, describe('stem twins (a.md beside a.mdx)') or describe('extension-case twins'), add a test: put 'work/a.md' and 'work/A.MD', skip with ctx.skip() when readdir(work) has fewer than 2 entries (case-insensitive disk), open the vault, and expect vault.renameNote('work/a.md', 'A') to reject with { code: 'EXISTS' }. Then check that readdir(work).sort() is still ['A.MD', 'a.md']. This pins the `entryKey=<REDACTED> nameKey(name)` refusal in stemTakenByOthers (src/vault/vault.ts).

### issue-78/05: stemTakenByOthers pre-filters entries with a hand copy of stemTaken's three clauses

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r3
Reviewed commit: d554c5a4dec6747fb8bcff9f6dd365430f56f0a9

### [observation] thermo-stem-taken-by-others-prefilter-copies-stem-taken

- Symbol: stemTakenByOthers
- Location at filing time: src/vault/vault.ts:1222
- Title: stemTakenByOthers pre-filters entries with a hand copy of stemTaken's three clauses
- Problem: Before it calls `stemTaken(folderNamesOf(others), base, extension)`, stemTakenByOthers drops every entry that fails its own test: `ofStem` (a note of the stem by nameKey) or `candidates` (the file name and `<base>.assets` by nameKey). That is the stemTaken rule written out a second time in another form, so the result is right only while the filter and stemTaken agree. They have already disagreed once in this slice: the implementer's report says the ΟΣ test went red because the prefix filter skipped `ΟΣ.mdx` while stemTaken would have counted it. If a later change adds a clause to stemTaken, the filter drops those entries before stemTaken sees them, and renames go through without any error.
- Fix: Keep one copy of the rule. Build FolderNames from every entry that is not self, not self's own assets folder and not a skipped case-only twin, and let stemTaken decide. Or move the 'could this entry take the stem' test into names.ts next to stemTaken, so both read the same keys.
- Fix prompt: In src/vault/vault.ts stemTakenByOthers, remove the hand-written prefilter (`ofStem` / `candidates`), which repeats stemTaken's clauses. Either run the self, own-assets and case-only-twin exclusions over all folder entries and pass the rest to folderNamesOf/stemTaken. Or, if the per-entry stat cost matters, export a predicate from src/vault/names.ts beside stemTaken (for example `mayTakeStem(entryName, stem, extension)`, built from the same nameKey keys) and use it here, so the filter and stemTaken cannot drift apart. Keep the existing ΟΣ and stem-twin rename tests green.

### issue-78/05: Case-only rename onto a case-variant hard link of the note is a silent no-op that untracks the source

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r4
Reviewed commit: 4049f60d135932734677ac131afa682379ea6482

### [observation] bug-rename-onto-case-variant-hard-link-of-self

- Symbol: stemTakenByOthers
- Location at filing time: src/vault/vault.ts:1230
- Title: Case-only rename onto a case-variant hard link of the note is a silent no-op that untracks the source
- Problem: src/vault/vault.ts:1230 stemTakenByOthers skips any entry whose nameKey equals the source's name key and that shares its inode (sameOrMissing(self, other)). Take a case-sensitive disk where `work/a.md` and `work/A.md` are hard links of one file. Then renameNote('work/a.md', 'A') targets `work/A.md`. sameOrMissing(from, to) is true because both names have the same inode, and line 1230 skips `A.md` as if it were the source. No clash is reported and `rename(a.md, A.md)` runs. POSIX defines rename of two hard links to one file as a successful no-op. `#relocateNote` then untracks `work/a.md` and tracks `work/A.md`, so the index drops a note that is still on disk until a later refresh finds it again. It needs hard links made by hand and loses no data, so it does not block.
- Fix: Treat only the source's own directory entry as self: skip an entry when its name is exactly path.basename(self). When it is a different entry with the same nameKey, also require that the folder holds no separate entry of that name, for example on a case-insensitive disk where readdir returns the one real name. A distinct case-variant entry that is a hard link of the source then counts as a clash and the rename is refused with EXISTS.
- Fix prompt: In src/vault/vault.ts, stemTakenByOthers: the self-skip `if (entryKey=<REDACTED> nameKey(selfName) && (await sameOrMissing(self, other))) continue` also skips a different directory entry that is a case-variant hard link of the source (case-sensitive disk: `a.md` and `A.md` linked). Then renameNote('work/a.md', 'A') goes through, POSIX rename is a no-op, and the vault untracks a.md, which is still on disk. Change the skip so it applies only to the source's own entry (entry.name === path.basename(self)). Any other entry with the same nameKey, hard-linked or not, should reach stemTaken and give EXISTS. A case-only rename on a case-insensitive disk must keep working. Add a test, skipped unless the disk is case-sensitive: link work/a.md to work/A.md, then expect renameNote('work/a.md', 'A') to reject with EXISTS and both names to stay.

### issue-78/05: Title-planner comment says an NFD stem twin claims the same <stem>.assets path; on a non-normalizing disk it does not

Run: issue-78
Slice: 05 "Close .mdx follow-ups: rename clashes, title-rename and folder-name edges, index.mdx export, tests and docs"
Review: 05-r4
Reviewed commit: 4049f60d135932734677ac131afa682379ea6482

### [observation] comments-title-planner-nfd-twin-same-assets-path

- Symbol: Vault.planTitleRenames
- Location at filing time: src/vault/vault.ts:515
- Title: Title-planner comment says an NFD stem twin claims the same <stem>.assets path; on a non-normalizing disk it does not
- Problem: src/vault/vault.ts:514-516 | "unless another entry in the folder shares its stem (a stem twin: `a.MD`, `a.mdx` or an NFD name beside it, which claims the same `<stem>.assets` path; ...)" | This is true for `a.MD` and `a.mdx` (identical stem) but not for an NFD name: on a case-sensitive, non-normalizing disk (ext4), NFC `Café.md` and NFD `Cafe\u0301.md` have separate `<stem>.assets` directories. The sharedAssetsOf doc in the same diff (vault.ts:1245-1247) says exactly that: they 'normally keep separate folders, so neither is a twin'. A reader of the planner comment learns that an NFD twin shares the assets folder, which contradicts sharedAssetsOf, and gets the wrong reason why the planner treats the note's own stem as taken in that case (stemShared counts any entry of the same stem key, not only ones that share a folder).
- Fix: Make the reason match the code: the own stem is taken whenever stemShared finds another note of the same stem key. For example: "unless another note in the folder shares its stem by `nameKey` (a stem twin: `a.MD`, `a.mdx` or an NFD name beside it, which may share its `<stem>.assets` path — always for `a.MD`/`a.mdx`, for an NFD name only on a normalizing disk; `#relocateNote` also refuses the move when the twin has the target's own file name, `a.MD` beside `a.md`)".
- Fix prompt: In src/vault/vault.ts, Vault.planTitleRenames, the comment at lines 514-516 says a stem twin `a.MD`, `a.mdx` or an NFD name 'claims the same `<stem>.assets` path'. That is false for an NFD name on a non-normalizing disk (see the sharedAssetsOf doc around line 1245). Reword it so it does not claim an NFD twin always shares the assets path: say the own stem counts as taken when another note of the same stem key is there (stemShared), and that such a twin may share the `<stem>.assets` path (always for `a.MD`/`a.mdx`, for an NFD name only on a normalizing or case-insensitive disk). Keep the clause about #relocateNote refusing the move when the twin has the target's own file name.

### issue-78/retro: Note-name rules are restated in many PLAN.md sections and doc comments, so each rule change left stale copies

Run: issue-78
Retro finding (repo, navigation, medium)

Slices 01, 02, 03 and 05 each spent a fix round (01-f2, 02-f2, 02-f3, 03-f1, 05-f2) on prose that stated the note-extension, stem-twin or import-name rule in one place but kept the old rule in another: the `src/shared/vault-ids.ts` header, PLAN.md "Note names" / "Extension case", PLAN.md "Shared rules", PLAN.md "Drop import" Names and Links bullets, PLAN.md Renderer export paragraph, and function doc comments in names.ts, vault.ts, export.ts and render.ts. State each name rule once (the `vault-ids.ts` header or the PLAN.md "Note names" section) and have the other places point to it instead of restating it, so a rule change edits one paragraph.

### issue-78/retro: Case-sensitive-disk tests are outside the configured checks

Run: issue-78
Retro finding (repo, automated-checks, medium)

Slices 02 and 05 added tests that skip on the default macOS disk (case-sensitive twins, `a.mdx` beside `a.MDX`, foreign `hELLo.assets`). They ran only when the implementer chose to run `pnpm test:case-sensitive` by hand; `factory_checks` (pnpm run check, typecheck, test, test:e2e, build) never runs them, so a regression in those paths passes every configured check on macOS. Add `pnpm test:case-sensitive tests/vault` (or the whole suite) to the run checks in `.omp/factory.json`, or to CI on a Linux runner via `pnpm test:linux`.

### issue-78/retro: No check stops new hand-written copies of the note-extension rule

Run: issue-78
Retro finding (repo, automated-checks, low)

The `.md`/`.mdx` rule of `NOTE_EXTENSION` in `src/shared/vault-ids.ts` was re-encoded by hand three times in this run (`renameNote` regex in src/vault/vault.ts, `noteSource` in src/vault/import-files.ts, the `id.endsWith('.mdx')` export filter in src/app/actions/api/export.ts); thermo and holistic reviewers raised each one. A Biome/grit rule (the repo already has tests/e2e/rules.grit and tests/lint/) that flags `.mdx` / `\.md` string or regex literals in `src/` outside `src/shared/vault-ids.ts` and `src/migrate/` would catch new copies before review.

### issue-78/retro: Validator gets advisory notes that ask for reviewer work it cannot do

Run: issue-78
Retro finding (factory, no-ops, low)

In reviews 01-r2, 01-r4 and 01-r1 the validator answered an advisory note that asked it to run domain reviews or resubmit fix-item verdicts with `factory_review_submit`, which it does not have; it then explained why it would not act. These advisory turns add a model round trip and transcript text but change no verdict. Gate the advisory so it does not fire when every domain file is an empty list, or word it for the validator role only.

### issue-78/retro: Comment-only fix rounds still force a second full multi-domain review

Run: issue-78
Retro finding (factory, tool-economy, low)

Each slice with a blocking finding ran full review (8-10 domains) → targeted → full again even when the fix was a one-line comment change (01-f1, 02-f3, 03-f1). Slice 02 took 6 reviews and slice 01 took 4. A targeted green after a comments-only fix of a comments-domain finding could count as final when the diff since the last full review touches only comment lines, which would save one full 9-domain review per such slice.

### issue-78/07: e2e getByLabel matches the label as a substring, not exactly

Run: issue-78
Slice: 07 "Preference label names .md and .mdx files"
Review: 07-r1
Reviewed commit: 5c01cd85fb1c8cbb915eec4a86ca57b48c144fe4

### [observation] test-validity-e2e-label-locator-substring-match

- Symbol: "Opening a .md or .mdx outside a vault" defaults to Read only; "Open its folder as vault" opens outside files as vaults
- Location at filing time: tests/e2e/app.spec.ts:847
- Title: e2e getByLabel matches the label as a substring, not exactly
- Problem: tests/e2e/app.spec.ts:847 | `getByLabel('Opening a .md or .mdx outside a vault')` uses Playwright's default substring, case-insensitive match. The label wraps the select, so its accessible name also takes in the selected option text, and substring matching is what makes the lookup work. But a label that drifted to a longer text, for example 'Opening a .md or .mdx outside a vault folder', or one with different letter case, would still pass. The old label is not a substring, so the test does catch the regression this slice targets.
- Fix: Associate the span with the select (e.g. aria-labelledby or a <label for>) and use `getByLabel('Opening a .md or .mdx outside a vault', { exact: true })`, or assert the span text exactly with `toHaveText` next to the current lookup.
- Fix prompt: In tests/e2e/app.spec.ts, in the test '"Opening a .md or .mdx outside a vault" defaults to Read only; ...', add an exact check of the label text, for example `await expect(page.locator('[data-preferences] label', { has: select }).locator('span')).toHaveText('Opening a .md or .mdx outside a vault')`, so a label with extra words or different case fails the test. Keep the getByLabel lookup.

### issue-78/retro: Note-name rules are restated in many places, so each change left stale copies

Run: issue-78
Retro finding (repo, navigation, medium)

Slices 01, 02, 03 and 05 each spent fix rounds on prose that kept an old note-extension, stem-twin or import-name rule in one place after another place was updated (vault-ids.ts header, several PLAN.md sections, doc comments in names.ts, vault.ts, export.ts, render.ts). State each name rule once (the vault-ids.ts header or PLAN.md "Note names") and have the other places point to it.

### issue-78/retro: Case-sensitive-disk tests are outside the configured checks

Run: issue-78
Retro finding (repo, automated-checks, medium)

Tests that skip on the default macOS disk (case-sensitive twins, a.mdx beside a.MDX, foreign hELLo.assets) ran only when an implementer ran `pnpm test:case-sensitive` by hand. Add it (or `pnpm test:linux`) to the configured checks or CI.

### issue-78/retro: User-facing strings named by the issue were not in slice acceptance

Run: issue-78
Retro finding (factory, information-access, medium)

The issue asked to update UI strings that the change makes wrong, but the plan named only comment locations. The slice 03 implementer flagged the preferences label as open and the orchestrator did not act; it took slice 07 to fix it. A plan step that greps user-facing strings (JSX text, menu labels) for the changed term, and turns each one into an acceptance criterion, would catch it. So would a scope-review rule that treats an implementer's open item quoting the issue as unbuilt.

### issue-78/retro: Required smoke run is not part of the checks

Run: issue-78
Retro finding (repo, automated-checks, low)

AGENTS.md asks for `pnpm smoke --vault-copy tests/fixtures/sample-vault` before hand-off, but the run's checks do not include it, so the first hand-off skipped it. Add a non-interactive smoke (with a steps module and screenshot) to the factory checks, or note in AGENTS.md that factory runs must run it before submit.

### issue-78/retro: No check stops hand-written copies of the note-extension rule

Run: issue-78
Retro finding (repo, automated-checks, low)

The `.md`/`.mdx` rule of NOTE_EXTENSION was hand-copied three times (renameNote regex, noteSource in import-files.ts, the export filter). A grit/biome rule flagging `.mdx`/`\.md` literals in src/ outside src/shared/vault-ids.ts and src/migrate/ would catch new copies.

### issue-78/retro: Validator gets advisory notes that ask for reviewer work

Run: issue-78
Retro finding (factory, no-ops, low)

In several reviews the validator got advisory notes asking it to run domain reviews or resubmit verdicts with tools it does not have. These turns changed no verdict. Skip the advisory when every domain file is an empty list, or word it for the validator role only.

### issue-78/retro: Comment-only fix rounds force a second full review

Run: issue-78
Retro finding (factory, tool-economy, low)

A blocking finding fixed by a one-line comment change still forced full review → targeted → full review (01-f1, 02-f3, 03-f1). Count a targeted green as final when the diff since the last full review changes only comment lines.

## issue-77/01: Fake timers restored with try/finally instead of `using`

Run: issue-77
Slice: 01 "Inline /date, /time and /datetime slash commands"
Review: 01-r1
Reviewed commit: b9184c35da2a3c120e380a0d03ad5ed0bf9f31dd

### [observation] testing-fake-timers-manual-cleanup

- Symbol: picking /datetime inserts the time at run time, and one undo restores the /query
- Location at filing time: tests/editor/editor.test.ts:97
- Title: Fake timers restored with try/finally instead of `using`
- Problem: testing-best-practice rule 7: the test sets fake timers and restores them by hand in try/finally rather than through a `using` disposable resource.
- Fix: Wrap fake timers in a small disposable helper (returns { [Symbol.dispose]: () => vi.useRealTimers() }) and use `using clock = fakeClock(date)` instead of try/finally.
- Fix prompt: In tests/editor/editor.test.ts, test 'picking /datetime inserts the time at run time, and one undo restores the /query', replace the try/finally around vi.useFakeTimers/vi.useRealTimers with a disposable helper, e.g. const fakeClock = (at: Date) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); return { [Symbol.dispose]: () => vi.useRealTimers() } }, and `using _clock = fakeClock(new Date(2026, 10, 5, 14, 32))` at the top of the test.

## issue-77/01: SlashCommand.template is an untagged union narrowed by string compare and `'inline' in`

Run: issue-77
Slice: 01 "Inline /date, /time and /datetime slash commands"
Review: 01-r1
Reviewed commit: b9184c35da2a3c120e380a0d03ad5ed0bf9f31dd

### [observation] thermo-slash-template-untagged-union

- Symbol: SlashCommand
- Location at filing time: src/editor/slash.ts:33
- Title: SlashCommand.template is an untagged union narrowed by string compare and `'inline' in`
- Problem: template is now BlockTemplate | InlineCommand | 'image', told apart by `=== 'image'` and `'inline' in`. Every consumer repeats that narrowing (applySlashCommand plus both test helpers in slash.test.ts lines 16 and 80), and slice 02 adds a table-grid kind, which will add another structural check at every site.
- Fix: Model the command kind as a discriminated union (for example `{ kind: 'block', block } | { kind: 'inline', format } | { kind: 'image' }`) and switch on `kind` in applySlashCommand, so adding the table kind is one new variant plus one new case.
- Fix prompt: In src/editor/slash.ts, replace `template: BlockTemplate | InlineCommand | 'image'` with a discriminated union keyed by a `kind` field (block, inline, image), update slashCommands entries, make applySlashCommand an exhaustive switch on kind, and simplify the test helpers in tests/editor/slash.test.ts to check `kind`.

## issue-77/02: Focus-then-sync-setEditorFocused workaround copied from index.ts

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r1
Reviewed commit: 9d029b89e69f675fc5d839fcb5feaac742de77c9

### [observation] thermo-refocus-sync-duplicated

- Symbol: pickTableSize
- Location at filing time: src/editor/slash.ts:253
- Title: Focus-then-sync-setEditorFocused workaround copied from index.ts
- Problem: close() repeats the `view.focus(); if (view.hasFocus) view.dispatch({ effects: setEditorFocused.of(true) })` workaround that already lives in setDoc in src/editor/index.ts. Because of it slash.ts now imports a live-preview internal (live-preview/selection.ts). Two copies of a focus-reporting workaround will drift the next time the focus tracking changes.
- Fix: Export one helper next to setEditorFocused (for example `focusEditor(view)` in live-preview/selection.ts) that focuses the view and syncs the flag, and call it from both index.ts setDoc and the grid's close().
- Fix prompt: In src/editor/live-preview/selection.ts add an exported `focusEditor(view: EditorView)` (or `syncEditorFocused(view)`) that holds the `if (view.hasFocus) view.dispatch({ effects: setEditorFocused.of(true) })` workaround. Use it in src/editor/index.ts setDoc and in pickTableSize's close() in src/editor/slash.ts, and drop slash.ts's direct setEditorFocused import.

## issue-77/02: 100-line DOM widget mixed into the slash command module

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r1
Reviewed commit: 9d029b89e69f675fc5d839fcb5feaac742de77c9

### [observation] thermo-table-grid-dom-in-slash-module

- Symbol: pickTableSize
- Location at filing time: src/editor/slash.ts:210
- Title: 100-line DOM widget mixed into the slash command module
- Problem: pickTableSize builds the grid DOM, handles keyboard, mouse and focus, and positions the popup, all inside slash.ts next to the command registry, the completion source and the transaction rules. The module now mixes a pure editing policy with a stateful UI widget, so a change to the grid means reading through the slash logic and the other way round.
- Fix: Move pickTableSize, TableSize and MAX_TABLE_SIZE to their own module (for example src/editor/table-size-grid.ts) that exports `pickTableSize(view, pos)`. Keep runTableCommand and tableTemplate in slash.ts.
- Fix prompt: Extract pickTableSize, the TableSize interface and MAX_TABLE_SIZE from src/editor/slash.ts into a new src/editor/table-size-grid.ts that exports pickTableSize(view, pos). Import it in slash.ts for runTableCommand. Behaviour stays the same.

## issue-77/02: runTableCommand repeats runImageCommand's remove/track/finally skeleton

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r1
Reviewed commit: 9d029b89e69f675fc5d839fcb5feaac742de77c9

### [observation] thermo-deferred-command-skeleton-duplicated

- Symbol: runTableCommand
- Location at filing time: src/editor/slash.ts:305
- Title: runTableCommand repeats runImageCommand's remove/track/finally skeleton
- Problem: runTableCommand copies runImageCommand's whole lifecycle: dispatch the /query removal, trackInsertion, await a picker, insert at target.at(), and `finally target.done()`. Both also wrap it in an identical `void ...catch(console.error)` in applySlashCommand. A third async command (or a fix to the lifecycle, such as handling a destroyed view) has to be made in every copy.
- Fix: Extract one `runDeferredCommand(view, from, to, pick, insert)` that owns the removal, the tracking and the cleanup, and let image and table supply only their picker and insert.
- Fix prompt: In src/editor/slash.ts add a helper that removes the /query (userEvent 'input.slash'), calls trackInsertion(view, from), awaits a supplied async step with the PendingInsertion, and calls target.done() in finally. Rewrite runImageCommand and runTableCommand on top of it, and fold the two `void run...().catch(console.error)` branches in applySlashCommand into the same call.

## issue-77/02: Grid column count hard-coded in theme apart from MAX_TABLE_SIZE

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r1
Reviewed commit: 9d029b89e69f675fc5d839fcb5feaac742de77c9

### [observation] thermo-grid-size-two-sources

- Symbol: baseTheme
- Location at filing time: src/editor/theme.ts:205
- Title: Grid column count hard-coded in theme apart from MAX_TABLE_SIZE
- Problem: The theme sets `gridTemplateColumns: 'repeat(10, 14px)'` while slash.ts builds MAX_TABLE_SIZE cells per row. Changing MAX_TABLE_SIZE leaves the CSS at 10 columns, so the cells wrap into the wrong rows and the highlight no longer matches the picked size.
- Fix: Set the column count from MAX_TABLE_SIZE when building the grid (for example `cells.style.gridTemplateColumns = `repeat(${MAX_TABLE_SIZE}, 14px)``), or derive the theme value from the exported constant.
- Fix prompt: Remove the hard-coded 10 from '.cm-lp-table-size-cells' gridTemplateColumns in src/editor/theme.ts. Either set gridTemplateColumns inline in pickTableSize from MAX_TABLE_SIZE, or export MAX_TABLE_SIZE and build the theme string from it.

## issue-77/02: Test waits for a fire-and-forget command by guessing one macrotask

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r1
Reviewed commit: 9d029b89e69f675fc5d839fcb5feaac742de77c9

### [observation] thermo-table-test-waits-on-macrotask

- Symbol: picking /table opens the size grid; a table picked after the document changed lands where the /query maps to
- Location at filing time: tests/editor/editor.test.ts:131
- Title: Test waits for a fire-and-forget command by guessing one macrotask
- Problem: applySlashCommand discards runTableCommand's promise, so the test waits with setTimeout(0) on the assumption that every step settles within microtasks. If any await in the path ever waits on a real macrotask (a read-only period, a host call), the test fails or passes for the wrong reason, and the comment has to explain the workaround.
- Fix: Poll for the expected document (for example vi.waitFor) instead of guessing the scheduling, or give the test a promise that settles when the insert is done.
- Fix prompt: In tests/editor/editor.test.ts, in the /table mapped-position test, replace the setTimeout(0) wait with `await vi.waitFor(() => expect(docWithSelection(editor.view.state)).toBe(...))`, so the test does not depend on how many microtasks runTableCommand takes.

## issue-77/02: Field doc now says generic pending insertions, but the field is still named pendingImages

Run: issue-77
Slice: 02 "/table size picker grid"
Review: 02-r2
Reviewed commit: e747d6aac2dc2a157c781befb94a8b6c8e331844

### [observation] holistic-track-insertion-docs-image-only

- Symbol: pendingImages
- Location at filing time: src/editor/paste.ts:66
- Title: Field doc now says generic pending insertions, but the field is still named pendingImages
- Problem: The fix rewrote the comments on lines 66, 101 and 109 to say the tracked positions cover both images and a /table size pick. The StateField right under the new line-66 comment is still named `pendingImages`, and paste.ts uses that name at line 117 (in trackInsertion) and line 211 (in the extension list). The original finding named this field. The comments are now accurate, but the identifier contradicts the comment directly above it, so a reader who searches for or skims the name still gets the image-only reading.
- Fix: Rename `pendingImages` to a generic name such as `pendingInsertions` at its declaration and both uses in paste.ts.
- Fix prompt: In src/editor/paste.ts, rename the StateField `pendingImages` (declared around line 67) to `pendingInsertions`, and update its uses in trackInsertion (`view.state.field(pendingImages, false)`) and in the extension list near line 211. Make no other changes.

## issue-77/03: gridBox overwrites the grid's width/height with the window's size under the same keys

Run: issue-77
Slice: 03 "Harden slash command tests and keep the table grid inside the viewport"
Review: 03-r1
Reviewed commit: 06add454a35df09ce0e2c77d39e55a19fb29c630

### [observation] holistic-grid-box-shadows-width-height

- Symbol: gridBox
- Location at filing time: tests/e2e/slash-table.spec.ts:106
- Title: gridBox overwrites the grid's width/height with the window's size under the same keys
- Problem: gridBox spreads grid.getBoundingClientRect().toJSON() (which has width and height of the grid) and then sets width: window.innerWidth and height: window.innerHeight. The returned object therefore has the grid's top/left/right/bottom but the window's width/height, and the grid's own size is silently dropped. The assertions `box.bottom <= box.height` and `box.right <= box.width` read as comparing the grid against its own size, and a later test that checks `box.width` or `box.height` to mean the grid's size would assert against the window instead.
- Fix: Return the window size under distinct keys, e.g. { grid: rect.toJSON(), innerWidth, innerHeight }, and compare against those names.
- Fix prompt: In tests/e2e/slash-table.spec.ts, change gridBox to return the window size under keys that do not collide with DOMRect fields, for example `{ ...grid.getBoundingClientRect().toJSON(), innerWidth: window.innerWidth, innerHeight: window.innerHeight }`, and update the two tests to assert `box.bottom <= box.innerHeight` and `box.right <= box.innerWidth`.

## issue-77/03: Viewport placement math is inline DOM code, provable only by slow e2e

Run: issue-77
Slice: 03 "Harden slash command tests and keep the table grid inside the viewport"
Review: 03-r1
Reviewed commit: 06add454a35df09ce0e2c77d39e55a19fb29c630

### [observation] thermo-grid-placement-inline-geometry

- Symbol: pickTableSize
- Location at filing time: src/editor/slash.ts:298
- Title: Viewport placement math is inline DOM code, provable only by slow e2e
- Problem: The above/below and left-clamp decision is a pure geometry rule (cursor coords + popup size + window size -> top/left), but it is written inline in pickTableSize with `coords?.… ?? 0` repeated three times and read straight from `window`. The only proof is two Electron e2e tests (one resizing the window), so a later tweak to the rule (e.g. a top clamp when neither side fits) costs a full e2e run to check.
- Fix: Extract a pure `placePopup(coords, {width, height}, {innerWidth, innerHeight})` returning {left, top}, default coords once, and call it from pickTableSize; the e2e tests stay as the vertical-slice proof.
- Fix prompt: In src/editor/slash.ts, move the placement rule from pickTableSize into a small pure function that takes the cursor rect (defaulted once to zeros when coordsAtPos returns null), the popup width/height and the window size, and returns { left, top } (below the cursor unless it overflows the bottom, then above, clamped at 0; left clamped to stay within the width). Call it from pickTableSize after measuring the appended popup. Keep the existing e2e tests.

## issue-77/retro: Unit and e2e suites flaky under load

Run: issue-77
Retro finding (repo, automated-checks, medium)

In slices 02 and 03 `pnpm run test` and `pnpm test:e2e` each failed their first run and passed on rerun. The failed runs took far longer than normal (test 92s and 63s vs about 12s; e2e 505s and 375s vs about 57s), which points at timing-sensitive tests under machine load. The slice 03 implementer also saw `tests/e2e/slash-table.spec.ts` 'clamps at 1 and 10' miss the grid once. Find the failing tests from the first-run output and make them wait on state (expect.poll / locator waits) instead of fixed timing.

## issue-77/retro: Implementers write tests that cannot fail on the criterion they name

Run: issue-77
Retro finding (factory, coding-standards, medium)

Two blocking findings in this run were tests that passed for the wrong reason: slice 01's NO_SLASH_NODES test returned null at the whitespace regex before the node check, and slice 03's bottom-edge test never asserted 'above the cursor'; slice 03 r3 found a third (narrow-window precondition). Each was caught only by review and cost a fix round. Ask the implementer prompt to show, for every test tied to an acceptance criterion, a mutation of the code under test that makes it fail (not only a red run before the code existed).

## issue-77/retro: No guidance for editor popups (placement, focus sync)

Run: issue-77
Retro finding (repo, navigation, low)

Slice 02 built a custom DOM popup and had to rediscover two things: the popup must stay inside the viewport (missed until review, a whole follow-up slice), and refocusing the editor needs the setEditorFocused sync from index.ts setDoc (found by debugging e2e). Add a short note to docs/modernisation/REMIX-NOTES.md or PLAN.md 'Editing' on how editor popups should place themselves and return focus, pointing at pickTableSize.

## issue-76/01: list() reads every note one after another, full text included

Run: issue-76
Slice: 01 "Scratch store and /api/scratch routes"
Review: 01-r1
Reviewed commit: 3629df123f49db37303583735789a04966e426b1

### [observation] thermo-scratch-list-reads-sequentially

- Symbol: ScratchStore.list
- Location at filing time: src/app/scratch-store.ts:55
- Title: list() reads every note one after another, full text included
- Problem: list() awaits this.read(id) for each note in turn. Each read does readFile, stat and readJsonFile, and then list() drops the text. The reads do not depend on each other, so the list takes N round trips, and it pulls every note's whole body just to compute a title. The list refreshes on every create, discard, rename and save, so it will run often.
- Fix: Map the names to reads, run them with Promise.all, and keep the NOT_FOUND filter. Optionally move the summary fields into a #summary(id) helper that read() and list() both use.
- Fix prompt: In src/app/scratch-store.ts ScratchStore.list, replace the sequential for/await loop with Promise.all over the matching ids. Each element should call this.read(id) and turn a NOT_FOUND HttpError into undefined. Then filter out the undefined entries, map them to ScratchSummary, and sort newest updated first as now. Keep tests/app/scratch.test.ts passing.

## issue-76/01: Scratch route tests hardcode URL strings where every sibling app test uses routes.api.*.href()

Run: issue-76
Slice: 01 "Scratch store and /api/scratch routes"
Review: 01-r3
Reviewed commit: 08b2bba562da4e30438c42a5344d57c3d5190b06

### [observation] holistic-scratch-tests-hardcode-route-urls

- Symbol: create
- Location at filing time: tests/app/scratch.test.ts:21
- Title: Scratch route tests hardcode URL strings where every sibling app test uses routes.api.*.href()
- Problem: tests/app/api.test.ts, export.test.ts and preferences.test.ts all import `routes` from src/app/routes.ts and build request URLs with `api.<name>.href()`. tests/app/scratch.test.ts is the only app test that writes the URLs by hand ('/api/scratch/create', '/api/scratch/write', '/api/scratch', '/api/scratch/read?id=…', '/api/scratch/discard', plus '/api/workspace' and '/api/search?q='). The new route names scratchList, scratchCreate, scratchRead, scratchWrite and scratchDiscard are therefore never referenced by a test, and the file uses a second convention for addressing routes.
- Fix: Import `routes` and use `api.scratchCreate.href()`, `api.scratchWrite.href()`, `api.scratchList.href()`, `api.scratchRead.href()` (with withQuery or a `?id=` suffix, as api.test.ts does for noteRead) and `api.scratchDiscard.href()`, and `api.workspace.href()` / `api.search.href()` for the vault checks.
- Fix prompt: In tests/app/scratch.test.ts, add `import { routes } from '../../src/app/routes.ts'` and `const api = routes.api`, as tests/app/api.test.ts does. Replace each hand-written URL with the route's href: '/api/scratch/create' → api.scratchCreate.href(), '/api/scratch/write' → api.scratchWrite.href(), '/api/scratch' → api.scratchList.href(), `/api/scratch/read?id=${id}` → `${api.scratchRead.href()}?id=${id}` (keep the URLSearchParams form in the 404 table), '/api/scratch/discard' → api.scratchDiscard.href(), '/api/workspace' → api.workspace.href(), and '/api/search?q=zebra' → `${api.search.href()}?q=zebra`. Do not change what any test asserts.

## issue-76/02: Tab strip branches on tab kind twice with nested ternaries

Run: issue-76
Slice: 02 "Scratch tab kind in Tabs"
Review: 02-r1
Reviewed commit: 4957e23410502a4226ee34aad7729d2a87f786ec

### [observation] thermo-tab-strip-per-kind-nested-ternaries

- Symbol: TabStrip
- Location at filing time: src/app/actions/public/workspace/tab-strip.tsx:57
- Title: Tab strip branches on tab kind twice with nested ternaries
- Problem: The tab strip now switches on tab.kind (note / reader / scratch) in two separate nested ternaries, one for the visible title and one for the tooltip. Every new tab kind or label change has to edit both, and slice 03 will replace the 'Scratch note' placeholder with the shared scratchTitle in at least one of them.
- Fix: Move both into one small per-kind function (for example tabLabel(tab, notes) returning { title, tooltip }) with a switch on tab.kind, and use it in the map.
- Fix prompt: In src/app/actions/public/workspace/tab-strip.tsx, replace the two nested kind ternaries (title and the title= tooltip) with one helper that switches on tab.kind once and returns { title, tooltip }; call it once per tab in the map. Keep the rendered text the same.

## issue-76/02: openScratch copies openReader's find-or-insert body

Run: issue-76
Slice: 02 "Scratch tab kind in Tabs"
Review: 02-r3
Reviewed commit: 61b687454d05272c1d269d49ab6a2a43a007631e

### [observation] thermo-open-scratch-duplicates-open-reader

- Symbol: Tabs.openScratch
- Location at filing time: src/app/actions/public/workspace/tabs.ts:161
- Title: openScratch copies openReader's find-or-insert body
- Problem: openScratch is a line-for-line copy of openReader: find a tab of that kind with a matching identity, activate it if found, otherwise build a new tab and #insert it. The same slice folded replaceReader and replaceScratch into one #replace(key, kind, path), but left these two open paths as twins. A change to the activate-or-insert rule, such as where a new tab goes or whether re-opening moves the tab, now has to be made in two places.
- Fix: Pull the body out into a private helper that both methods call, for example #openOnce<T extends Tab>(match: (tab: Tab) => tab is T, make: () => T): T. It activates the first tab that matches, otherwise inserts make(). openReader and openScratch then shrink to one line each.
- Fix prompt: In src/app/actions/public/workspace/tabs.ts, add a private method #openOnce<T extends Tab>(match: (tab: Tab) => tab is T, make: (key=<REDACTED> => T): T. It finds the first tab that satisfies match; if there is one, it sets activeKey to that tab's key and returns it. Otherwise it creates make(this.#takeKey()), calls #insert on it and returns it. Rewrite openReader and openScratch to call #openOnce with their kind and identity predicate and their tab constructor. Keep their public signatures and doc comments. tests/app/tabs.test.ts should pass unchanged.

## issue-76/03: Scratch tab title is recomputed over the whole text on every session change

Run: issue-76
Slice: 03 "New Scratch Note opens and autosaves a scratch tab"
Review: 03-r1
Reviewed commit: e6ec60e8a653dd1868ca51d888400b6cddaf8c32

### [observation] performance-scratch-title-recomputed-on-every-session-change

- Symbol: WorkspaceModel constructor (session 'change' listener)
- Location at filing time: src/app/actions/public/workspace/model.ts:247
- Title: Scratch tab title is recomputed over the whole text on every session change
- Problem: The session 'change' listener calls scratchTitle(this.session.body, scratch.created) on every change event while a scratch note is open. That includes every keystroke (edit → #changed) and each save start and end. scratchTitle splits the whole text into a line array and runs the FENCE and HEADING regexes on each line until it finds a heading. For a text with no heading, such as pasted logs or plain prose, that is a full scan and an array allocation per keystroke, scaling with the note size. The title only changes when the first heading or first non-blank line changes. Typical scratch notes are small, so the cost is minor today.
- Fix: Recompute the title only when the body changed since the last computation (compare to the last body seen), or defer it to the autosave/'saved' point, or debounce it. Optionally make scratchTitle walk the lines without splitting the whole text.
- Fix prompt: In src/app/actions/public/workspace/model.ts, the session 'change' listener recomputes scratchTitle(session.body, created) on every change event, including save-state changes and each keystroke. Keep the last body and id the title was computed from, and skip the call when they are unchanged, so save-state changes cost nothing. Optionally have scratchTitle in src/shared/scratch.ts scan line by line with indexOf instead of text.split, so large texts without a heading allocate no line array per keystroke.

## issue-76/03: NoteSession models the open document as two nullable fields instead of one discriminated state

Run: issue-76
Slice: 03 "New Scratch Note opens and autosaves a scratch tab"
Review: 03-r1
Reviewed commit: e6ec60e8a653dd1868ca51d888400b6cddaf8c32

### [observation] thermo-session-note-scratch-optional-pair

- Symbol: NoteSession
- Location at filing time: src/app/actions/public/workspace/note-session.ts:67
- Title: NoteSession models the open document as two nullable fields instead of one discriminated state
- Problem: NoteSession now has `note: NoteDocument | null` and `scratch: ScratchNote | null`. Only an unwritten rule keeps at most one of them set. Every caller has to rebuild the 'something is open' fact by hand: `note || scratch` in workspace.tsx, `editing` in editor-pane.tsx, the two `#session.note || #session.scratch` close guards in Navigation.#loadActive, `(!this.note && !this.scratch)` in edit, `(this.note === null && this.scratch === null)` in flush, and the nested `note ? … : scratch ? … : undefined` ternary that picks the writer in #save. #replaces and relocationReplaces each gain a scratch-first early branch. The next document kind, or slice 04's inert features, has to add one more guard at each of these sites.
- Fix: Hold one `open: { kind: 'note'; note: NoteDocument } | { kind: 'scratch'; scratch: ScratchNote } | null` (or expose a single `get open()`/`isOpen` derived accessor). Switch on `open.kind` in #save, and let callers test `session.open !== null` instead of pairing the two fields.
- Fix prompt: In src/app/actions/public/workspace/note-session.ts, replace the parallel nullable `note` and `scratch` fields with one discriminated `open` state (note | scratch | null). At minimum, add a single `isOpen` getter. Make #save switch on the kind instead of using the nested ternary, and replace the hand-written `note || scratch` checks with the single state or getter: workspace.tsx line 225, editor-pane.tsx `editing`, Navigation.#loadActive's two close guards, NoteSession.edit and NoteSession.flush. Keep the behaviour unchanged; the existing navigation and note-session tests must pass.

## issue-76/03: Editor focus request travels two ways: an event and a pending slot that each pane must clear

Run: issue-76
Slice: 03 "New Scratch Note opens and autosaves a scratch tab"
Review: 03-r1
Reviewed commit: e6ec60e8a653dd1868ca51d888400b6cddaf8c32

### [observation] thermo-editor-focus-event-plus-pending-slot

- Symbol: WorkspaceModel.#focusEditor
- Location at filing time: src/app/actions/public/workspace/model.ts:287
- Title: Editor focus request travels two ways: an event and a pending slot that each pane must clear
- Problem: #focusEditor stores the request in #focusWanted and also dispatches it as an event. The editor pane's event listener has to call takeEditorFocus() only to clear the slot, so a pane that mounts later does not apply it a second time. A mounting pane also reads the slot. One request now has two delivery paths plus a clear-on-read rule. A request that no pane takes stays pending until some pane mounts later and applies it, possibly long after it stopped making sense.
- Fix: Use one channel. Either keep only the pending request, which the pane reads after each render or update, or keep only the event and have the workspace mount the pane before it dispatches.
- Fix prompt: In src/app/actions/public/workspace/model.ts and editor-pane.tsx, collapse the editor-focus request into a single mechanism. Prefer keeping only the pending #focusWanted slot: the editor pane takes it as it mounts and after each update, and the 'focus-editor' event plus its takeEditorFocus() call in the listener go away. Keep the e2e focus assertions in tests/e2e/scratch.spec.ts passing, both with a vault open and with none.

## issue-76/03: More scratch and focus state added to model.ts, which is already over 1000 lines

Run: issue-76
Slice: 03 "New Scratch Note opens and autosaves a scratch tab"
Review: 03-r1
Reviewed commit: e6ec60e8a653dd1868ca51d888400b6cddaf8c32

### [observation] thermo-model-ts-over-1000-lines-grows

- Symbol: WorkspaceModel
- Location at filing time: src/app/actions/public/workspace/model.ts:197
- Title: More scratch and focus state added to model.ts, which is already over 1000 lines
- Problem: model.ts was already more than 1000 lines before this slice and now has 1241. This slice adds new state and behaviour to it: the scratch title cache, scratchTabTitle, the focus-request slot with takeEditorFocus and #focusEditor, and newScratchNote. There is no plan for splitting the file. Slices 04 to 08 (banner, restore, save to vault, the scratch list) will each add more scratch logic to this file, so it keeps getting harder to read.
- Fix: Put the scratch-specific workspace state (title cache, newScratchNote) and the editor-focus request in their own small owner modules that the model composes, or record a plan for splitting model.ts before slices 04 to 08 add more scratch logic to it.
- Fix prompt: src/app/actions/public/workspace/model.ts is already more than 1000 lines (1241 now), and this slice adds scratch state to it (#scratchTitles, scratchTabTitle, newScratchNote) plus the #focusWanted/takeEditorFocus pair. Move the scratch tab title state and the editor-focus request into small dedicated modules (for example scratch-titles.ts and a focus-request helper) that WorkspaceModel composes, keeping WorkspaceModel's public methods the same so the existing tests pass. Or, if that waits, add a short split plan to docs/modernisation/PLAN.md.

## issue-76/04: Paste handler reads assetPlace() === undefined as a hidden 'cannot store images' flag

Run: issue-76
Slice: 04 "Scratch banner and vault-only features inert"
Review: 04-r1
Reviewed commit: 15a5c488b528c5eab7bbc5be6e7b956def9674b1

### [observation] thermo-paste-uses-asset-place-as-can-store-images-flag

- Symbol: pasteAndDrop paste handler
- Location at filing time: src/editor/paste.ts:226
- Title: Paste handler reads assetPlace() === undefined as a hidden 'cannot store images' flag
- Problem: EditorHost.assetPlace was a place key used to re-save images after a rename or move. This slice also makes `undefined` mean 'images cannot be stored' (config.ts docstring), and the paste handler branches on it to keep the selection. Two sources of truth now encode 'a scratch note takes no images': NoteSession.saveAsset's scratch branch (which owns the refusal and the notice) and the editor's assetPlace check, which infers it from `session().note?.id` being undefined. The handler still calls insertImages, which reaches saveAsset only to be rejected. If assetPlace is ever undefined for another reason (the default host in config.ts already returns undefined), selection-replace behaviour changes without notice.
- Fix: Give EditorHost an explicit capability, for example `canSaveAssets(): boolean`, wired in editor-pane from the session (false for a scratch note). In paste and drop, when it is false, skip the delete and the insertImages call and call the host's refusal once (or let saveAsset reject). Keep assetPlace for its original meaning only.
- Fix prompt: In src/editor/config.ts add `canSaveAssets(): boolean` to EditorHost (default host: false) and restore assetPlace's docstring to its place-key meaning only. In src/app/actions/public/workspace/editor-pane.tsx wire `canSaveAssets: () => session().note !== null`. In src/editor/paste.ts use `host.canSaveAssets()` instead of `assetPlace() !== undefined` to decide whether the pasted image replaces the selection. Keep the existing e2e and model tests passing.

## issue-76/04: Scratch rule buried in the generic togglePane

Run: issue-76
Slice: 04 "Scratch banner and vault-only features inert"
Review: 04-r1
Reviewed commit: 15a5c488b528c5eab7bbc5be6e7b956def9674b1

### [observation] thermo-toggle-pane-buried-scratch-guard

- Symbol: WorkspaceModel.togglePane
- Location at filing time: src/app/actions/public/workspace/model.ts:888
- Title: Scratch rule buried in the generic togglePane
- Problem: togglePane is a generic three-pane toggler, and it now carries one pane-and-document-specific exception: `if (pane === 'propertiesOpen' && this.session.scratch) return`. The 'Toggle Properties' command stays enabled in a scratch tab and silently does nothing. The rule that properties need a vault note is spread across togglePane, the hidden header in editor-pane and the banner text. It adds one more `session.scratch` check to the already deferred note/scratch optional pair.
- Fix: Have the caller that owns the toggle-properties command own the guard: disable or skip that command while a scratch note is open (one predicate such as `model.hasProperties`), and leave togglePane generic.
- Fix prompt: Remove the scratch check from WorkspaceModel.togglePane. Add one predicate on WorkspaceModel (for example `get propertiesAvailable(): boolean` = session.note !== null) and use it where the toggle-properties command is dispatched, and in editor-pane where the properties pane and button render, so the command is skipped (or disabled) in a scratch tab. Keep the Toggle Properties e2e test in tests/e2e/scratch.spec.ts passing.

## issue-76/05: Start-up restore reads every kept scratch note in full, one after another, just to check which ids exist

Run: issue-76
Slice: 05 "Scratch tabs come back after a restart"
Review: 05-r1
Reviewed commit: cb987a52c190af590ba55de6a192754d7b93c7ba

### [observation] performance-scratch-restore-waits-on-full-scratch-list

- Symbol: Navigation.#scratchExists
- Location at filing time: src/app/actions/public/workspace/navigation.ts:262
- Title: Start-up restore reads every kept scratch note in full, one after another, just to check which ids exist
- Problem: Navigation.restore runs inside hold() and awaits #scratchExists() before #loadActive(), so the active tab does not load until GET /api/scratch answers. That route (ScratchStore.list) does readFile + stat + readJsonFile for every kept scratch note in sequence and computes each title, and #scratchExists then uses only the ids. N is every kept scratch note on disk (slices 07 and 08 keep notes that have text), not just the few open tabs. The active scratch note is then read a second time by #loadActive. So start-up latency grows with the number of kept scratch notes and their size, even when only one scratch tab was open. The sequential-list problem itself is already deferred (thermo-scratch-list-reads-sequentially); this is about putting that call on the blocking start-up path for an existence check.
- Fix: Check only the stored ids: either read each stored id with readScratch in parallel (Promise.allSettled, a 404 means gone) and reuse the active one's result, or make the list route cheap (readdir only for existence, or parallel reads without the text). Keep the current behavior: report a non-404 failure and restore every kept tab.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, Navigation.#scratchExists currently calls this.#api.listScratch(), which in ScratchStore.list reads every kept scratch note's full text, stat and sidecar one after another, and the start-up restore waits for it before the active tab loads. Change the existence check so it costs only the stored ids: for example, call readScratch for each id in the stored ScratchTabsSnapshot in parallel with Promise.allSettled, treat an ApiError 404 NOT_FOUND as gone, report any other failure via this.#host.fail once and treat that id as existing. Keep the tests in tests/app/navigation.test.ts 'Navigation of scratch tabs' passing (gone ids dropped without a notice, every tab restored with the failure when the check fails, the held-request test adapted to hold the new request path).

## issue-76/05: The new noTabStore helper's scratch no-ops are copied inline into four other tab stores

Run: issue-76
Slice: 05 "Scratch tabs come back after a restart"
Review: 05-r1
Reviewed commit: cb987a52c190af590ba55de6a192754d7b93c7ba

### [observation] holistic-scratch-store-noops-copied-beside-notabstore

- Symbol: runMenuCommand on the workspace
- Location at filing time: tests/app/menu-commands.test.ts:136
- Title: The new noTabStore helper's scratch no-ops are copied inline into four other tab stores
- Problem: This slice adds `noTabStore` to tests/app/helpers.ts, but it also writes `loadScratch: () => null, saveScratch: () => {}` by hand into four more stores: tests/app/menu-commands.test.ts, tests/app/model.test.ts (two stores) and tests/app/relocation.test.ts. Those stores differ from noTabStore only in load and save. CODING_STANDARDS.md asks that a helper two app tests need lives in tests/app/helpers.ts rather than being copied into each test file. The next TabStore member, for example from slice 08, would have to be added in five places again.
- Fix: Build these stores as `{ ...noTabStore, load: …, save: … }`, so the scratch no-ops come from the one helper.
- Fix prompt: In tests/app/menu-commands.test.ts, tests/app/model.test.ts (the module-level `store` and the store in 'WorkspaceModel relocations that return after a vault switch') and tests/app/relocation.test.ts, import noTabStore from './helpers.ts'. Replace the inline `loadScratch: () => null, saveScratch: () => {}` members with a spread: `{ ...noTabStore, load: …, save: … }`, keeping each test's own load and save.

## issue-76/05: The e2e profile folder is derived in two places: launchApp's userDataDir and startApp's own path.join(root, 'profile')

Run: issue-76
Slice: 05 "Scratch tabs come back after a restart"
Review: 05-r1
Reviewed commit: cb987a52c190af590ba55de6a192754d7b93c7ba

### [observation] thermo-e2e-profile-path-computed-twice

- Symbol: startApp
- Location at filing time: tests/e2e/fixtures.ts:153
- Title: The e2e profile folder is derived in two places: launchApp's userDataDir and startApp's own path.join(root, 'profile')
- Problem: launchApp sets `userDataDir = path.join(root, 'profile')`, writes settings.json there and exposes it on AppHandle. startApp builds `--user-data-dir` again from `path.join(root, 'profile')`. relaunchApp passes app.dir, not app.userDataDir. If the profile location changes in only one of the two places, the relaunch would quietly start on another profile, and readSettings would read a different folder from the one the app uses.
- Fix: Have startApp take the profile folder (and the home folder) from its caller. Pass `userDataDir` from launchApp and `app.userDataDir` from relaunchApp, so the location is derived once.
- Fix prompt: In tests/e2e/fixtures.ts, change startApp(root, args) to take the profile path, for example startApp({ root, userDataDir }, args). Build `--user-data-dir=${userDataDir}` from it. Call it with launchApp's userDataDir and with app.userDataDir in relaunchApp. Remove the second path.join(root, 'profile').

## issue-76/05: #persist now tracks changes two ways (an #unsaved flag for note tabs, a serialized compare for scratch tabs) plus a restore-in-progress flag

Run: issue-76
Slice: 05 "Scratch tabs come back after a restart"
Review: 05-r1
Reviewed commit: cb987a52c190af590ba55de6a192754d7b93c7ba

### [observation] thermo-persist-two-dirty-tracking-schemes

- Symbol: Navigation.#persist
- Location at filing time: src/app/actions/public/workspace/navigation.ts:557
- Title: #persist now tracks changes two ways (an #unsaved flag for note tabs, a serialized compare for scratch tabs) plus a restore-in-progress flag
- Problem: Note tabs are saved when the boolean #unsaved is set. Scratch tabs are saved when JSON.stringify(scratchJSON()) differs from #savedScratch. A third field, #scratchRestoring, suppresses the scratch save while restore lists the notes, and restore reassigns #savedScratch partway through. These are three pieces of mutable state on Navigation for one persistence concern, and the two entries follow different rules for when they count as dirty.
- Fix: Use one rule for both entries. For example, compare each serialized entry against its last saved value, which removes #unsaved. Or keep the pending kept entry as a value that scratchJSON merges, so the restore flag and the mid-restore reassignment of #savedScratch go away.
- Fix prompt: Optional simplification in src/app/actions/public/workspace/navigation.ts: unify change detection in #persist. Either save each entry (the vault's TabsSnapshot and the ScratchTabsSnapshot) when its serialized form differs from the last saved one, which drops #unsaved, or keep the restore's pending entry in one field and drop #scratchRestoring. Keep the behaviour pinned by the 'keeps a scratch note created while the restore lists the scratch notes active…' navigation test.

## issue-76/06: [high] Scratch save route docs say it saves into "the open vault" and 409s only with none open, but it targets the ?vault= vault and 409s when that one is closed

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r6
Reviewed commit: 8d4b185a5ca8305b17a3c158bf643270262b4cc1

### [high] comments-scratch-save-docs-say-open-vault-not-named-vault

- Symbol: routes
- Location at filing time: src/app/routes.ts:78
- Title: Scratch save route docs say it saves into "the open vault" and 409s only with none open, but it targets the ?vault= vault and 409s when that one is closed
- Problem: src/app/routes.ts:78-79 | "the scratch note becomes a note in `folder` of the open vault and is removed (`ScratchSaveResult`); `409 NO_VAULT` without an open vault." Also src/app/actions/public/workspace/types.ts:112 ("the scratch note became note `id` in `folder` of the open vault") and src/app/actions/public/workspace/api.ts:207 ("main turns scratch note `id` into a note in `folder` of the open vault"). The scratchSave handler runs services.vaults.inVault(root, …) with root from `?vault=`: it saves into the vault the request names, not main's active vault, and answers 409 NO_VAULT when `?vault=` is missing or names a vault that is no longer open, even while another vault is open (tests/app/scratch.test.ts 'answers 409 NO_VAULT for a vault that is no longer open, even with another one active'). The sibling readerImport doc uses the same words "into the open vault" for main's active vault (importReader uses #active), so a reader takes scratchSave to behave the same way: a client written from this doc would expect the save to land in the active vault and a 409 only when no vault at all is open.
- Fix: Reword all three: e.g. routes.ts "Save to vault (`{ id, folder }`, in the vault `?vault=` names): the scratch note becomes a note in `folder` of that vault and is removed (`ScratchSaveResult`); `409 NO_VAULT` when `?vault=` is missing or that vault is not open." types.ts: "…became note `id` in `folder` of the vault the request named…". api.ts: "…into a note in `folder` of the page's vault (`?vault=`)…".
- Fix prompt: In src/app/routes.ts (scratchSave doc), src/app/actions/public/workspace/types.ts (ScratchSaveResult doc) and src/app/actions/public/workspace/api.ts (saveScratch doc), replace 'the open vault' with the vault named by ?vault= (the page's vault). In routes.ts also change '409 NO_VAULT without an open vault' to '409 NO_VAULT when ?vault= is missing or names a vault that is not open'. Match the wording of the scratchSave handler doc in src/app/actions/api/controller.ts.

## issue-76/06: Whether a vault switch ran during the save is decided by two tokens in two layers

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r1
Reviewed commit: a5afaa26426d5fcfe4346434597b2eff8fdd0f85

### [observation] thermo-save-scratch-vault-switch-decided-twice

- Symbol: WorkspaceModel.saveScratchToVault
- Location at filing time: src/app/actions/public/workspace/model.ts:522
- Title: Whether a vault switch ran during the save is decided by two tokens in two layers
- Problem: saveScratchToVault takes a vaultToken before the dialog and checks it twice inside the save callback: once to refuse the request, and once after the answer to decide whether to show the lists. Navigation.saveScratch takes its own vaultToken inside hold() and uses it to decide whether the tab is replaced or closed (`shown`). The model then reads `result.shown` to pick the info notice. Once the pre-request check has passed, the model's post-answer check and Navigation's `shown` answer the same question. So one decision, 'the note landed in the vault left', is computed twice and acted on in two places: lists in the model, tabs and notice split between Navigation and the model. A later change to one of them (for example, showing the left vault's lists) has to keep both in step.
- Fix: Let Navigation.saveScratch own the after-answer decision. Pass it a show(workspace) step, or have it return `shown` before any data is shown, and have the model call #showData only when `shown` is true. Keep only the pre-request token check in the model.
- Fix prompt: In src/app/actions/public/workspace/model.ts saveScratchToVault, remove the post-answer `if (sameVault()) this.#showData(saved.workspace)` from the save callback. Show the workspace from the value Navigation.saveScratch already computes: either show it after saveScratch returns when `result.shown` is true, or pass a show callback that Navigation.saveScratch (src/app/actions/public/workspace/navigation.ts) calls only when its own vaultToken still holds. Keep the pre-request check that throws when the vault changed while the folder was chosen. Keep the existing model.test.ts Save to vault tests passing.

## issue-76/06: Save to vault repeats Add to vault's whole flow, with a different rule for which vault it targets

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r1
Reviewed commit: a5afaa26426d5fcfe4346434597b2eff8fdd0f85

### [observation] thermo-save-scratch-copies-add-reader-skeleton

- Symbol: WorkspaceModel.saveScratchToVault
- Location at filing time: src/app/actions/public/workspace/model.ts:524
- Title: Save to vault repeats Add to vault's whole flow, with a different rule for which vault it targets
- Problem: saveScratchToVault repeats addReaderToVault step by step: a busy set claimed before the first await, #inOpenOrder, a `!this.data.vault` error notice, the same choose dialog (label 'Folder', folderOptions, dropFolder), leave(), attempt plus #snapshot plus #showData, and then turning the tab into the note's tab. The two have already drifted apart. Save to vault names the vault on screen (?vault=, VaultSession.inVault) and guards the dialog with a vault token. Add to vault imports into main's active vault (importReader uses #active) and has no token. So two 'put this tab into the vault' actions now have different policies for the same race, and a fix to the dialog or the gate order has to be made in both.
- Fix: Extract the shared part (open-order run, vault check, folder choose dialog, gate) into one private helper that takes the dialog's title and confirm label and answers the chosen folder or null. Decide once which vault-target rule both actions follow.
- Fix prompt: In src/app/actions/public/workspace/model.ts, extract a private helper, for example #chooseVaultFolder({ title, confirm, noVault }), that runs the vault check with its notice, opens the choose dialog with folderOptions and dropFolder, and answers the folder or null. Use it from both addReaderToVault and saveScratchToVault. Keep each action's own gate order and the request it sends. Note in the helper's doc which vault the chosen folder belongs to. Run tests/app/model.test.ts.

## issue-76/06: CreateNoteOptions gains a third optional field that silently overrides the other two

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r1
Reviewed commit: a5afaa26426d5fcfe4346434597b2eff8fdd0f85

### [observation] thermo-create-note-text-option-overrides-body-frontmatter

- Symbol: CreateNoteOptions
- Location at filing time: src/vault/vault.ts:120
- Title: CreateNoteOptions gains a third optional field that silently overrides the other two
- Problem: CreateNoteOptions now has body?, frontmatter? and text?. When text is set, body and frontmatter are ignored without any error. The two modes ('compose from parts' and 'take a whole note file, splice in the timestamps') live behind one bag of optional fields, and createNote branches on `options.text === undefined`. A caller passing both gets the body dropped and cannot see it from the type.
- Fix: Make the options a discriminated union ({ body?, frontmatter? } | { text }, with the other keys set to never), or give the whole-text mode its own method, for example createNoteFromText.
- Fix prompt: In src/vault/vault.ts, change CreateNoteOptions so that `text` cannot be combined with `body`/`frontmatter`. Use a union type where each branch sets the other keys to `?: never`, or split out a createNoteFromText(folder, title, text) method that shares the unique-stem and write steps. Update the scratchSave controller in src/app/actions/api/controller.ts. Run typecheck and tests/app/scratch.test.ts.

## issue-76/06: The frontmatter fence regexes are copied from parseNoteText instead of shared

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r1
Reviewed commit: a5afaa26426d5fcfe4346434597b2eff8fdd0f85

### [observation] thermo-frontmatter-fence-rule-duplicated-in-shared

- Symbol: withoutFrontmatter
- Location at filing time: src/shared/scratch.ts:21
- Title: The frontmatter fence regexes are copied from parseNoteText instead of shared
- Problem: withoutFrontmatter rewrites parseNoteText's opening and closing fence regexes and its lastIndex search (src/vault/frontmatter.ts:45-50) as a second copy. src/vault/note.ts:119 already has a third form of the same rule. Decision 15 asks for 'the same fence rule as parseNoteText'. With copies, a later change to the fences (for example the BOM that note.ts allows) would make the Save to vault title disagree with the frontmatter that createNote keeps.
- Fix: Move the fence split (find the open and close fences, without the YAML check) into one function in src/shared. Use it from withoutFrontmatter and from parseNoteText, so both read the same fences.
- Fix prompt: Add an exported function in src/shared (for example frontmatterFences(text): { open: RegExpExecArray-like span, close } | undefined) that finds a leading '---' line and a later '---'/'...' closing line, exactly as parseNoteText in src/vault/frontmatter.ts does now. Use it in src/shared/scratch.ts withoutFrontmatter and in parseNoteText, which keeps its YAML mapping check on top. Run tests/shared/scratch.test.ts and the vault frontmatter tests.

## issue-76/06: Save to vault's YAML layout check lives in vault.ts and repeats spliceYaml's simple-block-mapping preconditions

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r6
Reviewed commit: 8d4b185a5ca8305b17a3c158bf643270262b4cc1

### [observation] holistic-keep-typed-frontmatter-yaml-rules-outside-frontmatter-module

- Symbol: keepTypedFrontmatter
- Location at filing time: src/vault/vault.ts:1164
- Title: Save to vault's YAML layout check lives in vault.ts and repeats spliceYaml's simple-block-mapping preconditions
- Problem: Until now all YAML handling sat in src/vault/frontmatter.ts: parseYamlMapping, spliceYaml, updateYaml and serializeNoteText. This slice adds keepTypedFrontmatter to vault.ts, which makes vault.ts import `yaml` (parseDocument, isMap, isScalar) itself. The function runs its own copy of spliceYaml's preconditions: doc.errors empty, isMap, not flow, scalar keys. It also adds a null-key rule that spliceYaml does not have. Decision 16 rightly keeps the save off spliceYaml. Still, "is this a plain block mapping we can edit as text" is now decided in two modules, with rules that already differ: spliceYaml also needs `item.key.range`, and keepTypedFrontmatter also refuses null keys. A later fix to one of them, such as the alias and cycle handling that parseYamlMapping just gained, can easily miss the other.
- Fix: Move keepTypedFrontmatter next to the other YAML text functions in src/vault/frontmatter.ts and export it for createNote. Have it and spliceYaml share one helper that decides whether a block is a simple block mapping, so vault.ts no longer imports `yaml`.
- Fix prompt: Move keepTypedFrontmatter from src/vault/vault.ts to src/vault/frontmatter.ts, export it, and call it from Vault.createNote. Drop the `yaml` and `isDeepStrictEqual` imports from vault.ts if nothing else uses them. In frontmatter.ts, pull the block-mapping precondition (no doc errors, isMap, not flow, every key a scalar) into one helper. Use it from both spliceYaml and keepTypedFrontmatter, and keep keepTypedFrontmatter's extra non-null-key rule and its parse-equality check. Keep the behaviour unchanged; the tests in tests/app/scratch.test.ts for /api/scratch/save must still pass.

## issue-76/06: "A folder to save into, seeded by this test." restates the writeFiles call

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r6
Reviewed commit: 8d4b185a5ca8305b17a3c158bf643270262b4cc1

### [observation] comments-e2e-seeded-folder-comment-restates-code

- Symbol: a scratch tab comes back after a restart, active, with its text, and Save to vault turns it into a note’s tab
- Location at filing time: tests/e2e/scratch.spec.ts:185
- Title: "A folder to save into, seeded by this test." restates the writeFiles call
- Problem: tests/e2e/scratch.spec.ts:185 | "// A folder to save into, seeded by this test." | The next line `writeFiles(app.vault, { 'work/plan.md': … })` already says a file is written in work/, and the later selectOption('work') shows why. The comment adds nothing the code does not say.
- Fix: Delete the comment, or, if the reason for seeding before the restart matters, say that: "// Before the restart, so the relaunched vault lists the work/ folder."
- Fix prompt: In tests/e2e/scratch.spec.ts, delete the comment '// A folder to save into, seeded by this test.' above the writeFiles call (or replace it with a why, e.g. that it is seeded before the restart so the relaunched app lists work/).

## issue-76/06: saveScratch re-activates the previous tab to undo the activation that replaceScratch always does

Run: issue-76
Slice: 06 "Save scratch note to vault"
Review: 06-r8
Reviewed commit: 5c73424f559b6367093dbe4d646665d94e625f88

### [observation] thermo-save-scratch-undoes-replace-activation

- Symbol: Navigation.saveScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:431
- Title: saveScratch re-activates the previous tab to undo the activation that replaceScratch always does
- Problem: Tabs.#replace (src/app/actions/public/workspace/tabs.ts:362) always sets activeKey to the replacement tab. Navigation.saveScratch then records the old activeKey and calls tabs.activate(active) to undo that activation when the scratch tab was in the background. The rule 'replace in place, keep whichever tab was active' is spread across two layers: Tabs forces activation and the caller compensates. Any other caller that wants a background replace has to repeat the same capture-and-restore, and a change to activate() side effects (trail, history, persistence) would run for a tab switch the user never made.
- Fix: Let the replace keep the active tab as it is: in #replace, set activeKey to the new tab only when the replaced tab was the active one. Then drop the capture-and-restore in saveScratch.
- Fix prompt: In src/app/actions/public/workspace/tabs.ts, change #replace(key, kind, path) so it sets this.activeKey=<REDACTED> only when the replaced tab's key was the active key (or when the activeKey pointed at the `open` duplicate it removes). Check the existing replaceReader callers still get the activation they expect: a reader tab being replaced is the active one in those paths. In Navigation.saveScratch (src/app/actions/public/workspace/navigation.ts), remove `const active = this.tabs.activeKey` and `if (active !== null && active !== tab.key) tabs.activate(active)`. Keep the tests in tests/app/model.test.ts ('turns the scratch tab into the note’s tab in the background…') passing.

## issue-76/07: #switch gains a one-caller `then` hook that runs the scratch discard round trips while the editor is locked, before the next tab loads

Run: issue-76
Slice: 07 "Closing an empty scratch tab deletes it"
Review: 07-r1
Reviewed commit: 95234d4377728ce2c2a8f5b7d41a8d5ceb662a0c

### [observation] thermo-switch-then-hook-and-locked-discard

- Symbol: Navigation.#switch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:590
- Title: #switch gains a one-caller `then` hook that runs the scratch discard round trips while the editor is locked, before the next tab loads
- Problem: The generic #switch now takes a `then` callback, and only close uses it. The callback runs for every active-tab close, and the `tab?.kind !== 'scratch'` check is buried inside it. It also awaits #discardBlank (a read and a discard over the network) inside hold, before #loadActive. The session stays locked and the next tab does not load until both requests finish. Only `this.#session.close()` has to run before #loadActive. The discard does not depend on loading the next tab.
- Fix: Push the condition up and move the discard out of the hold. Inside the change (or a small scratch-specific step), close the session when it holds the closed scratch note. After `await this.#switch(...)`, call #discardBlank only when the closed tab is a scratch tab. Drop the `then` parameter from #switch.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, remove the `then` parameter from #switch. In #close's active-tab branch, release the closed scratch note from the session inside the change passed to #switch, for example `(tabs) => { tabs.close(key); if (tab?.kind === 'scratch' && this.#session.scratch?.id === tab.id) this.#session.close() }`. Then, after `await this.#switch(...)` returns, run `if (tab?.kind === 'scratch') await this.#discardBlank(tab.id, report)`. That way the next tab loads and the editor unlocks without waiting on the discard. Check that the existing scratch close tests in tests/app/navigation.test.ts still pass, including the next-tab-read-fails case.

## issue-76/07: `expect(id).toHaveLength(32)` asserts nothing about the behaviour under test

Run: issue-76
Slice: 07 "Closing an empty scratch tab deletes it"
Review: 07-r1
Reviewed commit: 95234d4377728ce2c2a8f5b7d41a8d5ceb662a0c

### [observation] thermo-test-filler-assertion-on-id-length

- Symbol: discards a blank scratch note when its active tab closes and the next tab’s read fails, leaving the editor without it
- Location at filing time: tests/app/navigation.test.ts:914
- Title: `expect(id).toHaveLength(32)` asserts nothing about the behaviour under test
- Problem: The test keeps `id` only to assert its length, which slice 01 already pins. The assertion exists so the variable is used, and it adds noise to a behaviour test.
- Fix: Assert something the behaviour owns, such as `expect(await scratchIds()).not.toContain(id)`, or drop the binding.
- Fix prompt: In tests/app/navigation.test.ts, in the test 'discards a blank scratch note when its active tab closes and the next tab’s read fails, leaving the editor without it', remove `expect(id).toHaveLength(32)`. Either call scratchAfterA() without binding its result, or replace the assertion with one tied to the discard, such as `await expect(api.readScratch(id)).rejects.toMatchObject({ status: 404 })`.

## issue-76/07: The 'release the scratch note from the session, then discard it if blank' step is written out in two close branches

Run: issue-76
Slice: 07 "Closing an empty scratch tab deletes it"
Review: 07-r2
Reviewed commit: c79db317df58faa3cc78c9ec8b82c36414a4083e

### [observation] thermo-scratch-release-and-discard-repeated-per-close-branch

- Symbol: Navigation.#close
- Location at filing time: src/app/actions/public/workspace/navigation.ts:329
- Title: The 'release the scratch note from the session, then discard it if blank' step is written out in two close branches
- Problem: The fix adds a third scratch-specific branch to #close. Both the new background held branch (lines 326-335) and the active-close `then` callback run the same two steps: `if (this.#session.scratch?.id === tab.id) this.#session.close()` followed by `await this.#discardBlank(tab.id, report)`. The plain background branch runs the discard step a third time. The rule 'a closed scratch tab's note leaves the session and is discarded when blank' now lives in three places. The new branch exists only because #loadActive leaves a scratch note in the session behind a note tab whose read failed, so the close path has to work around that state.
- Fix: Move the shared step into one helper, for example `#releaseScratch(id, report)`, which closes the session when it holds `id` and then calls #discardBlank. Call it from all three branches. A further option is to have #loadActive release a scratch note the session holds once its tab is no longer active, which would let the held background branch go away.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, add a private method `#releaseScratch(id: string, report: LoadReport)` that runs `if (this.#session.scratch?.id === id) this.#session.close()` and then `await this.#discardBlank(id, report)`. Use it in Navigation.#close in place of the repeated session-close plus #discardBlank calls: in the held background branch inside hold, in the plain background branch, and in the active-close `then` callback. Keep the current behaviour and the existing tests in tests/app/navigation.test.ts as they are.

## issue-76/08: Start-up lists every scratch note twice when scratch tabs are restored

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r1
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] performance-restore-lists-scratch-notes-twice

- Symbol: WorkspaceModel.restoreTabs
- Location at filing time: src/app/actions/public/workspace/model.ts:467
- Title: Start-up lists every scratch note twice when scratch tabs are restored
- Problem: When the last run left scratch tabs open, Navigation.restore already calls GET /api/scratch (#scratchExists) to filter the ids, and restoreTabs then calls refreshScratch, which sends the same GET /api/scratch again right after. Each listing makes ScratchStore.list read every kept scratch note in full, one after another (readFile + stat + sidecar read per note). So at start-up the whole scratch folder is read twice, and the first result is used only for its ids and then dropped.
- Fix: Reuse the listing restore already made: have Navigation.restore (or #scratchExists) hand the ScratchSummary[] it fetched to the model, so it can set #scratchListed from it, and call refreshScratch only when restore did not list (no stored scratch tabs, or the listing failed).
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, make the scratch listing that Navigation.restore runs through #scratchExists available to the host. For example, return the ScratchSummary[] from restore, or pass it to a host callback. In WorkspaceModel.restoreTabs (src/app/actions/public/workspace/model.ts), store that list as #scratchListed (bumping #scratchListings so an older listing is dropped) and call refreshScratch() only when restore made no listing (no stored scratch tabs, or listScratch failed). Keep the existing model test 'lists the kept scratch notes once the tabs are restored' passing.

## issue-76/08: Welcome screen repeats ScratchList's own empty check, and each check rebuilds the list

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r1
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] react-ts-welcome-scratch-list-empty-check-duplicated

- Symbol: Workspace
- Location at filing time: src/app/actions/public/workspace/workspace.tsx:220
- Title: Welcome screen repeats ScratchList's own empty check, and each check rebuilds the list
- Problem: The welcome screen wraps ScratchList in `model.scratchNotes.length > 0 ? … : null`, but ScratchList already returns null when `model.scratchNotes` is empty. So the 'show nothing while no scratch note is kept' rule lives in two places. `scratchNotes` is a getter that maps every listed note into a new object on each access, so each welcome render builds the array twice only to test its length. The wrapper exists only to keep the `recentStyle` box from rendering empty.
- Fix: Put the wrapper's styling inside ScratchList (for example a `mix`/class prop, or a variant), or keep the length check in one place only, and read `scratchNotes` once per render.
- Fix prompt: In src/app/actions/public/workspace/workspace.tsx the welcome screen renders `{model.scratchNotes.length > 0 ? <div mix={recentStyle}><ScratchList model={model} /></div> : null}`, while ScratchList (scratch-list.tsx) already returns null for an empty list. Remove the duplicated emptiness rule: either let ScratchList take the extra container style (for example an optional `mix` prop applied to its <section>) and render `<ScratchList model={model} mix={recentStyle} />` unconditionally, or drop ScratchList's own early return and keep the check only at the call sites. Make sure the scratchNotes getter is read once per render.

## issue-76/08: discardScratch writes out close's 'let the session go, close the tab, load the next one' steps again

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r1
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] thermo-discard-scratch-repeats-close-release-and-load

- Symbol: Navigation.discardScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:489
- Title: discardScratch writes out close's 'let the session go, close the tab, load the next one' steps again
- Problem: Navigation.discardScratch adds its own copy of the steps that #close already runs in three branches: release the scratch note from the session when it holds it, close the tab, then #loadActive when the tab was active or the session held it, else host.changed(). It also computes its own gate condition (holdsOther) before hold and recomputes tab, held and wasActive inside it. The rule for how a scratch tab leaves the strip and the session now lives in four places, which can drift. For example, #close's active branch goes through #switch, but discardScratch calls #edit plus #loadActive directly.
- Fix: Factor the 'scratch tab leaves: release from the session, close the tab, load what is active' step into one private Navigation helper used by #close's scratch branches and by discardScratch. discardScratch then flushes, deletes and calls the helper.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, extract one private method that takes a scratch id, releases it from the session when held, closes its tab when open, and loads the active tab when that tab was active or the session held it (else host.changed()). Use it in discardScratch and in #close's scratch branches in place of the inline copies. Keep the existing tests in tests/app/model.test.ts and navigation.test.ts passing.

## issue-76/08: "// Saved: its row goes." restates the refreshScratch call below it

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r1
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] comments-saved-its-row-goes-restates-refresh

- Symbol: WorkspaceModel.saveScratchToVault
- Location at filing time: src/app/actions/public/workspace/model.ts:614
- Title: "// Saved: its row goes." restates the refreshScratch call below it
- Problem: src/app/actions/public/workspace/model.ts:614 | "// Saved: its row goes." | The next line `if (result) await this.refreshScratch()` already says the list is read again after a save that ran, and refreshScratch's own doc lists Save to vault among its callers. The comment adds nothing the code and that doc do not say.
- Fix: Delete the comment.
- Fix prompt: In src/app/actions/public/workspace/model.ts, in saveScratchToVault, delete the line comment "// Saved: its row goes." above `if (result) await this.refreshScratch()`. Change nothing else.

## issue-76/08: `stay = !unmoved()` reads as a double negative for 'the active tab moved'

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r2
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] thermo-save-scratch-stay-unmoved-inverted-names

- Symbol: Navigation.saveScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:518
- Title: `stay = !unmoved()` reads as a double negative for 'the active tab moved'
- Problem: saveScratch now carries two tokens, sameVault and unmoved, and derives `stay = !unmoved()`, which is true when the active tab did change. The name says what the code then does with the old active tab, not what was observed, so the guard `if (stay && active !== null && active !== tab.key)` needs both names decoded to read.
- Fix: Name the observation directly, e.g. `const moved = !unmoved()` (or have the token answer `moved`), and use `if (moved && …) tabs.activate(active)`.
- Fix prompt: In Navigation.saveScratch (src/app/actions/public/workspace/navigation.ts), rename `stay` to `moved` (const moved = !unmoved()) and update its one use, so the guard reads 'when the active tab moved while save was out, keep it active'.

## issue-76/08: rows/strip test helper comments restate their mapping expressions

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r2
Reviewed commit: ca843d71cd747de8a4dd14da904ee0e80b7d57da

### [observation] comments-scratch-list-test-helpers-restate-code

- Symbol: WorkspaceModel scratch list
- Location at filing time: tests/app/model.test.ts:533
- Title: rows/strip test helper comments restate their mapping expressions
- Problem: tests/app/model.test.ts:533 and :535 | "/** The scratch list as rows: id and title. */" and "/** The strip: note tabs by path, scratch tabs by id, reader tabs by kind. */" | Each comment only repeats the one-line mapping right below it (`scratchNotes.map(({ id, title }) => ({ id, title }))` and the tab.kind ternary that picks path, id or kind). They tell the reader nothing the code doesn't already say.
- Fix: Delete both doc comments; the helper names and their one-line bodies say the same thing.
- Fix prompt: In tests/app/model.test.ts, in the 'WorkspaceModel scratch list' describe block, delete the comment lines "/** The scratch list as rows: id and title. */" and "/** The strip: note tabs by path, scratch tabs by id, reader tabs by kind. */" above the rows and strip helpers. Leave the helpers unchanged.

## issue-76/08: The rule for showing the no-vault scratch panel is written twice: once for the grid attribute, once for the aside

Run: issue-76
Slice: 08 "Scratch list: reopen, save or discard kept notes"
Review: 08-r3
Reviewed commit: 52f9b3f55ea33621351690de4f1b131797da10b3

### [observation] holistic-scratch-panel-condition-spelled-twice

- Symbol: Workspace
- Location at filing time: src/app/actions/public/workspace/workspace.tsx:254
- Title: The rule for showing the no-vault scratch panel is written twice: once for the grid attribute, once for the aside
- Problem: The new layout depends on two separate copies of one condition. data-scratch-panel (line 254) checks `!vault && model.tabs.tabs.length > 0 && model.scratchNotes.length > 0` and switches the grid to the '"scratch editor"' template. The <aside> (lines 265-272) is rendered by a different expression: the `model.tabs.tabs.length > 0` branch of the vault ternary, plus its own `model.scratchNotes.length > 0` check. ScratchList then checks the empty list a third time. If one copy changes and the other does not (for example, the panel is also hidden when its list is empty for another reason), the grid either reserves an empty 220px 'scratch' column or auto-places the aside into the editor's row. Each check also calls the scratchNotes getter, which rebuilds the array each time.
- Fix: Work out the panel condition once per render, for example `const scratchPanel = !vault && model.tabs.tabs.length > 0 && model.scratchNotes.length > 0`. Use it for both the data-scratch-panel attribute and the aside.
- Fix prompt: In src/app/actions/public/workspace/workspace.tsx, inside the Workspace render function, compute the no-vault scratch panel condition once. For example: `const scratchPanel = !vault && model.tabs.tabs.length > 0 && model.scratchNotes.length > 0`. Use that value for `data-scratch-panel={scratchPanel ? '' : undefined}` and to decide whether to render the <aside aria-label="Scratch notes">. Then the grid template and the panel element cannot drift apart. Keep the behaviour the same.

## issue-76/09: The 'two hotkeys never share an accelerator' rule is written twice: savePreferences and the startup registration

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r1
Reviewed commit: a217febd19bcaf46ccd059244d233941b3439386

### [observation] thermo-hotkey-distinct-rule-in-two-places

- Symbol: app ready handler (hotkey registration)
- Location at filing time: src/main/main.ts:230
- Title: The 'two hotkeys never share an accelerator' rule is written twice: savePreferences and the startup registration
- Problem: savePreferences (src/app/actions/api/preferences.ts) refuses a patch whose next captureHotkey equals next globalHotkey. main.ts startup repeats the same rule by hand (`ui.captureHotkey=<REDACTED> ui.globalHotkey`) for a hand-edited settings.json, and then still keeps the duplicate value stored, so the dialog later shows a capture hotkey that is stored but never registered. The invariant about stored settings lives in two callers instead of in the settings model that owns validity (normalizeUi / UI_FIELDS).
- Fix: Make the invariant part of the stored-settings model: normalizeUi drops captureHotkey to '' when it equals globalHotkey, so settings.ui can never hold the pair. The startup code then just registers ui.captureHotkey when it is non-empty, and savePreferences keeps only its 409 check for incoming patches.
- Fix prompt: In src/main/settings.ts normalizeUi, after normalising each field, set captureHotkey to '' when it is non-empty and equal to globalHotkey (the show/hide hotkey wins, as main.ts's comment says today). Then simplify the startup block in src/main/main.ts to `if (ui.captureHotkey !== '' && !preferences.setCaptureHotkey(ui.captureHotkey)) console.warn(...)`, dropping the equality check and its comment. Add a normalizeUi case to tests/app/preferences.test.ts ('normalises stored settings field by field') for { globalHotkey=<REDACTED> captureHotkey=<REDACTED> } → captureHotkey ''.

## issue-76/09: Per-hotkey registered state is two parallel named fields, so the recorder re-branches on the field name

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r1
Reviewed commit: a217febd19bcaf46ccd059244d233941b3439386

### [observation] thermo-hotkey-registered-flags-parallel-fields

- Symbol: HotkeyRecorder
- Location at filing time: src/app/actions/public/workspace/preferences-dialog.tsx:98
- Title: Per-hotkey registered state is two parallel named fields, so the recorder re-branches on the field name
- Problem: HotkeyRecorder is keyed by field (HOTKEYS[field], model.preferences[field]) but the registered flag is not: it needs `field === 'globalHotkey' ? model.hotkeyRegistered=<REDACTED> The pair hotkeyRegistered/captureHotkeyRegistered is copied field by field through PreferencesState, preferencesState(), the WorkspaceModel constructor and WorkspaceModel.savePreferences. A third global hotkey would add a field at each site plus another ternary arm.
- Fix: Keep the existing hotkeyRegistered contract if it must stay, but derive the recorder's lookup from a field-keyed source, e.g. a small `registeredOf(model, field)` map in HOTKEYS (`registered: (model) => model.hotkeyRegistered`) or a `registered: Record<'globalHotkey' | 'captureHotkey', boolean>` in PreferencesState.
- Fix prompt: In src/app/actions/public/workspace/preferences-dialog.tsx, add a `registered: (model: WorkspaceModel) => boolean` entry to each HOTKEYS row (model.hotkeyRegistered for globalHotkey, model.captureHotkeyRegistered for captureHotkey) and replace the `field === 'globalHotkey' ? … : …` ternary in HotkeyRecorder with `texts.registered(model)`, so the recorder stays fully table-driven.

## issue-76/09: The default PreferencesState literal is copied into eleven WorkspaceModel constructions, and this slice had to edit each

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r1
Reviewed commit: a217febd19bcaf46ccd059244d233941b3439386

### [observation] thermo-preferences-state-literal-copied-per-model-test

- Symbol: WorkspaceModel vault switches
- Location at filing time: tests/app/model.test.ts:62
- Title: The default PreferencesState literal is copied into eleven WorkspaceModel constructions, and this slice had to edit each
- Problem: Adding captureHotkeyRegistered meant editing the same `{ ui: DEFAULT_UI, hotkeyRegistered=<REDACTED> …, update: null }` literal in model.test.ts (7 places), menu-commands.test.ts, image-paste-relocation.test.ts and relocation-editor.test.ts. CODING_STANDARDS.md asks that what two app tests need lives in tests/app/helpers.ts; every future PreferencesState field repeats this shotgun edit.
- Fix: Add one shared default (for example `defaultPreferences(ui = DEFAULT_UI): PreferencesState`) to tests/app/helpers.ts and use it in every WorkspaceModel construction.
- Fix prompt: In tests/app/helpers.ts export `function preferencesOf(ui: UiPreferences = DEFAULT_UI): PreferencesState { return { ui, hotkeyRegistered=<REDACTED> captureHotkeyRegistered=<REDACTED> update: null } }`. Replace the inline PreferencesState literal in every `new WorkspaceModel(...)` in tests/app/model.test.ts, menu-commands.test.ts, image-paste-relocation.test.ts and relocation-editor.test.ts with `preferencesOf()` (or `preferencesOf({ ...DEFAULT_UI, confirmDelete })` in the scratch list start helper).

## issue-76/09: isHotkey doc restates its one-line expression

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r1
Reviewed commit: a217febd19bcaf46ccd059244d233941b3439386

### [observation] comments-is-hotkey-doc-restates-expression

- Symbol: isHotkey
- Location at filing time: src/main/settings.ts:107
- Title: isHotkey doc restates its one-line expression
- Problem: src/main/settings.ts:107 | "/** A global hotkey preference: an accelerator, or `''` for none. */" | The private helper on the next line is `typeof value === 'string' && (value === '' || isAccelerator(value))`, which says exactly this. The comment adds nothing the name and expression do not already say.
- Fix: Delete the comment; the name isHotkey and its expression carry the meaning.
- Fix prompt: In src/main/settings.ts, delete the JSDoc line `/** A global hotkey preference: an accelerator, or `''` for none. */` above `const isHotkey`. Change nothing else.

## issue-76/09: HOTKEYS doc restates the object below it

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r1
Reviewed commit: a217febd19bcaf46ccd059244d233941b3439386

### [observation] comments-hotkeys-doc-restates-object

- Symbol: HOTKEYS
- Location at filing time: src/app/actions/public/workspace/preferences-dialog.tsx:64
- Title: HOTKEYS doc restates the object below it
- Problem: src/app/actions/public/workspace/preferences-dialog.tsx:64 | "/** The global hotkey preferences, and the texts of each one's recorder. */" | The private const right below is keyed by globalHotkey and captureHotkey with legend/turnedOff/none strings, and HotkeyRecorder's `field: keyof typeof HOTKEYS` shows how it is used. The comment only describes the shape the reader sees on the next lines.
- Fix: Delete the comment; the object literal and its use in HotkeyRecorder say what it holds.
- Fix prompt: In src/app/actions/public/workspace/preferences-dialog.tsx, delete the JSDoc line `/** The global hotkey preferences, and the texts of each one's recorder. */` above `const HOTKEYS`. Change nothing else.

## issue-76/09: One route test runs three Arrange/Act/Assert cycles (register, refuse, turn off)

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r5
Reviewed commit: b27ecf982b3d1e6d768e78121a3245a47be61b10

### [observation] testing-capture-hotkey-route-test-three-act-phases

- Symbol: registers a Quick capture hotkey, refuses one the OS does not grant, and turns it off with an empty value
- Location at filing time: tests/app/preferences.test.ts
- Title: One route test runs three Arrange/Act/Assert cycles (register, refuse, turn off)
- Problem: Rule 8 (Arrange / Act / Assert). This test saves a free capture hotkey, then a taken one, then '' in one body, so its arrange, act and assert steps are interleaved three times. Each later phase depends on the state the earlier one left. A failure in the first phase hides whether the refusal and turn-off behaviours hold, and the test name lists three requirements. The sibling 'refuses a Quick capture hotkey equal to the show/hide hotkey, and the reverse' test runs two acts the same way.
- Fix: Split it into three tests (stores and answers a free capture hotkey; a taken one answers 409, stores nothing and keeps the previous one; '' turns it off), each arranging its own starting state and following Arrange / Act / Assert.
- Fix prompt: In tests/app/preferences.test.ts, split the test 'registers a Quick capture hotkey, refuses one the OS does not grant, and turns it off with an empty value' into three tests, each following Arrange / Act / Assert. (1) POST { captureHotkey=<REDACTED> } stores it, the response and GET preferences answer it with captureHotkeyRegistered true, and settings.json has it. (2) With 'CommandOrControl+Alt+J' already saved and 'Control+Shift+F6' in app.takenHotkeys, POST { captureHotkey=<REDACTED> theme: 'light' } answers the 409 HOTKEY_UNAVAILABLE body, leaves captureHotkey and theme as stored, and leaves registeredCaptureHotkey as 'CommandOrControl+Alt+J'. (3) With a capture hotkey saved, POST { captureHotkey=<REDACTED> } answers captureHotkeyRegistered false and clears both the registration and the stored value. Keep every existing assertion.

## issue-76/09: savePreferences writes each hotkey rule out twice, once per hotkey, with the field names swapped

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r5
Reviewed commit: b27ecf982b3d1e6d768e78121a3245a47be61b10

### [observation] thermo-save-preferences-mirrored-hotkey-blocks

- Symbol: savePreferences
- Location at filing time: src/app/actions/api/preferences.ts:67
- Title: savePreferences writes each hotkey rule out twice, once per hotkey, with the field names swapped
- Problem: The generic preferences save now holds two mirrored equality guards (captureHotkey against current/next globalHotkey, then globalHotkey against current/next captureHotkey), two registration steps that are written differently (`hotkeyChanged && !setHotkey(next.globalHotkey)` vs an inline `patch.captureHotkey !== registeredCaptureHotkey && !setCaptureHotkey(patch.captureHotkey)`), and a compensation step that runs in one direction only. The rules (never share an accelerator, register before storing, undo earlier registrations when a later one is refused) are about the pair of hotkeys, but they are spelled out field by field inside the save. The two registration steps already differ in shape (one reads next.*, the other patch.*), and a third hotkey, or a change to the order or the rollback, would mean editing every mirrored block by hand.
- Fix: Describe the hotkeys once, as a small table of { field, set, registered, otherLabel }, and run the equality check, the ordered registration and the rollback of already-registered entries as one loop over that table, so each rule is written once.
- Fix prompt: In src/app/actions/api/preferences.ts savePreferences, replace the two mirrored equality `if` blocks and the two differently shaped registration steps with one list of the two hotkeys (field name, the PreferenceServices setter, the registered getter, and the label used in the 'is already the … hotkey' message). Loop over it once to refuse a patched hotkey equal to the other hotkey (current or as patched) before registering anything, then loop again to register each changed hotkey in order, and when one is refused, set every hotkey this loop already changed back to its previous registered value before throwing the 409. Keep the existing messages and the behaviour the tests in tests/app/preferences.test.ts pin.

## issue-76/09: "The Quick capture recorder is the group right after the show/hide one." restates the assertions below it

Run: issue-76
Slice: 09 "Quick capture global hotkey"
Review: 09-r5
Reviewed commit: b27ecf982b3d1e6d768e78121a3245a47be61b10

### [observation] comments-e2e-recorder-order-comment-restates-assertions

- Symbol: Preferences records a Quick capture hotkey beside the show/hide hotkey, and says why a taken one is refused
- Location at filing time: tests/e2e/scratch.spec.ts:427
- Title: "The Quick capture recorder is the group right after the show/hide one." restates the assertions below it
- Problem: tests/e2e/scratch.spec.ts:427 | "// The Quick capture recorder is the group right after the show/hide one." | The next three lines assert exactly this: two groups, groups.nth(0) named 'Show/hide Boostnote from anywhere' and groups.nth(1) named 'Quick capture: a new scratch note from anywhere'. The comment adds nothing the assertions do not already say.
- Fix: Delete the comment.
- Fix prompt: In tests/e2e/scratch.spec.ts, in the test 'Preferences records a Quick capture hotkey beside the show/hide hotkey, and says why a taken one is refused', delete the line '// The Quick capture recorder is the group right after the show/hide one.' The group count and nth(0)/nth(1) accessible-name assertions below it already state the order.

## issue-76/11: [high] Quick capture / New Scratch Note closes the Import and Title renames dialogs while they are busy, so their result and any error are lost

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [high] bug-new-scratch-closes-busy-import-and-title-renames-dialogs

- Symbol: WorkspaceModel.newScratchNote
- Location at filing time: src/app/actions/public/workspace/model.ts:743
- Title: Quick capture / New Scratch Note closes the Import and Title renames dialogs while they are busy, so their result and any error are lost
- Problem: src/app/actions/public/workspace/model.ts:742-744 | newScratchNote now sets preferencesOpen, importOpen and titleRenamesOpen to false without checking whether the dialog is busy. Both dialogs refuse to close while their work runs: ImportDialog disables Cancel and ignores Esc while `busy` (import-dialog.tsx:116, :205), and TitleRenamesDialog does the same while it plans or applies renames (title-renames-dialog.tsx:168, :189, :194). The reason is that the outcome is shown only inside the dialog: the import's summary, warnings, report path, its error message and the 'Open vault' button (import-dialog.tsx run/result), and the renames report or its error ('Save or resolve the open note first.', or a failed applyTitleRenames). Failure scenario: the user starts a long Import of a Boostnote storage (or clicks 'Rename N files'), switches to another app, and presses the Quick capture hotkey (or picks File > New Scratch Note). The dialog unmounts at once; the import or the renames keep running in main, but when they finish or fail nothing tells the user: no summary, no 'Open vault', and an error is swallowed silently. The user cannot tell whether the import happened. The same applies to the Preferences dialog when a save is out: its refusal message (409 HOTKEY_UNAVAILABLE) is only shown in the dialog. Conditions: a capture (or the menu command) while one of these dialogs has work in flight.
- Fix: Do not close a dialog whose work is still running. Either leave Import and Title renames open while they are busy (keep them on top and skip the editor focus, as the code already does for an 'Update links?' question), or move the busy state into the model (for example importBusy / titleRenamesBusy flags the dialogs set) so newScratchNote can skip closing them, or report the outcome through the notice when the dialog is closed mid-work.
- Fix prompt: In src/app/actions/public/workspace/model.ts WorkspaceModel.newScratchNote, the unconditional `this.importOpen = false` and `this.titleRenamesOpen = false` close the Import and Title renames dialogs even while they are running an import or a rename, and those dialogs keep their result and error only in their own component state (they disable Cancel and Esc while busy for that reason). Make the model know when either dialog is busy (for example a busy flag the dialog sets through a model method when its run/apply starts and clears when it ends), and in newScratchNote leave a busy dialog open; in that case still create the scratch note but do not move the editor focus behind the dialog (as is already done for an open 'Update links?' question, `!this.dialog`). Add a WorkspaceModel test: mark the import dialog busy, call newScratchNote, and assert importOpen stays true and the editor focus is not requested; and one where it is not busy and it closes as now.

## issue-76/11: Open scratch note's title is re-derived from the whole text on every scratchNotes / scratchTabTitle access, several times per render

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] performance-scratch-title-recomputed-per-getter-access

- Symbol: WorkspaceModel.scratchNotes
- Location at filing time: src/app/actions/public/workspace/model.ts:304
- Title: Open scratch note's title is re-derived from the whole text on every scratchNotes / scratchTabTitle access, several times per render
- Problem: The carried title-cache rework moved scratchTitle from the session 'change' listener (once per change) into the render-time readers. scratchTabTitle runs scratchTitle(session.body, created) for the open scratch note on every call, and the scratchNotes getter calls it again and builds a new array on every access while a scratch note is open. One render reads these several times: tab-strip.tsx:62 (scratchTabTitle), scratch-list.tsx:17, and with no vault workspace.tsx:254 and :268 (scratchNotes.length checks only). Every keystroke in a scratch tab fires 'change' and so a render. Each render therefore does 2 to 4 full splits of the text into lines plus regex scans when the text has no heading (pasted logs, prose), where before it did one per change. The deferred 03-r1 observation was about one scan per change; this change multiplies it by the number of readers. Typical scratch notes are small, so the cost is small, but it grows with note size times readers.
- Fix: Compute the open scratch note's title once per text change and keep it with the body it was computed from (for example a small memo keyed on session.body and scratch.created), and have scratchTabTitle and scratchNotes read that value. Let scratchNotes return a cached array that changes only when #scratchListed or the memoized title changes, and use the listed count for the presence checks.
- Fix prompt: In src/app/actions/public/workspace/model.ts, add a private memo for the open scratch note's title: keep the last { body, created, title }, and run scratchTitle again only when session.body or session.scratch.created differs from the stored values. Make scratchTabTitle return the memoized title for the open scratch note. Make the scratchNotes getter return a cached array that is rebuilt only when #scratchListed or the memoized title changes, so the several reads in one render (tab-strip.tsx, scratch-list.tsx, workspace.tsx) neither scan the text again nor allocate new arrays. The workspace.tsx `.length > 0` checks can read the listed count instead.

## issue-76/11: Every scratch-changing hold, and each queued Quick capture, waits on a full sequential scratch listing before it resolves

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] performance-hold-awaits-full-scratch-relist

- Symbol: Navigation.hold
- Location at filing time: src/app/actions/public/workspace/navigation.ts:219
- Title: Every scratch-changing hold, and each queued Quick capture, waits on a full sequential scratch listing before it resolves
- Problem: hold's finally now awaits #relistScratch, which awaits host.scratchChanged → WorkspaceModel.refreshScratch → GET /api/scratch. ScratchStore.list reads, stats and reads the sidecar of every kept scratch note in sequence. So every hold that changed the scratch set resolves only after a full listing. For New Scratch Note this sits on the critical path twice. newScratchNote awaits navigation.newScratch() before #focusEditor, so the cursor lands in the new editor only after the list answers. And newScratch's #scratchCreates queue chains on `run` (the hold promise), so a second Quick capture press cannot start its create until the first press's full listing is done. Rapid captures then pay N full scans of the scratch folder in series. Before this slice the model refreshed after newScratch too, but the next create did not queue behind it. The latency grows with the number and size of kept scratch notes.
- Fix: Do not await the relist inside hold's resolution: start it without awaiting it (`void this.#relistScratch().catch(...)`, coalesced through the existing stale flag and refreshScratch's listing counter), so the hold, the editor focus and the next queued New Scratch Note do not wait on GET /api/scratch.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, hold's finally block currently does `await this.#relistScratch()`, and #relistScratch awaits host.scratchChanged(), which is WorkspaceModel.refreshScratch awaiting GET /api/scratch (ScratchStore.list reads every kept scratch note one after another). Because newScratch chains on `run` through #scratchCreates, each queued New Scratch Note (a second Quick capture press) waits for the previous one's full listing, and newScratchNote's #focusEditor waits for it too. Start the relist without awaiting it in hold's finally (for example `void this.#relistScratch().catch((error: unknown) => this.#host.fail(error))`), relying on the #scratchListStale flag and refreshScratch's #scratchListings counter to coalesce and drop stale listings. Keep the create-and-show ordering in #scratchCreates. Do the same for the other awaited #relistScratch calls where the caller does not need the list to be fresh before it resolves, and update tests that await the relist through these calls.

## issue-76/11: The page's refresh when a save answers without lists has no model test

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-save-to-vault-missing-lists-refresh-untested

- Symbol: WorkspaceModel.saveScratchToVault
- Location at filing time: src/app/actions/public/workspace/model.ts:629
- Title: The page's refresh when a save answers without lists has no model test
- Problem: The route now answers { id } with no workspace when main cannot read the lists after the save, and saveScratchToVault then calls this.refresh() (a failure becomes the error notice). The route side is tested ('answers the saved note’s id without lists…'), but no model test drives a save whose answer has no workspace. If the else branch were dropped, the sidebar would not show the new note after such a save, and no test would fail.
- Fix: Add a WorkspaceModel test that makes vault.listTrash reject once during /api/scratch/save, runs saveScratchToVault, and asserts that the scratch tab became the note's tab, that no error notice shows, and that workspace.data.notes lists the new note.
- Fix prompt: In tests/app/model.test.ts, describe 'WorkspaceModel Save to vault of a scratch note', add a test. Set up scratchBetweenNotes('# Listed\n') and spy vi.spyOn(app.vaults.current!, 'listTrash').mockRejectedValueOnce(new Error('EIO')). Call workspace.saveScratchToVault(id), answer chooseFolder(''), and await it. Assert that the active tab is the note 'Listed.md', that workspace.notice is null, and that workspace.data.notes contains 'Listed.md'.

## issue-76/11: newScratchNote cancelling an open confirm dialog (resolve(false)) is untested

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-new-scratch-cancels-confirm-dialog-untested

- Symbol: WorkspaceModel.newScratchNote
- Location at filing time: src/app/actions/public/workspace/model.ts:747
- Title: newScratchNote cancelling an open confirm dialog (resolve(false)) is untested
- Problem: newScratchNote resolves an open confirm dialog with false and any other non-links dialog with null. The new test opens only a prompt, so the confirm branch never runs. If it resolved a confirm with null or true, a pending confirm (for example the Discard confirmation) would get a non-boolean or a confirmed answer when Quick capture fires, and nothing would fail.
- Fix: Add a case with a pending confirm and assert that it resolves to false.
- Fix prompt: In tests/app/model.test.ts, next to 'closes Preferences, Import, Title renames and an open prompt before a new scratch note takes the focus', add a test that starts a confirm dialog through the model (for example discardScratch of a kept note with confirmDelete on), calls await workspace.newScratchNote(), and asserts that the discard did not happen (the kept scratch note still exists), that workspace.dialog is null, and that the active tab is the new scratch tab.

## issue-76/11: No test pins that a scratch tab close makes one conditional discard instead of a read and then a discard

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-close-blank-check-single-request-unpinned

- Symbol: Navigation.#discardBlank
- Location at filing time: src/app/actions/public/workspace/navigation.ts
- Title: No test pins that a scratch tab close makes one conditional discard instead of a read and then a discard
- Problem: Carried item 07-r1:thermo-blank-check-split-into-read-then-discard moved the blank check into main (discard with ifBlank). The route tests exercise ifBlank directly, and the Navigation close tests check only the outcome (file gone or kept). The old two-request path (readScratch, then discardScratch) gives the same outcomes, so a revert to it, together with its race window where a write landing between the two requests is lost, passes every test.
- Fix: In a Navigation close test, record the requests (heldClient or a spy) and assert that the close sends one POST /api/scratch/discard with ifBlank and no GET /api/scratch/read.
- Fix prompt: In tests/app/navigation.test.ts, in a test that closes a blank background scratch tab, record the request paths the client sends during navigation.close (for example with net.hold matching '/api/scratch/read' and asserting net.held stays empty, or by spying on api.readScratch) and assert that no /api/scratch/read is sent and that exactly one /api/scratch/discard is sent.

## issue-76/11: New test file cleans up its temp folder in afterEach instead of using `await using`

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-scratch-store-temp-dir-manual-cleanup

- Location at filing time: tests/app/scratch-store.test.ts:28
- Title: New test file cleans up its temp folder in afterEach instead of using `await using`
- Problem: Rule 7: scratch-store.test.ts creates a temp folder in beforeEach and removes it in afterEach. An async-disposable temp-folder helper (Symbol.asyncDispose, as tests/lint/e2e-rules.test.ts already does) would tie the cleanup to each test.
- Fix: Use an `await using` temp-folder helper in each test.
- Fix prompt: In tests/app/scratch-store.test.ts, replace the beforeEach mkdtemp and afterEach rm of `dir` with an async-disposable temp-folder helper (as in tests/lint/e2e-rules.test.ts) used through `await using` in each test. Keep the reset of failing.rename and holding.rename.

## issue-76/11: Flow-mapping note save tests only check that the result parses back, not that the typed comment survives

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] test-validity-flow-map-save-asserts-parse-back-only

- Symbol: %s and parses back as the new frontmatter, keeping the body
- Location at filing time: tests/vault/frontmatter.test.ts:115
- Title: Flow-mapping note save tests only check that the result parses back, not that the typed comment survives
- Problem: tests/vault/frontmatter.test.ts:115 | flow-mapping cases | Each case only asserts that parseNoteText(text) gives `after` and the body. The raw block carries a comment ('{a: 1} # c'), and updateYaml's re-emit path claims to keep comments. If flow-mapping saves fell back to stringifyMapping(after), dropping the comment and the typed layout, every case would still pass, because a fresh emit also parses back to `after`.
- Fix: Assert the exact text in the 'adds a key' case (or at least that the written YAML still contains '# c' in the add and change cases), so a fallback that rewrites the block and drops the user's comment fails.
- Fix prompt: In tests/vault/frontmatter.test.ts, describe 'frontmatter as a flow mapping, on a note save', strengthen the 'adds a key' and 'changes a key' cases. Besides the parse-back check, assert that `text` still contains '# c' (expect(text).toContain('# c')), or assert the exact text the current implementation writes. A regression that writes flow-mapping frontmatter anew with stringifyMapping, dropping the comment, must then fail.

## issue-76/11: The route-level write/discard race test finds the window by setImmediate offsets, so it catches a missing serialisation only by timing

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] test-validity-route-write-discard-race-timing-based

- Symbol: lets no write racing a discard bring the scratch note back, and answers 404 to a write after it
- Location at filing time: tests/app/scratch.test.ts:185
- Title: The route-level write/discard race test finds the window by setImmediate offsets, so it catches a missing serialisation only by timing
- Problem: tests/app/scratch.test.ts:185 | The test starts a write and sends the discard after 0–15 setImmediate turns. It hopes one offset puts the discard between writeFileAtomic's beforeReplace check and its rename. Those steps are thread-pool fs calls, so where each offset lands depends on the machine. Whether the route test fails without ScratchStore's #serial depends on timing. Acceptance criterion 4 names the TestApp routes for this behaviour.
- Fix: Make the route test deterministic. Hold the rename of the .md file the same way scratch-store.test.ts does (vi.mock of node:fs/promises rename), send the discard route while the write route waits on it, then release it. Keep the loop only as extra coverage, if at all.
- Fix prompt: In tests/app/scratch.test.ts, replace or add to the setImmediate loop in 'lets no write racing a discard bring the scratch note back, and answers 404 to a write after it' with a deterministic version. Use a vi.mock of node:fs/promises whose rename waits on a promise for the target `${id}.md`, as tests/app/scratch-store.test.ts does. Start POST /api/scratch/write, wait until the rename is reached, POST /api/scratch/discard, release the rename, then assert that the scratch folder is empty, that list() is [], and that a later write answers 404 NOT_FOUND.

## issue-76/11: The ScratchStore write/discard race test releases the held rename without first showing the discard is queued

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] test-validity-scratch-store-race-releases-without-barrier

- Symbol: keeps a discard sent while a write waits on its rename from being undone by that rename
- Location at filing time: tests/app/scratch-store.test.ts
- Title: The ScratchStore write/discard race test releases the held rename without first showing the discard is queued
- Problem: tests/app/scratch-store.test.ts | keeps a discard sent while a write waits on its rename… | The test calls store.discard(id) and releases the held rename at once, without checking how far the discard has got. Without #serial, most orderings still fail: the rename resurrects the .md, or write's #read answers 404, or #read re-creates the sidecar after the discard removed it. One ordering passes, though: the write's rename and its whole #read finish before the discard's two rm calls, and the discard then removes both files. Whether the mutant is caught then depends on how the fs thread pool orders the work, not on a barrier the test controls.
- Fix: Add a barrier that proves the discard is queued behind the held rename before it is released. For example, also hold (or record) the discard's first fs call, and assert that it has not started while the rename is held. Or wait a few event-loop turns with the rename held and assert that the .md and .json files are both still there, then release the rename.
- Fix prompt: In tests/app/scratch-store.test.ts, test 'keeps a discard sent while a write waits on its rename from being undone by that rename': before calling release(), wait a few turns (for example `for (let i = 0; i < 5; i++) await setImmediate()` from node:timers/promises) with the rename still held, and assert that readdir(dir) still lists both `${id}.json` and `${id}.md`. That proves discard did not start removing files while the write was mid-rename. Then release and keep the existing assertions. With #serial bypassed, the discard's rm calls run during the wait, so the mid-test assertion fails every time instead of depending on how the thread pool orders the work.

## issue-76/11: The vault-queue Save to vault test does not hold the close, so a save run outside the queue can still get 409 by timing

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] test-validity-vault-queue-test-races-close-realpath

- Symbol: waits in the vault queue: a close queued first makes it answer 409 NO_VAULT, keeping the scratch note
- Location at filing time: tests/app/scratch.test.ts:495
- Title: The vault-queue Save to vault test does not hold the close, so a save run outside the queue can still get 409 by timing
- Problem: tests/app/scratch.test.ts:495 | waits in the vault queue… | The test starts app.vaults.close(first.root) and at once posts the save. VaultSession.close awaits realpath before it deletes the vault from #vaults. If inVault ran its task outside #exclusive, the save's lookup would race close's realpath against the route's body parsing. Usually the lookup wins and the save answers 201, so the test fails. But when close deletes the vault first, the lookup misses, the save still answers 409 NO_VAULT, and the mutant passes. Nothing holds close, so whether the queue mutant is caught depends on timing.
- Fix: Gate close at a controllable boundary (for example spy on the vault's close() and hold it), start the save, assert it is still pending while close is held, then release and expect 409 NO_VAULT.
- Fix prompt: In tests/app/scratch.test.ts, test 'waits in the vault queue: a close queued first makes it answer 409 NO_VAULT, keeping the scratch note': hold the close inside the queue. For example, vi.spyOn(first, 'close') with an implementation that awaits a promise the test resolves. Start app.vaults.close(first.root), start the save request without awaiting it, wait a few turns, and assert that the save has not settled yet (for example a `settled` flag stays false). Then release the close, await both, and keep the 409 NO_VAULT and file assertions. If inVault stops wrapping its task in #exclusive, the save then settles while close is held, and the test fails every time.

## issue-76/11: Scratch list freshness is a dirty flag set by hand at eight mutation sites

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-scratch-list-stale-flag-set-by-hand

- Symbol: Navigation
- Location at filing time: src/app/actions/public/workspace/navigation.ts:138
- Title: Scratch list freshness is a dirty flag set by hand at eight mutation sites
- Problem: Moving the list refresh from the model wrappers into Navigation fixes ownership. But the signal is a mutable `#scratchListStale` flag that each scratch-changing path has to set itself: `#scratchGone`, `restore`, `#discardBlank` and its 404 branch, `newScratch`, `#discard`, `saveScratch` and `#loadScratch`'s 404 branch. `#relistScratch` is then called by hand on the paths that run outside a hold: the background close, the unheld `discardScratch` branch and `#scratchGone`. A new path that creates or removes a scratch note through `#api` without setting the flag, or that runs outside a hold without calling `#relistScratch`, leaves the list stale, and nothing points that out. The 'what changed the scratch set' rule is spread across the class again, now as flag writes.
- Fix: Have one place mark the list stale: the scratch-mutating API calls. For example, route `createScratch`, `discardScratch` and `saveScratch` (and the 404 outcomes of `readScratch`/`writeScratch`) through small Navigation helpers that set the flag. Or wrap `#api` once in the constructor so every scratch mutation marks it. Make `hold`'s finally the one relist point, with the unheld paths running their request inside a gate-free, lock-free scope that ends in the same relist.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, remove the hand-written `this.#scratchListStale = true` assignments from #scratchGone, restore, #discardBlank, newScratch, #discard, saveScratch and #loadScratch. Instead, mark the list stale in one place that every scratch mutation goes through: for example a private helper per scratch API call (create, discard, save) that sets the flag after the call settles (success or 404), plus one helper for the 'found gone' outcome. Then make the explicit #relistScratch calls on unheld paths (background close, unheld discardScratch, #scratchGone) go through one shared 'after a transition' step instead of being repeated. Keep the existing Navigation and model tests for the list refresh passing.

## issue-76/11: Recursive-alias check is a throwaway JSON.stringify of every parsed frontmatter

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-cycle-check-by-json-stringify

- Symbol: parseYamlMapping
- Location at filing time: src/vault/frontmatter.ts:74
- Title: Recursive-alias check is a throwaway JSON.stringify of every parsed frontmatter
- Problem: parseYamlMapping now serialises the whole mapping (`JSON.stringify(value)`) and throws the result away, only to make a cyclic value throw into the catch. parseNoteText calls this for every note read, render, import, migrate and index entry, so each parse does a full extra serialisation. The intent, 'no cycles', is hidden behind a side effect that a reader can take for dead code and delete. The file already has a JSON round-trip helper at line 9, so 'serialisable' is now encoded twice in different shapes.
- Fix: Name the rule: add a small `isAcyclic`/`hasCycle` check (a WeakSet walk over objects and arrays), or reuse the line-9 JSON clone helper once with a named intent, and call that instead of the bare stringify.
- Fix prompt: In src/vault/frontmatter.ts parseYamlMapping, replace the bare `JSON.stringify(value)` with a named check, for example `if (hasCycle(value)) return undefined`, where hasCycle walks objects and arrays with a WeakSet of the ancestors on the current path. Keep the existing api.test.ts and scratch.test.ts recursive-alias cases passing.

## issue-76/11: newScratchNote enumerates every modal flag and dialog kind itself

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r1
Reviewed commit: 9c733119c4d045e06c76c31886e1fc80ed10d53e
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-new-scratch-closes-modals-by-hand

- Symbol: WorkspaceModel.newScratchNote
- Location at filing time: src/app/actions/public/workspace/model.ts:742
- Title: newScratchNote enumerates every modal flag and dialog kind itself
- Problem: To keep the focused editor out from under a modal, newScratchNote resets preferencesOpen, importOpen and titleRenamesOpen one by one, then resolves the dialog per kind (false for confirm, null otherwise, and it leaves links alone). The modal state is three parallel booleans plus a dialog union, and this is the first caller that needs to know all of them. A modal added later (a new panel flag or dialog kind) stays open behind a captured note unless someone remembers to edit this command. model.ts is already over 1000 lines (a deferred observation), and this adds more cross-cutting state knowledge to it.
- Fix: Give the model one owner of 'dismiss whatever modal is open', for example `#dismissModals({ keep: 'links' })` next to the dialog machinery, so the knowledge of which flags and dialog kinds exist lives beside their declarations.
- Fix prompt: In src/app/actions/public/workspace/model.ts, move the modal-closing lines at the top of newScratchNote into a private method next to #showDialog/the panel flags, for example `#dismissModals()`. It closes preferences, import and title renames, cancels a prompt, confirm or choose dialog with its cancel value, and keeps an "Update links?" question. Call it from newScratchNote. Keep the existing model tests 'closes Preferences, Import, Title renames and an open prompt…' and the links-question tests passing.

## issue-76/11: A background scratch tab's title after its text was retitled and saved has no test

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-background-scratch-tab-title-after-save-untested

- Symbol: WorkspaceModel constructor (session change listener)
- Location at filing time: src/app/actions/public/workspace/model.ts:259
- Title: A background scratch tab's title after its text was retitled and saved has no test
- Problem: The carried title-cache rework removed #scratchTitles. A scratch tab that is not open now takes its title from its #scratchListed row, and the new 'change' listener is the only thing that copies the open scratch note's last saved title into that row. Switching to another tab is not a scratch-changing transition, so no relist runs. Example: New Scratch Note (listed blank as 'Scratch …'), type '# Groceries', activate a note tab. The scratch tab's title is then 'Groceries' only because of that patch. No test reaches this path. The model tests check scratchTabTitle only for the open scratch note, or for one restored from a fresh listing. The rows test 'lists a new scratch note, follows its title as typed…' reads the row only while the note is open, and after a close, which relists. The e2e tests check a tab title only after a restart. If the patch were dropped or wrong, the background tab would go back to its stale listed title (decision 3 says the tab title follows scratchTitle), and every test would still pass.
- Fix: Add a model test: open a new scratch note, edit it to '# Groceries\n', activate another tab so the gate saves it, then assert that scratchTabTitle(id) is 'Groceries' and that the row's title is 'Groceries', with no refreshScratch in between.
- Fix prompt: In tests/app/model.test.ts, describe 'WorkspaceModel scratch list', add a test. Call start(false), then await workspace.newScratchNote() and take id = workspace.session.scratch?.id. Call workspace.session.edit('# Groceries\n'), then await workspace.activateTab(workspace.tabs.tabs[0]?.key ?? -1) so the gate saves the text and the scratch tab goes to the background. Do not call refreshScratch. Assert that workspace.session.scratch is null, workspace.scratchTabTitle(id) is 'Groceries', and rows() equals [{ id, title: 'Groceries' }]. The test must fail if the session 'change' listener in the WorkspaceModel constructor stops copying scratch.title and updated into #scratchListed.

## issue-76/11: The unheld Discard branch for a tab that became active or held while the request was out has no test

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-unheld-discard-tab-activated-meanwhile-untested

- Symbol: Navigation.discardScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:535
- Title: The unheld Discard branch for a tab that became active or held while the request was out has no test
- Problem: discardScratch now sends the discard without a hold for a scratch note that has no tab or only a background tab. After the request it checks `shown`: the tab became active, or the session came to hold the note, while the request was out (for example, the user clicked the background tab). In that case it closes the tab and loads the next one inside a hold through #closeDiscarded. The new tests cover only the plain no-tab and background-tab cases. None holds /api/scratch/discard and activates the scratch tab meanwhile. If the `shown` branch were dropped, the code would close an active tab through #edit without loading the next one, and leave the session on a deleted scratch note. That reproduces the stuck-session state this slice fixes elsewhere, and no test would fail.
- Fix: Add a Navigation or model test that holds the discard of a background scratch tab's note, activates that tab, releases the discard, and asserts that the tab is gone, the session does not hold the scratch note and the next tab is loaded.
- Fix prompt: In tests/app/model.test.ts, describe 'WorkspaceModel scratch list', add a test. Call start(false), then keptScratch('# Groceries\n'), then workspace.openScratch(id), then activate tab 0 so the scratch tab is in the background. Call net.hold(onPath('/api/scratch/discard'), { once: true }) and start workspace.discardScratch(id) without awaiting it. Wait for net.held.length to be 1, then await workspace.activateTab(<the scratch tab's key>) and release the held request. Await the discard. Assert that strip() is ['meeting.md'], workspace.session.scratch is null, workspace.session.note?.id is 'meeting.md' and workspace.scratchNotes is []. The test must fail if the `if (shown)` branch in Navigation.discardScratch is removed.

## issue-76/11: The refreshScratch test runs two Arrange/Act/Assert cycles in one body

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-refresh-scratch-test-two-act-phases

- Symbol: drops a listing that returns after a later one, and shows a failed listing as the error notice
- Location at filing time: tests/app/model.test.ts:893
- Title: The refreshScratch test runs two Arrange/Act/Assert cycles in one body
- Problem: Rule 8 (Arrange / Act / Assert). This one test body runs two separate behaviours in sequence: it drops a stale listing (hold, discard, release, assert), then shows a failed listing as the error notice (fail, refresh, assert). The test name joins two requirements with 'and'. A failure in the first half hides whether the second behaviour holds.
- Fix: Split the test into two: one for the out-of-order listing that is dropped, one for the failed listing that shows the error notice.
- Fix prompt: In tests/app/model.test.ts, split 'drops a listing that returns after a later one, and shows a failed listing as the error notice' into two tests, each with one Arrange / Act / Assert: (1) 'drops a listing that returns after a later one' (hold the first /api/scratch, discard, release, assert scratchNotes is []); (2) 'shows a failed scratch listing as the error notice' (net.fail on /api/scratch, await refreshScratch, assert the error notice).

## issue-76/11: A scratch save's 404 starts a separate, unawaited transition from inside whatever transition's gate is flushing

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-scratch-gone-fire-and-forget-transition

- Symbol: Navigation.#scratchGone
- Location at filing time: src/app/actions/public/workspace/navigation.ts:168
- Title: A scratch save's 404 starts a separate, unawaited transition from inside whatever transition's gate is flushing
- Problem: NoteSession dispatches 'scratchgone' from inside #saveScratch, and that usually runs inside leave()'s flush, so inside the gate of an outer #switch or hold. #scratchGone then closes the tab itself and starts its own hold(#loadActive), and nothing awaits it (`void done.catch(...)`). The outer transition goes on regardless. For example, Cmd+W on the active gone scratch tab: #scratchGone closes the tab and loads its neighbour. The outer #switch's tabs.close(key) then finds no tab, the then-hook's ifBlank discard sends a request that answers 404, and #loadActive runs a second time for the same neighbour. Activating another tab gives two loads racing, sorted out only by tokens. The rule 'a gone scratch tab closes with the notice and the next tab loads' is also written twice: here and in #loadScratch's 404 branch (report.missing, close, #loadActive). The two copies already differ (host.notify against report.missing, a conditional load, their own failure routing). One state change now has two owners that run at the same time.
- Fix: Let the outcome travel back to the transition that is running instead of starting a second one. For example, flush/leave() reports the gone id, and the caller (hold or #switch) closes that tab and lets its own #loadActive load the next one. The 404 then goes through one helper that #loadScratch's 404 branch also uses. Only a save outside any transition (an autosave) needs to start its own hold.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, stop #scratchGone from starting its own unawaited hold(#loadActive) while an outer transition's gate is flushing. Pull the 'close the gone scratch tab with the notice, mark the list stale' step into one private helper, and use it from both #scratchGone and #loadScratch's 404 branch. When #scratchGone fires while a hold is running (this.#holds > 0), only close the tab and let the running transition's #loadActive load the active tab. Start hold(() => this.#loadActive(), { gate: false }) only when no hold runs (an autosave). Keep the Navigation tests for a deleted scratch note passing: the switch-after-404 test and the Cmd+W close of a gone scratch tab.

## issue-76/11: The background scratch close re-implements hold's 'save the tabs after the work' by hand through a new #edit save:false switch

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-background-close-persists-tabs-by-hand

- Symbol: Navigation.#close
- Location at filing time: src/app/actions/public/workspace/navigation.ts:393
- Title: The background scratch close re-implements hold's 'save the tabs after the work' by hand through a new #edit save:false switch
- Problem: To keep the active note editable, the plain background scratch close no longer uses hold. It passes the new `{ save: false }` to #edit, awaits #discardBlank, calls #relistScratch itself, and then runs `if (this.#holds === 0) this.#persist()`. That copies the end of hold (save the tabs once the work is done, relist the scratch notes) without the lock, and only this caller uses the new #edit option. When the tabs get saved is now decided three ways: by hold, by #edit right away, and by hand in #close. The next path that needs 'deferred save, no lock' (discardScratch's unheld branch is already close to it) has to copy all three steps again in the same order.
- Fix: Give hold one option that skips the lock (for example `{ gate: false, lock: false }`), or add a small #deferred(run) helper that runs the work and then does hold's persist and relist. Then the background close and discardScratch's unheld branch both go through it, and #edit loses its `save` option.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, remove the `{ save = true }` option from #edit, and the hand-written `await this.#relistScratch(); if (this.#holds === 0) this.#persist()` at the end of the background scratch close in #close. Add one way to run work that defers the tab-store save and the scratch relist like hold, without session.lock(true). For example, add a `lock` option to hold (`hold(run, { gate: false, lock: false })`) that counts the work for #persist and #relistScratch but does not lock the session. Use it for the background close and for discardScratch's unheld branch. Keep the tests that check the active note stays editable during a background scratch close, and that a throwing tab store rejects the close after the blank note is gone.

## issue-76/11: ScratchStore's failure and race tests have to vi.mock the whole node:fs/promises module

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-scratch-store-failure-tests-mock-fs-module

- Symbol: ScratchStore.create
- Location at filing time: tests/app/scratch-store.test.ts:14
- Title: ScratchStore's failure and race tests have to vi.mock the whole node:fs/promises module
- Problem: ScratchStore calls node:fs/promises directly, and calls it again through writeFileAtomic and writeJsonFile in src/vault/files.ts. So the new tests for a failed create and for a write racing a discard replace `rename` across the whole module with hoisted global switches (failing.rename, holding.rename) and pick the target by matching file names. The fake reaches every rename in the process, src/vault code included. It depends on writeFileAtomic doing its replace through a rename, and the switches must be reset in afterEach. A change in how files.ts writes (copyFile, or a handle-based write) makes these tests pass without testing anything, or break, even though ScratchStore did not change.
- Fix: Inject the file operations ScratchStore uses (a small { writeFileAtomic, writeJsonFile, rm, readFile, stat } port, defaulting to the real ones) through its constructor, so a test passes a port that fails or holds one call, and the module mock goes away.
- Fix prompt: In src/app/scratch-store.ts, give the ScratchStore constructor an optional second parameter with the file operations it uses: writeFileAtomic, writeJsonFile, readJsonFile, isFile, rm, readFile, stat, readdir. It defaults to the current imports. In tests/app/scratch-store.test.ts, remove the vi.mock('node:fs/promises') block and the hoisted failing/holding switches. Instead, construct the store with a port whose writeFileAtomic fails for the .md file (the create test) or waits on a promise the test controls (the race test). Keep both tests' assertions the same.

## issue-76/11: Save to vault tests copy the choose-dialog answering steps inline instead of reusing chooseFolder

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-model-test-choose-dialog-steps-copied

- Symbol: opens the saved note’s tab in the background when another tab was activated while a row with no tab saved
- Location at filing time: tests/app/model.test.ts:920
- Title: Save to vault tests copy the choose-dialog answering steps inline instead of reusing chooseFolder
- Problem: The Save to vault describe already has a chooseFolder helper. The new scratch-list tests still spell out the same four steps by hand each time: poll for a 'choose' dialog, read workspace.dialog, narrow it with a throw, and resolve it. The file now has about nine such inline copies (lines 389, 461, 507, 709, 735, 920, 939 and 957). So the dialog's shape is pinned in two ways: chooseFolder checks its title, options and value, and the inline copies check nothing about it. A change to how the dialog is shown or answered has to be made at every copy.
- Fix: Move the dialog-answering helper to the file's top level, as answerChoose(folder, value?) built from chooseFolder, and use it in every Save to vault test in both describes.
- Fix prompt: In tests/app/model.test.ts, move chooseFolder (now inside describe('WorkspaceModel Save to vault of a scratch note')) to the file's top level, or turn it into an `answerFolder(folder, { value })` helper. Replace each inline 'await expect.poll(() => workspace.dialog?.kind).toBe("choose"); const dialog = workspace.dialog; if (dialog?.kind !== "choose") throw …; dialog.resolve(…)' block in describe('WorkspaceModel scratch list') and in the Save to vault describe with a call to it. Keep each test's assertions.

## issue-76/11: A Navigation race test fakes session.flush with a call-order counter instead of holding the request

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r3
Reviewed commit: 8940aa3a1f339545ca0b2ede1870c64a9c8c8480
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-navigation-test-spies-flush-call-order

- Symbol: loads the next tab when a held scratch tab closes while an activate of it waits on the same gate
- Location at filing time: tests/app/navigation.test.ts:1384
- Title: A Navigation race test fakes session.flush with a call-order counter instead of holding the request
- Problem: The test gets the race it needs by replacing session.flush with vi.spyOn and a three-state counter ('waiting' | 'gated' | 'done'). The counter assumes the close's gate is the next flush call after the activate starts, and it holds that call after the real flush resolves. That ties the test to how many times, and in what order, Navigation calls the private gate inside #switch and hold. If a transition gains or loses one flush (for example the background close changing between hold and no hold, which this slice already did), the test holds the wrong call. It then passes without testing the race, or fails for an unrelated reason. Every other race test in this file controls timing at the network boundary (net.hold).
- Fix: Drive the ordering through the network boundary the other Navigation tests use (net.hold on the /api/scratch/write of the activate's gate), not by counting session.flush calls.
- Fix prompt: In tests/app/navigation.test.ts, rewrite 'loads the next tab when a held scratch tab closes while an activate of it waits on the same gate' without vi.spyOn(session, 'flush'). Hold the scratch write with net.hold((url) => url.pathname === '/api/scratch/write' ? 'write' : undefined). Start navigation.activate(scratchKey) and then navigation.close(scratchKey) while the write is held. Release the write and await both. Keep the final assertions: the tabs are ['note'], session.scratch is null, session.note is a.md, the session is not locked and the scratch file is kept.

## issue-76/11: The 'folder removed while it loaded' branch of the new stat check has no test

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r4
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-reader-folder-removed-while-loading-untested

- Symbol: VaultSession.openReaderFolder
- Location at filing time: src/main/vault-session.ts:169
- Title: The 'folder removed while it loaded' branch of the new stat check has no test
- Problem: The fix decides 'gone' versus 'keep the message' by stat(root). The two new tests cover a folder that is still there (the overlap, so the message is kept) and a folder that became a regular file (stats.isDirectory() is false, so the answer is gone). No test removes the folder outright while #load runs. That case goes through the stat rejection handler `() => false`. If that handler answered true, or the rejection escaped the catch, a reader folder deleted during the load would answer openVault's NOT_A_VAULT message, which holds the full path, instead of 'readme.md is gone; open it again'. Every test would still pass. The older symlink test does not reach this catch, because its load succeeds and fails later on the root check.
- Fix: Add a VaultSession test like the 'became a file' one, where the beforeRealpath hook only renames (or removes) the folder, and expect NOT_FOUND 'readme.md is gone; open it again'.
- Fix prompt: In tests/main/vault-session.test.ts, next to '"Open folder as vault" answers "gone" without the path when the folder became a file while it loaded', add a test that sets fsHooks.beforeRealpath = { path: loose, run: () => rename(loose, `${loose}-moved`) }, so the folder is missing when openVault resolves it. Then expect session.openReaderFolder(ticket) to reject with { code: 'NOT_FOUND', message: 'readme.md is gone; open it again' }, and expect fsHooks.beforeRealpath to be undefined. This pins the stat-rejection branch (`() => false`) in VaultSession.openReaderFolder's catch.

## issue-76/11: The 'names the overlap' test checks only the error code, not the overlap message

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] test-validity-reader-folder-overlap-message-unasserted

- Symbol: "Open folder as vault" names the overlap when the file's folder holds the scratch notes' folder
- Location at filing time: tests/main/vault-session.test.ts:432
- Title: The 'names the overlap' test checks only the error code, not the overlap message
- Problem: tests/main/vault-session.test.ts | "Open folder as vault" names the overlap… | The test asserts code NOT_A_VAULT and that the message is not the 'gone' text. It never checks that the message is the overlap text the title promises. Any other NOT_A_VAULT that openReaderFolder lets through for a folder that still exists would pass too, including one whose message names the full path (openVault's 'Not a directory: <root>' / 'Vault folder does not exist: <root>' forms), which the openReaderFolder doc rules out ('Messages name the file's base name at most'). The negative match on the gone message adds nothing over the code check.
- Fix: Assert the exact rejection: toMatchObject({ code: 'NOT_A_VAULT', message: 'This folder overlaps the scratch notes’ folder; it cannot be opened as a vault' }), and drop the rejects.not.toMatchObject line.
- Fix prompt: In tests/main/vault-session.test.ts, in the test '"Open folder as vault" names the overlap when the file's folder holds the scratch notes' folder', replace the two rejection assertions with one: await expect(refused).rejects.toMatchObject({ code: 'NOT_A_VAULT', message: 'This folder overlaps the scratch notes’ folder; it cannot be opened as a vault' }). That message is the one openVault throws for an excluded overlap in src/vault/vault.ts.

## issue-76/11: realPathOf repeats migrate.ts's realTarget: a second helper for 'real path of a path that may not exist yet'

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-real-path-of-copies-migrate-real-target

- Symbol: realPathOf
- Location at filing time: src/vault/vault.ts:256
- Title: realPathOf repeats migrate.ts's realTarget: a second helper for 'real path of a path that may not exist yet'
- Problem: The new realPathOf in src/vault/vault.ts resolves the deepest existing ancestor and appends the missing segments. src/migrate/migrate.ts:112 (realTarget) already does exactly this, and src/vault/paths.ts resolveInside walks the same ancestor chain a third way. The repository now has two private copies of one path rule with slightly different shapes (recursion vs a loop with a `missing` stack). A fix to one of them, for example for a symlinked ancestor or ENOTDIR, will not reach the other, and the scratch-folder overlap guard and the migration target check can drift apart.
- Fix: Keep one exported helper for it in src/vault/paths.ts (for example `realPathOfMaybeMissing(file)`, the loop form of migrate's realTarget) and use it from both openVault's exclude check and migrate.ts; delete realPathOf and realTarget.
- Fix prompt: src/vault/vault.ts adds a private realPathOf(file) that returns the real path of the nearest existing ancestor with the missing segments appended. src/migrate/migrate.ts already has the same helper as realTarget(target) (line ~112). Move one implementation into src/vault/paths.ts as an exported function (keep realTarget's loop form and its ENOENT-only rethrow and root stop), call it from openVault's `exclude` check in src/vault/vault.ts and from migrate.ts, and delete both private copies. Behaviour must not change; the existing scratch.test.ts 'refuses to open … as a vault' cases and the migrate tests cover it.

## issue-76/11: New #scratchTab helper is used for some lookups while discardScratch and saveScratch still inline the same find

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-scratch-tab-lookup-inlined-beside-helper

- Symbol: Navigation.discardScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:528
- Title: New #scratchTab helper is used for some lookups while discardScratch and saveScratch still inline the same find
- Problem: This slice adds #scratchTab(id) (`this.tabs.tabs.find((item): item is ScratchTab => item.kind === 'scratch' && item.id === id)`) and uses it in #scratchGone, discardScratch's unheld branch and #closeDiscarded. Two lines in the same class still spell the lookup out by hand: discardScratch's first line (`const tab = this.tabs.tabs.find((item) => item.kind === 'scratch' && item.id === id)`, line 528) and saveScratch's (line 605). The file now has two conventions for one question, and the inline copies lose the ScratchTab narrowing the helper gives.
- Fix: Use this.#scratchTab(id) at both remaining sites.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, replace `this.tabs.tabs.find((item) => item.kind === 'scratch' && item.id === id)` in Navigation.discardScratch (its first line) and in Navigation.saveScratch (inside the hold, after `this.#scratchListStale = true`) with `this.#scratchTab(id)`. No behaviour change.

## issue-76/11: Startup registration of both hotkeys lives in the Quick capture module

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-register-stored-hotkeys-in-capture-module

- Symbol: registerStoredHotkeys
- Location at filing time: src/main/capture.ts:30
- Title: Startup registration of both hotkeys lives in the Quick capture module
- Problem: registerStoredHotkeys registers the show/hide hotkey (setHotkey(ui.globalHotkey)) as well as the capture hotkey, and applies the 'two hotkeys never share an accelerator' rule. It was put in src/main/capture.ts, whose only other export is the capture handler and whose doc is about Quick capture. The owner of hotkey registration is src/main/preferences.ts (hotkeyRegistration, createPreferenceServices), and capture.ts now imports PreferenceServices and sameAccelerator only for this. A reader looking for how the show/hide hotkey is registered at startup will not look in the capture module, and a third hotkey would grow capture.ts further.
- Fix: Move registerStoredHotkeys (and its tests) next to hotkeyRegistration in src/main/preferences.ts, or into a small src/main/hotkeys.ts, and keep capture.ts to the capture handler.
- Fix prompt: Move registerStoredHotkeys from src/main/capture.ts to src/main/preferences.ts (beside createPreferenceServices), drop capture.ts's imports of PreferenceServices, sameAccelerator and UiPreferences, update the import in src/main/main.ts, and move its describe block from tests/main/capture.test.ts to a tests/main/preferences test file. No behaviour change.

## issue-76/11: model.test.ts crosses 1000 lines in this slice (913 → 1199); navigation.test.ts grows to 1404

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-model-test-crosses-1000-lines

- Location at filing time: tests/app/model.test.ts
- Title: model.test.ts crosses 1000 lines in this slice (913 → 1199); navigation.test.ts grows to 1404
- Problem: This slice adds about 290 lines of scratch-list and Save to vault tests to tests/app/model.test.ts, taking it from 913 to 1199 lines, with no plan to split it. tests/app/navigation.test.ts, already past 1000, grows from 1169 to 1404 with the 'Navigation of scratch tabs' describe. Both files mix unrelated concerns (vault switches, relocations, link questions, scratch notes) and repeat setup (inline choose-dialog answering, manual rm of <id>.md and <id>.json), so each scratch change has to be found inside a growing fixture swamp.
- Fix: Split the scratch describes into their own files (for example tests/app/model-scratch.test.ts for 'WorkspaceModel Save to vault of a scratch note' and 'WorkspaceModel scratch list', and tests/app/navigation-scratch.test.ts for 'Navigation of scratch tabs'), moving the setup they share into tests/app/helpers.ts as CODING_STANDARDS.md asks.
- Fix prompt: Move the 'WorkspaceModel Save to vault of a scratch note' and 'WorkspaceModel scratch list' describe blocks from tests/app/model.test.ts into a new tests/app/model-scratch.test.ts, and the 'Navigation of scratch tabs' describe from tests/app/navigation.test.ts into tests/app/navigation-scratch.test.ts. Put the setup both new files and the old ones need (start/createNavigation, keptScratch, scratchAfterA, a helper that removes a scratch note's .md and .json on disk) in tests/app/helpers.ts rather than copying it. Keep every test unchanged in behaviour.

## issue-76/11: A scratch tab is named `id`, so the test reads `id?.kind` and `id.id`

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-test-tab-named-id

- Symbol: surfaces a scratch tab save the tab store refuses, and saves both entries on the next transition
- Location at filing time: tests/app/navigation.test.ts:1276
- Title: A scratch tab is named `id`, so the test reads `id?.kind` and `id.id`
- Problem: `const id = navigation.tabs.tabs.find((item) => item.kind === 'scratch')` holds a tab, not an id. The test then asserts `expect(id).toMatchObject({ kind: 'scratch' })` and builds the expected entry with `id?.kind === 'scratch' ? id.id : ''`, which reads as a typo and hides what is being compared.
- Fix: Name it `scratch` (or take the id from newScratch's rejection path differently) and read `scratch.id`.
- Fix prompt: In tests/app/navigation.test.ts, test 'surfaces a scratch tab save the tab store refuses, and saves both entries on the next transition', rename `const id = navigation.tabs.tabs.find((item) => item.kind === 'scratch')` to `scratch` (or narrow it to a ScratchTab with a type guard) and use `scratch.id` in the store.scratch expectation. No behaviour change.

## issue-76/11: newScratch doc's "so it is no later transition to it" is hard to parse

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] comments-new-scratch-doc-no-later-transition-wording

- Symbol: Navigation.newScratch
- Location at filing time: src/app/actions/public/workspace/navigation.ts:490
- Title: newScratch doc's "so it is no later transition to it" is hard to parse
- Problem: src/app/actions/public/workspace/navigation.ts:489-491 | "Runs one at a time: a New Scratch Note asked for while one is out (two Quick capture presses) starts once that one is done, so it is no later transition to it and both scratch notes show." | The point (the queued create does not count as a later transition that supersedes the first, so the first is not answered `shown: false`) is a real why, but "it is no later transition to it" does not say which 'it' is which and reads as garbled. Rewrite so it survives the two-year test.
- Fix: Rewrite as: "Runs one at a time: a New Scratch Note asked for while one is out (two Quick capture presses) starts only once that one is done, so it does not supersede the first (which would answer `shown: false`) and both scratch notes show."
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, in the newScratch docstring, replace "starts once that one is done, so it is no later transition to it and both scratch notes show." with "starts only once that one is done, so it does not supersede the first (which would then answer `shown: false`) and both scratch notes show."

## issue-76/11: saveScratchToVault docstring breaks a sentence after "On"

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r5
Reviewed commit: 085bba2aab5c8f08382c723d75ba42258f66fa73
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] comments-save-scratch-to-vault-doc-stray-line-break

- Symbol: WorkspaceModel.saveScratchToVault
- Location at filing time: src/app/actions/public/workspace/model.ts:591
- Title: saveScratchToVault docstring breaks a sentence after "On"
- Problem: src/app/actions/public/workspace/model.ts:590-592 | "…the scratch tab closes and the notice says where the note went. On" / "failure the scratch note and its tab stay…" | The rewrapped docstring leaves the single word "On" on its own line, splitting "On failure" across lines, a leftover from editing the paragraph.
- Fix: Rewrap the paragraph so "On failure the scratch note and its tab stay and the notice says why." sits together.
- Fix prompt: In src/app/actions/public/workspace/model.ts, in the saveScratchToVault docstring, join the line ending "the note went. On" with the next line beginning "failure the scratch note and its tab stay" and rewrap the paragraph to the file's comment width, without changing any words.

## issue-76/11: [high] New Scratch Note / Quick capture still unmounts a busy Import or Title renames dialog, losing its result and error

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [high] holistic-new-scratch-closes-busy-import-and-title-renames-dialogs

- Symbol: WorkspaceModel.newScratchNote
- Location at filing time: src/app/actions/public/workspace/model.ts:754
- Title: New Scratch Note / Quick capture still unmounts a busy Import or Title renames dialog, losing its result and error
- Problem: Review 11-r5 kept this as high (bug-new-scratch-closes-busy-import-and-title-renames-dialogs, CHANGES_REQUESTED), but it is not in this round's fix file and the code is unchanged. newScratchNote sets `this.importOpen = false` and `this.titleRenamesOpen = false` without checking whether the dialog is busy. The two dialogs follow the opposite rule: each one keeps `busy` in its own component state and refuses to close while its work runs (import-dialog.tsx:116 and :205, title-renames-dialog.tsx:168, :189 and :194), because the outcome is shown only inside the dialog. workspace.tsx:307-309 renders them only while the flags are true, so clearing a flag unmounts the component mid-run. Reachable path: start a long Import (or click 'Rename N files' in Title renames), switch to another app, press the Quick capture hotkey (or choose File › New Scratch Note). The dialog disappears. The import or the renames keep running in main, but their summary, warnings, report path, 'Open vault' button or error ('Save or resolve the open note first.', a failed apply) are never shown, and nothing tells the user whether the work succeeded.
- Fix: Have newScratchNote leave a busy Import or Title renames dialog open. For example, move the busy state into the model (flags the dialogs set through a model method when their run or apply starts and ends), skip closing a busy dialog, and then create the scratch note without moving the focus behind it, as the code already does for an open 'Update links?' question. Add a model test that marks Import busy, calls newScratchNote, and checks that importOpen stays true and the editor focus is not requested.
- Fix prompt: In src/app/actions/public/workspace/model.ts, WorkspaceModel.newScratchNote unconditionally sets importOpen and titleRenamesOpen to false. ImportDialog (import-dialog.tsx) and TitleRenamesDialog (title-renames-dialog.tsx) keep a local `busy` flag and refuse to close while their work runs, because their result and error live only in their component state, and workspace.tsx renders them only while the model flags are true. Give the model a busy state for each of the two dialogs: for example importBusy and titleRenamesBusy, set by the dialogs through model methods when run/apply starts and cleared in a finally when it ends. In newScratchNote, do not close a dialog that is busy. Still create the scratch note, but skip #focusEditor while such a dialog stays open, as the code already does when an 'Update links?' dialog stays. Keep closing Preferences and the idle dialogs as now. Add a tests/app/model.test.ts case: set the import busy, open Import, call newScratchNote, and assert that importOpen is still true, a scratch tab opened, and no editor focus was requested. Add a second case with Title renames busy.

## issue-76/11: [high] Comments still say a folder that overlaps the scratch folder is refused, but a vault that holds it now opens

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [high] comments-overlap-docs-say-holder-vault-refused

- Symbol: runCli
- Location at filing time: src/cli/main.ts:217
- Title: Comments still say a folder that overlaps the scratch folder is refused, but a vault that holds it now opens
- Problem: Commits e32426e5 and d99df967 changed openVault so it refuses only the scratch folder itself or a folder inside it (`if (isInside(exclude, real)) throw new ScratchOverlapError()`). A vault that holds the scratch folder now opens and leaves it out (src/vault/vault.ts:229-251; PLAN.md:603-606; tests/cli/scratch-exclude.test.ts 'opens a vault that holds the app’s scratch folder…'). Five comments still describe the earlier rule, where any overlap was refused: (1) src/cli/main.ts:217 "a folder that overlaps their folder is no vault here either"; (2) src/vault/errors.ts:24 ScratchOverlapError doc "`openVault`'s refusal of a folder that overlaps its `exclude` folder"; (3) src/main/vault-session.ts:21 VaultSessionOptions.exclude "A folder no vault may overlap"; (4) src/main/vault-session.ts:147-148 openReaderFolder doc "`ScratchOverlapError` … when the folder overlaps the scratch notes' folder"; (5) src/main/vault-session.ts:243-244 open doc "Throws `VaultError('NOT_A_VAULT')` when the folder is missing or overlaps the scratch notes' folder". A folder that holds another one overlaps it, so these comments say that `boostnote --vault ~` (or opening the home folder in the app) throws NOT_A_VAULT. A caller who trusts them would handle or warn about a refusal that never happens for a holder, and would not know that the holder vault opens with the scratch folder skipped and its holder folders guarded.
- Fix: Restate the current rule in each place: refused only when the folder is the scratch folder or lies inside it; a vault that holds it opens and leaves it out. For example: cli/main.ts:217 "// The app's scratch notes live outside every vault: the scratch folder or a folder inside it is no vault here, and a vault that holds it leaves it out."; errors.ts:24 "`openVault`'s refusal of a folder that is its `exclude` folder or lies inside it (the scratch notes' folder)."; vault-session.ts:21 "The scratch notes' folder (`openVault`'s `exclude`): no vault opens on it or inside it, and a vault that holds it leaves it out."; vault-session.ts:147-148 and 243-244: "… when the folder is the scratch notes' folder or lies inside it (`exclude`) …".
- Fix prompt: Update five comments to match openVault's current exclude rule (src/vault/vault.ts:229-251): it refuses with ScratchOverlapError only a folder that is the exclude folder or lies inside it, and a vault that holds the exclude folder opens and leaves it out. Edit (1) src/cli/main.ts:217 so it no longer says that a folder overlapping the scratch folder is no vault; (2) the ScratchOverlapError docstring at src/vault/errors.ts:24 so it says the refusal covers the exclude folder itself or a folder inside it; (3) VaultSessionOptions.exclude at src/main/vault-session.ts:21 ('A folder no vault may overlap') so it says no vault opens on it or inside it and a holder vault leaves it out; (4) the openReaderFolder docstring at src/main/vault-session.ts:147-148 and (5) the open docstring at src/main/vault-session.ts:243-244 so the ScratchOverlapError / NOT_A_VAULT case reads 'when the folder is the scratch notes' folder or lies inside it' instead of 'overlaps'. Change comments only, no code.

## issue-76/11: [high] Docs say no vault may overlap the scratch folder, but a vault that holds it now opens

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [high] comments-overlap-docs-say-holder-vaults-are-refused

- Symbol: VaultSessionOptions.exclude
- Location at filing time: src/main/vault-session.ts:21
- Title: Docs say no vault may overlap the scratch folder, but a vault that holds it now opens
- Problem: Several new comments describe the scratch-folder refusal as covering any folder that "overlaps" the scratch notes' folder. In d99df967, openVault refuses only a root that is the exclude folder or lies inside it (`if (isInside(exclude, real)) throw new ScratchOverlapError()`). A root that holds it, such as the home folder or ~/Library on macOS, opens and leaves the folder out (`excluded = exclude`, and the openVault doc and PLAN.md say "A vault that holds it opens"). A folder that holds another one overlaps it in the plain sense, so these comments are now false for that case:
- src/main/vault-session.ts:21 "A folder no vault may overlap (`openVault`'s `exclude`)". A vault may hold it.
- src/main/vault-session.ts:147-148 (openReaderFolder) "`ScratchOverlapError` … when the folder overlaps the scratch notes' folder".
- src/main/vault-session.ts:243-244 (open) "Throws `VaultError('NOT_A_VAULT')` when the folder is missing or overlaps the scratch notes' folder".
- src/cli/main.ts:217 "a folder that overlaps their folder is no vault here either". `boostnote --vault ~` holds it and opens, and tests/cli/scratch-exclude.test.ts asserts exactly that.
- src/vault/errors.ts:24 "`openVault`'s refusal of a folder that overlaps its `exclude` folder".
A caller reading VaultSession.open's throw list, or the CLI comment, would expect opening a home-folder vault to answer NOT_A_VAULT, and could handle or report a refusal that never comes. A maintainer could also "fix" openVault to refuse holders so it matches these docs, which brings back the lock-out removed by 11-r1:thermo-vault-exclude-refuses-instead-of-skipping.
- Fix: Reword each comment to the actual rule: the folder is refused when it is the scratch notes' folder or lies inside it; a folder that holds it opens and leaves it out. Suggested texts: vault-session.ts:21 "The scratch notes' folder (`openVault`'s `exclude`): no vault opens on it or inside it, and a vault that holds it leaves it out." vault-session.ts:147-148 and 243-244: "…when the folder is the scratch notes' folder or lies inside it (`exclude`)…". cli/main.ts:217: "The app's scratch notes live outside every vault: the scratch folder, or a folder inside it, is no vault here either, and a vault that holds it leaves it out." errors.ts:24: "`openVault`'s refusal of its `exclude` folder (the scratch notes' folder) or a folder inside it."
- Fix prompt: Update the comments that say the scratch-folder refusal covers any folder that "overlaps" the scratch notes' folder. openVault refuses only the exclude folder itself or a folder inside it; a folder that holds it opens and leaves it out. Edit: (1) src/main/vault-session.ts:21: replace "A folder no vault may overlap (`openVault`'s `exclude`): the scratch notes' folder." with "The scratch notes' folder (`openVault`'s `exclude`): no vault opens on it or inside it, and a vault that holds it leaves it out." (2) src/main/vault-session.ts:147-148 in the openReaderFolder doc and (3) src/main/vault-session.ts:243-244 in the open doc: replace "overlaps the scratch notes' folder (`exclude`)" with "is the scratch notes' folder or lies inside it (`exclude`)". (4) src/cli/main.ts:217: replace the comment with "The app's scratch notes live outside every vault: the scratch folder, or a folder inside it, is no vault here either, and a vault that holds it leaves it out." (5) src/vault/errors.ts:24: replace with "`openVault`'s refusal of its `exclude` folder (the scratch notes' folder) or a folder inside it." Do not change any code.

## issue-76/11: The new restore guard for a trash entry that holds the scratch folder has no test

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] testing-restore-holder-guard-untested

- Symbol: Vault.restore
- Location at filing time: src/vault/vault.ts:763
- Title: The new restore guard for a trash entry that holds the scratch folder has no test
- Problem: d99df967 adds #guardHolder(source, trashId) and the assets-folder guard to Vault.restore, so restoring a trashed folder or note (with its assets folder) that holds the excluded scratch folder is refused instead of moving the scratch folder back into the vault. The new openVault exclude tests cover delete, move, rename, folder moves and emptyTrash, but none calls vault.restore on such an entry (no test in tests/ calls restore with an exclude). If either guard line were dropped, restore would carry the app's scratch folder out of the trash and no test would fail.
- Fix: Add a tests/vault/vault.test.ts case in 'openVault exclude' that trashes a folder (or a note's assets folder) holding the excluded folder before the vault opens with exclude, then expects vault.restore(trashId) to reject with INVALID_PATH and the scratch file to stay in place.
- Fix prompt: In tests/vault/vault.test.ts, in describe('openVault exclude'), add a test: open the vault without exclude, put 'holder/scratch/a.md' and 'kept.md', deleteFolder('holder') so it goes to the trash, close the vault, find the trashed path of the scratch folder (listTrash gives the trash id; the scratch folder lies under .trash/<entry>), reopen with openVault(root, { exclude: <that scratch path> }), and expect vault.restore(trashId) to reject with { code: 'INVALID_PATH' } while the scratch a.md is still readable at its trash path. Add a second case for a trashed note whose <note>.assets folder holds the scratch folder.

## issue-76/11: The 'reopen waits for the blank discard' guard covers one of the three close paths that send it

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] holistic-reopen-waits-only-for-unheld-background-discard

- Symbol: Navigation.#close
- Location at filing time: src/app/actions/public/workspace/navigation.ts:393
- Title: The 'reopen waits for the blank discard' guard covers one of the three close paths that send it
- Problem: The fix for bug-background-close-discard-races-list-reopen registers the ifBlank discard in #discarding only at the unheld background-close call site, and #loadScratch waits only on that map. #close sends the same `#discardBlank` from two more paths: the held background close (the hold at about line 380) and the active-tab close (the #switch then-hook at about line 409). In both, the blank note's row stays in the scratch list until the hold's relist, so it can still be clicked while the discard is out. A row click runs openScratch → #switch → #loadScratch, finds nothing in #discarding and reads at once. If the GET read reaches ScratchStore before the POST discard, the read returns the still-blank note, the discard then deletes the file, and once both holds settle the session holds a deleted note, editable. The first autosave answers 404, the typed text is dropped and the tab closes with 'This scratch note no longer exists'. This is the failure the fix removed for the unheld path, still there after Cmd+W on the active blank scratch tab followed by a quick click on its row. The window is one discard round trip, as in the original item.
- Fix: Track the discard where it is sent: have #discardBlank itself put its promise in #discarding (and remove it when it settles), so every close path, held or not, makes a reopen wait. The unheld branch then needs no bookkeeping of its own.
- Fix prompt: In src/app/actions/public/workspace/navigation.ts, move the #discarding bookkeeping from the unheld background-close branch of #close into #discardBlank. #discardBlank should set this.#discarding.set(id, promise) for its own request and delete the entry in a finally when it is still that promise. Then the held background close and the active close's then-hook also make #loadScratch wait. Remove the now-duplicated set/delete lines from #close. Add a tests/app/navigation.test.ts case: with a blank active scratch tab, hold /api/scratch/discard with net.hold, close the tab, call navigation.openScratch(id) while the discard is held, release it, and assert that no session holds the scratch note and that the reopened tab is closed with the 'no longer exists' notice, mirroring the existing background-close test.

## issue-76/11: The scratch-folder exclusion misses the trash destinations of deletes and the assets copy of Markdown export

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] holistic-scratch-exclusion-skips-trash-destinations-and-export

- Symbol: openVault
- Location at filing time: src/vault/vault.ts:231
- Title: The scratch-folder exclusion misses the trash destinations of deletes and the assets copy of Markdown export
- Problem: This round adds the exclusion to almost every vault path: resolves go through #resolve, and moves, renames, trash and restore of a holder are refused through #guardHolder. The openVault doc and PLAN.md now promise that the excluded folder 'is never listed, read, written, moved or trashed', and the new tests cover holders in .trash, .boostnote and a note's *.assets folder. Two sibling paths missed the change. (1) deleteNote and deleteFolder still build the trash destination with plain resolveInside(this.root, [TRASH_DIR, ...]) (vault.ts:710, :855), not the exclusion-aware resolver. With the scratch folder at <root>/.trash/app/scratch (the 'holds it in its trash' layout the tests open), deleting a note in vault folder app/scratch renames it into the scratch folder, and removeExcept then keeps it on every emptyTrash. (2) exportNoteMarkdown (src/markdown/export.ts:154-164) copies a note's whole <stem>.assets tree with cp recursive. With the scratch folder inside foo.assets (the assets-holder layout d99df967 opens), exporting foo.md copies every scratch note and its sidecar into the export location, so private scratch text leaves the app's folder. Both layouts need a userData folder placed under a vault's .trash or a *.assets folder (for example with --user-data-dir), so they are rare. But this round chose to open these layouts, and the code does not keep the promise it documents for them.
- Fix: Apply the exclusion to the remaining paths: resolve the .trash destinations of deleteNote and deleteFolder through the exclusion-aware #resolve (or refuse a destination inside the excluded folder), and have exportNoteMarkdown skip the excluded subtree when it copies a note's assets folder (for example a cp filter that leaves out paths inside it, exposed from the Vault). Add vault tests for a scratch folder at .trash/<x>/scratch with a delete of a note in folder <x>/scratch, and an export test for a note whose assets folder holds the scratch folder.
- Fix prompt: src/vault/vault.ts openVault now opens a vault that holds the excluded (scratch) folder and documents that the folder is never listed, read, written, moved or trashed, and the tests cover holders in .trash, .boostnote and a note's *.assets folder. Two paths still bypass the exclusion. (1) deleteNote (about line 710) and deleteFolder (about line 855) compute the trash destination with plain resolveInside(this.root, [TRASH_DIR, ...]); with the scratch folder at <root>/.trash/app/scratch, deleting a note in vault folder app/scratch moves it into the scratch folder, and emptyTrash then keeps it there for good. Resolve these destinations so a target inside #excluded is refused (an INVALID_PATH like #resolve gives). (2) exportNoteMarkdown in src/markdown/export.ts copies the note's whole <stem>.assets folder with cp(..., { recursive: true }); when that folder holds the scratch folder, the export copies every scratch note and sidecar. Skip the excluded subtree in that copy, for example with cp's filter option and a Vault method that says whether a path lies in the excluded folder. Add tests in tests/vault/vault.test.ts for (1) and in the markdown export tests for (2).

## issue-76/11: The scratch folder's location is rebuilt by hand in the CLI as well as in the app's main

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-scratch-folder-location-derived-per-entrypoint

- Symbol: runCli
- Location at filing time: src/cli/main.ts:218
- Title: The scratch folder's location is rebuilt by hand in the CLI as well as in the app's main
- Problem: The CLI now computes the folder to exclude as path.join(appUserDataDir(io.env), 'scratch'), while src/main/main.ts separately builds path.join(app.getPath('userData'), 'scratch') for the ScratchStore and VaultSession. The rule 'scratch notes live in <userData>/scratch' is spelled out in two entrypoints. If the store's folder name or location changes in main.ts, the CLI and MCP server keep excluding the old path and index the scratch notes again, with no test linking the two.
- Fix: Give the scratch folder location one owner, for example a small exported helper (scratchDirOf(userDataDir)) next to ScratchStore or in src/shared, used by main.ts, the CLI and tests/app/helpers.ts.
- Fix prompt: Add one exported helper that maps a userData folder to the scratch notes' folder (for example `export function scratchDirOf(userData: string): string { return path.join(userData, 'scratch') }` beside ScratchStore in src/app/scratch-store.ts or in src/cli/vault-dir.ts). Use it in src/main/main.ts for scratchDir, in src/cli/main.ts runCli for `exclude`, and in tests/app/helpers.ts where TestApp builds <dir>/userData/scratch, so the folder name is written once.

## issue-76/11: A listing older than a scratch save still reverts that note's title once the session holds another note, or when the save shares the listed millisecond

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] bug-delayed-listing-after-tab-switch-reverts-saved-title

- Symbol: WorkspaceModel.#withOpenScratch
- Location at filing time: src/app/actions/public/workspace/model.ts:269
- Title: A listing older than a scratch save still reverts that note's title once the session holds another note, or when the save shares the listed millisecond
- Problem: src/app/actions/public/workspace/model.ts:265-274 | refreshScratch overlays only the scratch note the session holds when the listing lands. I checked each order that reaches #withOpenScratch. (1) The listing reads scratch A, A autosaves (the change listener patches A's row), and the listing lands while A is still open: the overlay keeps the new title. That is right. (2) The listing reads A, A saves, then the user switches to note or scratch tab B (a plain switch is not a scratch change, so it starts no relist), and then the listing lands: session.scratch is B or null, so `this.#scratchListed = notes` puts A's pre-save title and updated back. A's background tab title (scratchTabTitle reads #scratchListed) and its row then show the old title until something lists again. (3) The listing's stat and the save's write fall in the same millisecond: ScratchStore reports mtime through toISOString(), so scratch.updated equals listed.updated. `scratch.updated <= listed.updated` then keeps the stale row even while A is open, and A's tab shows the old title once A goes to the background. This is the remaining part of fix item react-ts-delayed-scratch-listing-reverts-saved-title.
- Fix: Keep the last save of each scratch note, not only the one the session holds. For example, record id → { title, updated, generation } on every scratch save (the session 'change' or 'saved' event), and when a listing lands, use the recorded save for any row whose listing started before that save (compare a save counter taken when the listing started, not ISO strings). Alternatively, bump #scratchListings on every scratch save so a listing started earlier is dropped and a new one runs. Either way, case 2 (a switch before the listing lands) and case 3 (equal millisecond) must keep the saved title.
- Fix prompt: In src/app/actions/public/workspace/model.ts, refreshScratch replaces #scratchListed with a listing, and #withOpenScratch overlays only this.session.scratch, and only when its updated is strictly later than the listed row's. Two orders still put an old title back: (a) a listing reads scratch A, A autosaves, the user switches to another tab (no relist runs), then the listing lands, so A's row and its background tab title revert; (b) the save and the listing's stat share one millisecond (updated comes from mtime.toISOString()), so the strict comparison keeps the stale row. Fix both by not judging freshness from the session alone or by ISO strings. For example, keep a counter incremented on every scratch save, record the counter value at the start of each listing, and keep a map of id → last saved { title, updated, counter }. When a listing lands, for each row whose last save's counter is later than the listing's start, use the saved title and updated, then sort newest first. Alternatively, make each scratch save invalidate in-flight listings (bump #scratchListings) and list again. Extend the model test for the delayed listing: hold GET /api/scratch, save A, activate another tab, release the listing, and assert scratchTabTitle(A) is the saved title.

## issue-76/11: A sidecar that exists but cannot be read (EACCES, EISDIR) makes read, write and the whole scratch list fail

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] bug-scratch-sidecar-read-error-fails-note

- Symbol: ScratchStore.#created
- Location at filing time: src/app/scratch-store.ts:143
- Title: A sidecar that exists but cannot be read (EACCES, EISDIR) makes read, write and the whole scratch list fail
- Problem: src/app/scratch-store.ts:141-147 | The read() doc says a note whose sidecar is 'missing or unreadable' falls back to the file's birth time, as carried item 01-r1:thermo-scratch-created-birthtime-fallback asks. #created calls readJsonFile(this.#meta(id)), which answers undefined only for ENOENT and invalid JSON (src/vault/files.ts:51-58) and rethrows anything else. So a <id>.json that is a directory (EISDIR) or has no read permission (EACCES) makes #created throw. read and write then answer 500 for that note. list() rethrows every error that is not NOT_FOUND, so GET /api/scratch answers 500, and the scratch list and the restore's existence check fail for every note because of one bad sidecar.
- Fix: In #created, treat any failure to read the sidecar as no valid sidecar: catch errors from readJsonFile (or read the file through a small helper that answers undefined on any error), then take the birth time and persist it best effort as now. The best-effort write already swallows its own failure.
- Fix prompt: In src/app/scratch-store.ts ScratchStore.#created, wrap `await readJsonFile(this.#meta(id))` so that any rejection (EACCES, EISDIR, EIO as well as ENOENT and invalid JSON) counts as an unreadable sidecar: `const meta = await readJsonFile(this.#meta(id)).catch(() => undefined)`. Keep the birth-time fallback and the best-effort `writeJsonFile(...).catch(() => {})`. Add a ScratchStore test that replaces <id>.json with a directory, then calls read(id) and list() and expects the note with its file's birth time as created, not a rejection.

## issue-76/11: The holder and exclusion guards compare paths as requested, so a symlinked ancestor, a case variant or a trash destination reaches the scratch folder

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] bug-vault-exclude-guards-miss-symlink-case-and-trash-paths

- Symbol: Vault.deleteFolder
- Location at filing time: src/vault/vault.ts:853
- Title: The holder and exclusion guards compare paths as requested, so a symlinked ancestor, a case variant or a trash destination reaches the scratch folder
- Problem: src/vault/vault.ts:853, 1088, 716, 1059-1060, 710 | #guardHolder takes the lexical path built from the requested id (path.join(root, ...folderSegments(id)), assetsDirOf(file)) and compares it with the real path of the excluded folder. I checked each input that reaches it. (1) The holder's own id in its stored case: refused, right. (2) An id inside the scratch folder: #resolve refuses, right. (3) An id through an in-vault symlinked ancestor, e.g. <root>/lnk -> <root>/Library/Application Support, then deleteFolder('lnk/Boostnote'): the guard sees <root>/lnk/Boostnote, which does not hold the excluded path; #existingFolder's #resolve passes because the real path is the scratch folder's parent, not inside it; rename then moves the real userData folder, with the scratch notes and settings.json, into .trash. emptyTrash's removeExcept keeps only the old excluded path, so it then deletes all of it. moveFolder through #relocateFolder (line 1088) has the same gap. (4) A case variant of a holder's id on a case-insensitive file system (macOS default, Windows), such as 'library': the lexical guard misses it in the same way. (5) Trash destinations are not excluded: deleteNote and deleteFolder build trashDir/trashParent with resolveInside without the excluded folder (lines 710 and 855). With the scratch folder at <root>/.trash/foo/scratch, a layout this round opens on purpose, deleting a vault note foo/scratch/<32 hex>.md moves it into the live scratch folder, where it lists as a scratch note, and its restore pulls a file out of the scratch store. The page only sends ids from the scan, which does not follow symlinks, so cases 3 and 4 need a request with a hand-made id. Case 5 needs userData inside a vault's .trash.
- Fix: Guard on real paths and on every destination. Before a folder move or delete, realpath the source folder (and for a note, its assets folder when it exists) and refuse when that real path holds the excluded folder, so symlinked ancestors and case variants are caught. Resolve trash destinations (trashDir in deleteNote, trashParent in deleteFolder) through the exclusion check too, so nothing is moved into the excluded folder.
- Fix prompt: In src/vault/vault.ts, #guardHolder compares the lexical path of the requested id with the excluded folder's real path. Make the holder check use the real path. For deleteFolder and #relocateFolder, call it on `await realpath(dir)` after #existingFolder, not on path.join(root, ...folderSegments(id)). For deleteNote and #relocateNote, call it on the realpath of assetsDirOf(file) when that folder exists. Then an id under an in-vault symlink to an ancestor of the scratch folder, or a case variant such as 'library' on macOS, is refused too. Also apply the exclusion to trash destinations. In deleteNote, build trashDir with this.#resolve (or resolveInside(root, segments, this.#excluded)) instead of plain resolveInside, and do the same for trashParent in deleteFolder, so nothing is moved into the scratch folder when it sits under .trash. Add tests in tests/vault/vault.test.ts: a vault holding the excluded folder with a symlink <root>/lnk -> the excluded folder's parent's parent, where deleteFolder('lnk/<parent name>') and moveFolder of it are refused with the folder still in place; and the excluded folder at <root>/.trash/foo/scratch, where deleteNote('foo/scratch/<32 hex>.md') is refused (or moves nothing into the excluded folder).

## issue-76/11: Trashing a note can move it into the excluded scratch folder when that folder sits in the vault's .trash

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r6
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] scope-trash-destination-can-write-into-excluded-folder

- Symbol: Vault.deleteNote
- Location at filing time: src/vault/vault.ts:716
- Title: Trashing a note can move it into the excluded scratch folder when that folder sits in the vault's .trash
- Problem: openVault now opens a vault that holds the scratch folder in its .trash (commit d99df967), and its doc says the folder is never 'listed, read, written, moved or trashed'. deleteNote works out its destination with resolveInside(this.root, [TRASH_DIR, ...folderSegments(parentOf(id))]) and does not pass this.#excluded, and nothing checks whether that destination is inside the excluded folder. Take root R and userData R/.trash, so exclude is R/.trash/scratch. Deleting the vault note R/scratch/x.md gives trashDir R/.trash/scratch, which is the scratch folder, and rename(file, …) moves the vault note and its assets folder into it. A vault note whose name is 32 hex characters then shows up as a scratch note. Any other trashed note stays in the scratch folder for good, because emptyTrash keeps that folder. uniqueStem checks for a free name and then renames in a separate step, so a scratch note created between the two can be replaced by the rename. deleteFolder (trashParent) and restore's #trashPath resolve without the exclude in the same way. The carried item 01-r1:scope-scratch-notes-indexed-when-vault-contains-userdata asks to keep the scratch folder out of every vault, and the new openVault doc promises the vault never writes into it. On this path the code does not keep either promise.
- Fix: Resolve trash destinations with the excluded folder, so that a trash path at or inside it is refused. One way: give the deleteNote and deleteFolder trash resolveInside calls, and #trashPath, this.#excluded. Another: check isInside(this.#excluded, destination) before the rename and throw INVALID_PATH. Add a vault test with exclude <root>/.trash/scratch that deletes a note at scratch/<32 hex>.md. It should expect a refusal, or a destination outside the excluded folder, and the scratch folder's contents unchanged.
- Fix prompt: In src/vault/vault.ts, Vault.deleteNote and Vault.deleteFolder resolve their .trash destination with resolveInside(this.root, [TRASH_DIR, ...]) and leave out this.#excluded, and #trashPath (used by restore) does the same. When the excluded scratch folder is <root>/.trash/<something>, which openVault now accepts, trashing a note or folder from <root>/<something>/ renames it into the scratch folder. Pass this.#excluded to these resolveInside calls (use this.#resolve with the TRASH_DIR segments), so a destination at or inside the excluded folder throws INVALID_PATH before anything is renamed. Add a test to tests/vault/vault.test.ts. Open a vault with exclude path.join(root, '.trash', 'scratch'), which already holds a scratch file, and create a note scratch/<32 hex>.md. Assert that deleteNote of that note is refused, or leaves the excluded folder's entries and file contents unchanged, and that no vault file appears in the excluded folder.

## issue-76/11: emptyTrash's removeExcept follows a symlinked folder on the way to the excluded folder and deletes outside the vault

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] security-empty-trash-follows-symlink-on-path-to-excluded

- Symbol: removeExcept
- Location at filing time: src/vault/vault.ts:1264
- Title: emptyTrash's removeExcept follows a symlinked folder on the way to the excluded folder and deletes outside the vault
- Problem: Before this change, emptyTrash ran rm(<root>/.trash, { recursive: true }), which unlinks a symlink and never follows it. removeExcept now descends into every folder whose path lexically holds `keep` (isInside(target, keep)). It reads that folder with readdir, which follows symlinks, and then calls rm(path.join(target, name), { recursive: true }) on each entry. `keep` is the excluded path that openVault's realPathOf worked out once, when the vault opened: missing segments are appended as typed, and existing ones were real at that moment. Suppose a folder on that path, for example <root>/.trash/app when userData is <root>/.trash/app, did not exist then, or was later replaced by a symlink to /some/dir (a sync tool, git, or the user). Empty Trash then lists /some/dir and recursively deletes every entry in it except one named like the next segment of `keep`. That is a recursive delete outside the vault root. The trigger needs the scratch folder to sit inside the vault's .trash plus a symlink on that path, so it is unlikely. But the vault's other removal paths refuse symlink escapes (resolveInside), and this one bypasses that.
- Fix: Walk toward `keep` without following symlinks. Use readdir(target, { withFileTypes: true }) and lstat. Descend only into a real directory (entry.isDirectory() is true and the entry is not a symbolic link). Remove anything else, a symlink included, with rm, which unlinks it without following it. Optionally, check once that realpath(target) still equals target before descending.
- Fix prompt: In src/vault/vault.ts, removeExcept(target, keep) descends into any path that lexically holds `keep` by calling readdir(target), which follows symlinks, and then rm-recursives the entries under it. If a folder on the way to the excluded scratch folder is a symlink, Empty Trash deletes the contents of the symlink's target outside the vault. Change removeExcept so it never follows a symlink. Before descending, lstat(target): if it is a symbolic link or not a directory, rm(target, { force: true }) and return (or keep it when target === keep). Only real directories are read and walked. Add a test in tests/vault/vault.test.ts: open a vault whose exclude is <root>/.trash/app/scratch while <root>/.trash/app does not exist yet. Then create <root>/.trash/app as a symlink to an outside folder holding a file, call emptyTrash(), and assert that the outside file still exists.

## issue-76/11: CLI and MCP exclude only the default profile's scratch folder, so a side-by-side profile's scratch notes are exposed

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] security-cli-scratch-exclude-ignores-custom-profile

- Symbol: runCli
- Location at filing time: src/cli/main.ts:218
- Title: CLI and MCP exclude only the default profile's scratch folder, so a side-by-side profile's scratch notes are exposed
- Problem: The CLI and the MCP server exclude only the default profile's scratch folder, path.join(appUserDataDir(io.env), 'scratch'), and appUserDataDir has no way to name another profile. The app honours --user-data-dir: main.ts sets userData to <appData>/Boostnote Modern only when that switch is absent, and its comment names side-by-side profiles as a supported use. A user who runs a second profile, say --user-data-dir=~/notes-profile, keeps that profile's scratch notes in ~/notes-profile/scratch. Running `boostnote --vault ~`, or an MCP server on that vault, then excludes the wrong folder. Those scratch notes are indexed as vault notes: listed, searchable, and open to an MCP agent's read, edit, move and delete tools, against the promise that scratch notes live outside every vault. This is separate from the known observation that the folder location is derived in two places: here the CLI cannot reach the right folder at all.
- Fix: Let the CLI learn which scratch folder to exclude when the app runs on a non-default profile. One way: a BOOSTNOTE_USER_DATA_DIR env var (or a --user-data-dir flag) that appUserDataDir honours. Another: the app records its scratch folder somewhere the CLI reads. At least document that a vault holding a side-by-side profile's scratch folder is not protected in the CLI and MCP server.
- Fix prompt: src/cli/main.ts runCli excludes path.join(appUserDataDir(io.env), 'scratch'), which is always the default profile (<appData>/Boostnote Modern). The app's main (src/main/main.ts, the hasSwitch('user-data-dir') branch) keeps scratch notes under whatever --user-data-dir it was launched with. So with a side-by-side profile, `boostnote --vault <dir holding that profile>` and the MCP server index its scratch notes as vault notes, and an MCP client can read, edit, move or delete them. Make appUserDataDir in src/cli/vault-dir.ts honour an override the app's profile can also be given, such as a BOOSTNOTE_USER_DATA_DIR env var, and use it for both the settings file and the scratch exclusion. Add a tests/cli/scratch-exclude.test.ts case: with the override set to <tmp>/profile, opening <tmp> as a vault lists no scratch notes from <tmp>/profile/scratch.

## issue-76/11: scratchNotes now hands out the model's own #scratchListed array under a mutable type

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] react-ts-scratch-notes-getter-leaks-mutable-list

- Symbol: WorkspaceModel.scratchNotes
- Location at filing time: src/app/actions/public/workspace/model.ts:311
- Title: scratchNotes now hands out the model's own #scratchListed array under a mutable type
- Problem: Before this slice the getter always built a fresh array. It now returns this.#scratchListed itself when no scratch note is open (line 311), typed as a mutable ScratchSummary[]. The rest of the model treats that list as immutable: #withOpenScratch uses .with/.toSorted, and refreshScratch swaps the whole array. A caller that sorts, splices or edits a row in place (a component, or a test helper) would then change the model's listing without a 'change' event, and the next #withOpenScratch would compare against the edited rows.
- Fix: Type the list as readonly: make #scratchListed a readonly ScratchSummary[] (or ReadonlyArray<Readonly<ScratchSummary>>) and give the scratchNotes getter that return type, so the compiler refuses an in-place change.
- Fix prompt: In src/app/actions/public/workspace/model.ts, change `#scratchListed: ScratchSummary[] = []` to `#scratchListed: readonly ScratchSummary[] = []`, and change the return type of `get scratchNotes()` and `#withOpenScratch` (parameter and result) to `readonly ScratchSummary[]`. Fix any caller the typecheck then flags (scratch-list.tsx and workspace.tsx only read it). No behaviour change.

## issue-76/11: newScratchNote's late focus checks only the dialog, so a panel opened while the create is out gets the editor focused behind it

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] react-ts-new-scratch-focus-ignores-panels-opened-meanwhile

- Symbol: WorkspaceModel.newScratchNote
- Location at filing time: src/app/actions/public/workspace/model.ts:765
- Title: newScratchNote's late focus checks only the dialog, so a panel opened while the create is out gets the editor focused behind it
- Problem: newScratchNote closes Preferences, Import and Title renames, and cancels a dialog, before navigation.newScratch(). After the create it checks only `!this.dialog` before #focusEditor. The await covers the createScratch round trip, and hold also waits for the scratch relist (GET /api/scratch) before newScratch resolves. If the user opens Preferences, Import or Title renames in that window (menu or shortcut), the new scratch editor still takes focus behind that panel's scrim. That is the state carried item 09-r1:bug-capture-focuses-editor-behind-open-modal fixes for a modal that was open before the capture. The check also treats the dialog and the three panel flags differently.
- Fix: At focus time, check every modal the command closed before the create, not only the dialog: focus the editor only when no dialog shows and preferencesOpen, importOpen and titleRenamesOpen are all false (for example one private `#modalOpen` getter used both here and by the closing code above).
- Fix prompt: In src/app/actions/public/workspace/model.ts WorkspaceModel.newScratchNote, the line `if (created?.shown && !this.dialog) this.#focusEditor(true)` checks only the dialog. Add a private getter (for example `get #modalOpen()`) that is true when this.dialog is set or preferencesOpen, importOpen or titleRenamesOpen is true, and focus the editor only when `created?.shown && !this.#modalOpen`. Add a model test: hold /api/scratch/create (net.hold), call newScratchNote(), set preferencesOpen = true (as opening Preferences does) while the create is held, release it, and expect no editor-focus request (takeEditorFocus() returns null and no focus event fired).

## issue-76/11: The scratch-folder exclusion is checked by hand at each Vault call site, in a vault module that now names the app's scratch feature

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-vault-exclusion-enforced-per-call-site

- Symbol: Vault.#guardHolder
- Location at filing time: src/vault/vault.ts:304
- Title: The scratch-folder exclusion is checked by hand at each Vault call site, in a vault module that now names the app's scratch feature
- Problem: Keeping the scratch folder out of a vault that holds it is one rule. This diff enforces it in many places: #resolve replaces resolveInside at about 20 call sites, #guardHolder is called by hand in deleteNote, restore (twice), deleteFolder and #relocateNote/#relocateFolder, the watcher and the scan each get their own `this.#excluded` filter, and emptyTrash gets removeExcept. Three resolveInside(this.root, …) calls still bypass #resolve (the trash destinations in deleteNote and deleteFolder, and #trashPath), so the file mixes two resolution rules for the same purpose. Any new Vault method that touches the disk has to remember both the resolver and the holder guard, and nothing points that out. The open 11-r6 misses (trash destinations, export assets, symlink and case variants) are this design showing. vault.ts was already 1273 lines and is now 1350, so the cross-cutting rule goes into an already-large file. The generic src/vault layer also now carries app wording and an app type: ScratchOverlapError in errors.ts, and 'scratch notes’ folder' messages in paths.ts resolveInside and #guardHolder, although the option is the generic `exclude`.
- Fix: Make the exclusion one owned rule rather than a check per method. Route every path Vault builds, trash destinations included, through one resolver that applies the excluded-folder rule, and put the 'this entry holds the excluded folder' refusal into the single move/remove primitive that deleteNote, deleteFolder, restore and the relocations share. Then no method can skip it. Keep src/vault generic: name the error after the option (for example an ExcludedFolderError, or a VaultError code with the message passed in by the caller) and let VaultSession or the CLI supply the scratch wording.
- Fix prompt: In src/vault/vault.ts, replace the per-call-site exclusion checks with one enforcement point. (1) Make every path the Vault builds go through #resolve, including the trash destinations in deleteNote (trashDir), deleteFolder (trashParent) and #trashPath, so no raw resolveInside(this.root, …) call is left in the class. (2) Move the #guardHolder refusal into one shared helper that every rename or rm of a vault entry goes through (delete, restore, folder and note relocations, assets folder moves), instead of calling #guardHolder by hand before each one. (3) Keep src/vault free of app wording: rename ScratchOverlapError in src/vault/errors.ts to a generic name tied to openVault's `exclude` option, and drop 'scratch notes’ folder' from the messages in src/vault/paths.ts resolveInside and Vault.#guardHolder (use a generic 'excluded folder' text, or let the caller pass the message). Update src/main/vault-session.ts and src/cli/main.ts to the new name, and keep the existing tests in tests/vault/vault.test.ts and tests/cli/scratch-exclude.test.ts passing.

## issue-76/11: The CLI exclude test has to vi.mock node:os because appUserDataDir reads the home folder from a global

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-cli-exclude-test-mocks-node-os

- Symbol: the CLI and the scratch notes’ folder
- Location at filing time: tests/cli/scratch-exclude.test.ts:13
- Title: The CLI exclude test has to vi.mock node:os because appUserDataDir reads the home folder from a global
- Problem: runCli derives the scratch folder from appUserDataDir(io.env), and appUserDataDir reads os.homedir() directly. CliIo already injects env, stdin and output, but not the home folder. So the new test replaces homedir for the whole node:os module with a hoisted mutable `home.dir`, and must also set XDG_CONFIG_HOME and APPDATA so each platform's branch lands inside the temp folder. The test depends on which os function appUserDataDir calls, and the mock reaches every importer of node:os in the process.
- Fix: Pass the home folder through the seam that already exists: give CliIo (or appUserDataDir) the home folder, defaulting to os.homedir() at the entry point, and have the test pass the temp folder instead of mocking node:os.
- Fix prompt: In src/cli/vault-dir.ts and src/cli/main.ts, let appUserDataDir take the home folder as a parameter (for example appUserDataDir(env, home = os.homedir())), and give CliIo an optional `home` that runCli passes on. In tests/cli/scratch-exclude.test.ts, remove the vi.hoisted `home` object and the vi.mock('node:os') block, and pass the temp folder as `home` in the CliIo the cli() helper builds.

## issue-76/11: A discard test monkeypatches session.lock to count hold calls instead of observing the editor at the network boundary

Run: issue-76
Slice: 11 "Scratch notes hardening: carried review items"
Review: 11-r7
Reviewed commit: d99df9678da48ba01f91af5527c9f81daa0917e2
Ids, paths and line numbers below are as of the reviewed commit and may have moved since.

### [observation] thermo-discard-row-test-counts-lock-calls

- Symbol: closes a tab-less discarded row without holding the open note while no tab is active
- Location at filing time: tests/app/navigation.test.ts:1411
- Title: A discard test monkeypatches session.lock to count hold calls instead of observing the editor at the network boundary
- Problem: The test reassigns session.lock and counts its calls with locked=true, so it proves that Navigation never calls lock(true), which is how hold works inside. It does not prove what the user sees: that the open note stays editable while the discard request is out. A refactor that locks the session another way, or that calls lock(true) and then lock(false) before any await, changes the count without changing the behaviour, or the reverse. Sibling tests in the same describe ('keeps the active note editable while a background scratch tab’s blank check is out') and in model.test.ts ('keeps the open note editable while a discard of a scratch note with no tab is out') check the same rule at the boundary: they hold the request with net.hold and read session.locked.
- Fix: Assert the behaviour the way the sibling tests do. Hold POST /api/scratch/discard with net.hold, check session.locked is false while the request is out (and, if wanted, that session.edit is accepted), then release it. Do not reassign session.lock.
- Fix prompt: In tests/app/navigation.test.ts, rewrite 'closes a tab-less discarded row without holding the open note while no tab is active'. Remove the session.lock reassignment and the `holds` counter. Instead, hold the discard request with net.hold((url) => (url.pathname === '/api/scratch/discard' ? 'discard' : undefined), { once: true }), start navigation.discardScratch(other), wait with expect.poll until net.held has one entry, expect(session.locked).toBe(false), release the held request, await the discard, and keep the final scratchIds assertion. Mirror 'keeps the active note editable while a background scratch tab’s blank check is out' in the same describe.

## issue-76/retro: Detect and restart a hung subagent model request

Run: issue-76
Retro finding (factory, tool-economy, high)

In slice 11 fix round 4, implementer Impl11Fix4 stopped at 123 requests from 11:34; for about 15 minutes its session file got only cache-warm model_usage records (stopReason length). A message to agent://Impl11Fix4 did not wake it. The orchestrator had to find this by hand (proc status, session-file mtime), kill the agent and spawn a second implementer with a hand-written resume note about one commit and uncommitted edits. The earlier session of this run also aborted mid-implementer. The factory could watch implementer progress (no new request for N minutes) and give the orchestrator a resume recipe: kill, then spawn a fresh fix-mode implementer told which commits since the fix file exist and which tracked files are dirty.

## issue-76/retro: End-queue follow-up slice took 66 carried items in one slice

Run: issue-76
Retro finding (factory, no-ops, high)

Slice 11 carried 66 end-queue items from slices 01-10 (ticket 854 lines). Peak implementer context was 379,777 of the 400,000 budget, the slice used all 3 fix rounds, each fix round raised new findings (r1 3 high, r3 1, r5 1, r6 2, r7 1), and it ended accepted unresolved with high findings still open. factory_follow_up puts every waiting item into one slice; it should split the queue into several follow-up slices by area (for example store/routes, navigation/tabs, hotkeys, frontmatter, e2e) with an item or token cap per slice.

## issue-76/retro: Accepted-unresolved high findings are raised again by later reviews

Run: issue-76
Retro finding (factory, no-ops, medium)

bug-new-scratch-closes-busy-import-and-title-renames-dialogs was accepted unresolved after review 11-r5 and sent to DEFERRED.md. Review 11-r6 raised it again as holistic-new-scratch-closes-busy-import-and-title-renames-dialogs and the validator kept it high because accepted-unresolved findings are not in the KNOWN OBSERVATIONS ledger, so it had no rule to drop it. Add accepted-unresolved findings to the ledger the validator checks, marked as accepted unresolved.

## issue-76/retro: Fix-mode advisor pushed design churn beyond the fix items

Run: issue-76
Retro finding (factory, coding-standards, medium)

In fix round 4 an advisor blocker made the implementer rework openVault's scratch-folder rule three times (e32426e5 refuse holders, 7a718763 refuse assets holders, d99df967 open holders and guard moves/restores/empty-trash). The churn left stale 'overlap is refused' comments in src/cli/main.ts, src/vault/errors.ts and src/main/vault-session.ts, which became the high comments finding in 11-r6 and 11-r7 that no fix round remained to fix. In the last fix round, a design change that reverses earlier commits should stop as an Open question for the orchestrator instead of landing, and the comments sibling search should run on every commit of the round.

## issue-76/retro: pnpm run test fails on first run and passes on rerun

Run: issue-76
Retro finding (repo, automated-checks, medium)

factory_checks marked pnpm run test flaky three times in slice 11 (first run exit 1 in about 11-12s, pass on rerun). The implementer also saw a model.test.ts focus test ('leaves the editor focus alone when a new scratch note opens with an Update links? question parked under a prompt') fail under parallel load. Find the flaky vitest tests in tests/app (model.test.ts, navigation.test.ts) and remove their timing dependence, for example by awaiting the hold or gate the test depends on instead of sleeps.

## issue-76/retro: Editor stays read-only while overlapping holds run; New Scratch Note focuses it anyway

Run: issue-76
Retro finding (repo, information-access, medium)

Fix round 2 found that Navigation.hold unlocks the session only after every overlapping hold settles, but WorkspaceModel.newScratchNote focuses the new scratch editor when its own hold returns. A New Scratch Note or Quick capture started while an earlier close's hold still loads the next note focuses a read-only editor, and keys typed at once are dropped (seen in tests/e2e/scratch.spec.ts as 'eep this'). The e2e test now waits for an editable editor, but the product behaviour is unchanged. Add a Navigation/model test that overlaps a close with newScratch and asserts the focused editor is editable, then focus only once no hold runs.

## issue-76/retro: Import can copy scratch notes into a vault

Run: issue-76
Retro finding (repo, information-access, low)

Fix round 4 noted that importFiles/planImport can read a scratch .md, or a folder holding the scratch folder, that the user picks as an import source and copy it into the vault. openVault now keeps the scratch folder out of a vault, but import sources have no such exclusion.
