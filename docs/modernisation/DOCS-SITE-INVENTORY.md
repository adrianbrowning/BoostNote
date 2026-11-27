# User guide: feature inventory


**Conventions.** ⌘ = Ctrl on Windows/Linux. Every menu accelerator comes from one command table (`src/shared/commands.ts:36-95`), and the menu is built from it (`src/main/menu.ts:39-202`). Below, "fixture" means `tests/e2e/fixtures.ts`.

## Shared notes for all screenshots

- **Launch.**
  - `launchApp(files, { vaultCopyOf, ui })` starts the app (fixtures.ts:119).
  - `vaultCopyOf` copies a demo vault into a temp folder, so a real vault is never opened (fixtures.ts:106, 123).
  - `ui` is merged into `settings.json` (fixtures.ts:108, 132).
  - It waits for `[data-connection="connected"]` before menu commands work.
- **Theme.**
  - The setting is `ui.theme`: `'system' | 'light' | 'dark'` (`src/main/settings.ts:15`). The default is `'system'` (settings.ts:68). Valid values are checked at settings.ts:179.
  - It is applied through `nativeTheme.themeSource` (`src/main/preferences.ts:52`).
  - To force it, use `launchApp(files, { ui: { theme: 'dark' } })` or `test.use({ ui: { theme: 'light' } })` (fixtures.ts:374).
  - Avoid `page.emulateMedia({ colorScheme })` (reader-diagrams.spec.ts:35) for whole-app shots. Main's themeSource also drives the editor and mermaid theme. [INFERENCE] emulateMedia alone could leave the two out of step.
  - Shoot each page twice, once light and once dark.
- **Native UI cannot be captured.** `page.screenshot` shows only the renderer: no OS menu bar, native dialogs, native context menus, print dialog or message boxes. For those, show a menu path in text (e.g. **File › Export › Note as HTML…**) or a small styled mock-up.
- **Harness helpers.**
  - `clickMenu(id)`: menu ids = command ids; Select Tab items are `select-tab-1…9` (menu.ts:66-82).
  - `answerSaveDialog(path)`, `answerOpenDialog(folder)`, `writeFiles`, `openLooseFile`, `pressGlobalShortcut`, `relaunchApp`, `captureContextMenus` (fixtures.ts:349).
- **Existing shots.** Some specs already take screenshots: app.spec.ts:58, drop.spec.ts:72 and :96. They show the pattern works.

---

## Page 1 — Get started

**Open a folder as a vault**
- Steps: on the welcome screen click **Open folder…**, or use **File › Open Folder…** (⌘O). Pick a folder. Any folder of `.md` files works.
- You see: the sidebar (folders, tags, Starred, Trash), the note list and the editor. The status bar shows the vault path and note count.
- Tips:
  - Notes stay plain `.md` files, so git, sync tools and other editors keep working.
  - Open vaults are reopened on the next start.
- Source: readme.md Features; welcome screen workspace.tsx:177-219; commands.ts:42.
- Screenshot:
  1. Welcome screen: launch with an empty `vaults` list. The fixture always seeds a vault, so write `settings.json` without `lastVault` (or close the vault through the vault menu → `Close <vault>`, sidebar.tsx:43). Capture `getByRole('main', { name: 'Welcome' })` (scratch.spec.ts:71).
  2. Main window: launch with the demo vault. Capture `getByRole('navigation', { name: 'Vault' })`, `getByRole('region', { name: 'Notes' })` and `[data-editor]` (layout.spec.ts:58-59).

**Tour the window: sidebar, note list, editor, status bar**
- Steps:
  - Drag the separators to resize panes.
  - **View › Toggle Sidebar** (⇧⌘E) and **View › Toggle Note List** (⇧⌘J) hide or show panes.
  - Pane sizes are remembered.
- Source: commands.ts:73-75; layout.spec.ts:83-147; settings `panes` settings.ts:24-30.
- Screenshot:
  1. Full window.
  2. After `clickMenu('toggle-sidebar')` (layout.spec.ts), a "focus mode" shot.
  - Separators: `getByRole('separator', { name: 'Resize sidebar' })` / `'Resize note list'` (layout.spec.ts:60-61).

**Open a .md file from Finder/Explorer**
- Steps: double-click a `.md` or `.mdx` file, or choose Open With › Boostnote.
- You see:
  - A file inside a known vault opens as a note in a tab.
  - Otherwise, a read-only **reader tab** with a banner: **Open folder as vault**, **Add to vault…**, Close.
- Tips:
  - The preference "Opening a .md or .mdx outside a vault" switches between *Read only* and *Open its folder as vault* (preferences-dialog.tsx:15-18).
  - Reader tabs are gone after a restart.
- Source: PLAN.md:523-608.
- Screenshot:
  - Run `openLooseFile(app, 'readme.md', body)` (fixtures.ts:50; used at reader-diagrams.spec.ts:19).
  - Capture `[data-reader-banner]`, `[data-reader-body]` and `[data-reader-tab]` (app.spec.ts:328-346).
  - The buttons are `[data-reader-open-folder]` (app.spec.ts:426) and `[data-reader-add]` → `getByRole('dialog', { name: 'Add to vault' })` (app.spec.ts:470-476).

**Work with several vaults**
- Steps:
  - Click the vault name at the top of the sidebar.
  - *Open* lists open vaults (✓ the current one, a tab count, × to close).
  - *Recent* lists remembered vaults. Then Open Folder…, Import Boostnote Storage…, Close <vault>.
  - Picking a vault switches at once, and its tabs come back.
- Source: sidebar.tsx:43-58; PLAN.md:198-212.
- Screenshot:
  - `answerOpenDialog(second)` then `clickMenu('open-folder')` (vaults.spec.ts:18).
  - Open `[data-vault-switcher]` → `getByRole('menu')` with `menuitemradio` entries (app.spec.ts:354-357; vaults.spec.ts:36-39).

**Coming from old Boostnote: import a storage**
- Steps: **File › Import Boostnote Storage…** (or the welcome-screen button) → pick the storage → **Preview** → **Import** → **Open imported vault**.
- Tips:
  - The old storage is only read, never changed.
  - Then **File › Rename Files From Titles…** turns slug file names into readable ones.
- Source: commands.ts:43-45; import-dialog.tsx:111; MIGRATION.md.
- Screenshot:
  - `clickMenu('import-storage')` → `getByRole('dialog', { name: 'Import Boostnote storage' })`, `[data-import-candidate=…]`, `[data-import-preview]`, `[data-import-summary]`, `[data-import-run]` (app.spec.ts:227-241).
  - Rename-from-titles: `clickMenu('rename-from-titles')` → `getByRole('dialog', { name: 'Rename files from titles' })`, `[data-title-rename]`, `[data-title-renames-apply]` (app.spec.ts:211-215).
  - Needs a legacy storage fixture. [INFERENCE] The app.spec import test points at an existing one; check `tests/fixtures` for a legacy storage.

---

## Page 2 — Write notes

**Create a note**
- Steps: **File › New Note** (⌘N), or the ✎ button above the note list. The note goes in the selected folder as `Untitled.md`, then `Untitled 2.md`, and so on.
- Source: commands.ts:39; note-list.tsx:130-140 (`data-new-note`).
- Screenshot: `clickMenu('new-note')` and capture the new list row plus the empty editor (app.spec.ts uses `new-note`).

**Rename a note**
- Steps: click the note name above the editor (or focus it and press F2/Enter). Type, then Enter. Esc cancels.
- Tips:
  - The file name *is* the note's name.
  - If the note has a frontmatter `title`, you edit that instead.
  - Clashing or invalid names show an inline error.
- Source: editor-pane.tsx:164-190; PLAN.md:693-760.
- Screenshot: `[data-rename-note]` click → `[data-note-title-input]`. Error state: `[data-rename-error]` (app.spec.ts:122-137).

**See formatting as you type (live preview)**
- You see:
  - Markdown markers hide when the cursor leaves a line or construct.
  - An unfocused note looks fully rendered.
  - Images, checkboxes, tables, math and diagrams render in place.
- Tip: click into a construct to see its source.
- Source: PLAN.md:119-131; readme.md Features.
- Screenshot: two shots of the same note. (a) Editor blurred: fully rendered. (b) Cursor inside a heading or link: markers shown. Editor: `[data-editor] .cm-content` (app.spec.ts:44).

**Format text with shortcuts**
- ⌘B bold, ⌘I italic, ⌘E inline code, ⇧⌘X strikethrough, ⌘K link.
- Enter continues lists, tasks and quotes; Enter on an empty item ends the list. Tab / ⇧Tab nests list items.
- `( [ { "` auto-close; typing `` ` * _ ~ `` wraps a selection.
- Source: PLAN.md:147-149.
- Screenshot: not needed. Use a keyboard table in the page.

**Insert blocks with / (slash commands)**
- Steps: type `/` at the start of a line or after a space. A filterable menu opens. Use arrows + Enter, or click. Esc closes.
- Behaviour: on an empty line the line becomes the block. Mid-text, the block goes after the current block.
- Commands (slash.ts:57-85):

  | Command | Inserts |
  | --- | --- |
  | Heading 1 / 2 / 3 | `#` / `##` / `###` |
  | Bulleted list | `- ` |
  | Numbered list | `1. ` |
  | Task list | `- [ ] ` |
  | Quote | `> ` |
  | Code block | ```` ``` ```` fence |
  | Mermaid diagram | a starter flowchart |
  | Math block | `$$ … $$` |
  | Table | opens a size grid |
  | Divider | `---` |
  | Date | `YYYY-MM-DD` (local time) |
  | Time | `HH:mm` (local time) |
  | Date and time | `YYYY-MM-DD HH:mm` (local time) |
  | Image | opens a file picker |

- Source: `src/editor/slash.ts:57-85`; date formats slash.ts:96-101.
- Screenshot:
  - Type `/` in the editor. Capture `.cm-tooltip-autocomplete` with `getByRole('option', …)` (slash-table.spec.ts:31-32).
  - Also type `/he` to show filtering.

**Insert a table**
- Steps: type `/table` → a grid opens. Hover or use arrows to choose the size (up to 10 × 10; the size shows as "3 × 4"). Click or Enter inserts it. Esc or a click outside cancels.
- Tip: the header cells are "Column 1…N" and the cursor lands in the first one.
- Source: slash.ts:43-51, 212-300.
- Screenshot:
  - `getByRole('dialog', { name: 'Table size' })` plus `getByRole('status')` (slash-table.spec.ts:35-45).
  - Cells `[data-columns][data-rows]` (slash-table.spec.ts:87).
  - Then the rendered table `.cm-lp-table` (live-preview-tables.spec.ts:43).

**Tick tasks and see progress**
- Steps: click a rendered checkbox.
- You see: a "Tasks done" progress bar above the note.
- Source: editor-pane.tsx:350-358.
- Screenshot: `getByRole('progressbar', { name: 'Tasks done' })` and `.cm-lp-checkbox` (app.spec.ts:151-157); fill `[data-task-progress-fill]` (layout.spec.ts:244).

**Add math, diagrams and code**
- Syntax:
  - Math: `$…$` inline, `$$…$$` or ```` ```math ```` blocks (KaTeX).
  - Diagrams: ```` ```mermaid ````.
  - Code: fenced code is syntax-highlighted.
- Tip: a broken diagram shows its error in place.
- Source: PLAN.md:123-140.
- Screenshot: a note with both. Wait for `[data-editor] .cm-lp-mermaid svg` (app.spec.ts:54), blur the editor and capture. Do this for light and dark.

**Add images**
- Steps: paste or drop an image into the editor, or use `/image`. Images are stored next to the note in `<note>.assets/`.
- Tips:
  - A pasted lone http(s) URL becomes an image link.
  - Pasted HTML becomes Markdown.
- Source: PLAN.md:149-154.
- Screenshot: a demo note with an image already in `X.assets/`. Pasting is hard to stage, so a static shot is enough.

**Links between notes**
- Steps: relative `.md` links open in the app (⌘-click opens in a new tab). Web links open in the browser.
- Source: PLAN.md:270-272; app.spec.ts:165.
- Screenshot: `.cm-lp-link` (app.spec.ts:172).

**Find text in a note**
- Steps: **Edit › Find…** (⌘F) opens the search panel.
- Source: commands.ts:72.
- Screenshot: `clickMenu('find')` → `.cm-search` (scratch.spec.ts:163).

**Fix spelling**
- Steps: right-click a misspelled word. You get up to 5 suggestions (or "No suggestions"), then "Add to Dictionary", then Cut/Copy/Paste/Select All.
- Tip: turn spell checking off in Preferences.
- Source: `src/main/context-menu.ts:14-36`.
- Screenshot: **cannot**, because it is a native menu. Instead, take the labels with `captureContextMenus` (spelling.spec.ts:33-80) and render them as a text list or mock-up. Optionally capture the red underline in the editor first.

**Edits from other apps: live reload and the conflict bar**
- You see:
  - A note changed by another app updates by itself.
  - If you were also editing, a bar appears: **Keep mine** or **Load theirs**.
  - If the file was deleted or moved: **Save my copy** or **Close**.
  - If saving fails: **Retry**.
- Tip: you can't leave a note while its conflict is unresolved, so nothing is lost silently.
- Source: PLAN.md:255-263; editor-pane.tsx:225-252.
- Screenshot:
  - Clean live reload: `writeFiles(vault, …)` while the note is open (app.spec.ts:72).
  - Conflict bar: type in the editor, then `writeFiles` the same file → `[data-conflict="changed"]` with `Keep mine` / `Load theirs` (conflict-bar.spec.ts:36, 211; cli.spec.ts:44).
  - Removed: rm the file → `[data-conflict="removed"]` (`Save my copy`, conflict-bar.spec.ts:279).
  - Error: `failableSaves(page).fail(true)` → `[data-conflict="error"]` (conflict-bar.spec.ts:20-37).

**MDX notes**
- `.mdx` files open and save like notes. MDX components are not rendered: tags are dropped and their inner text is kept.
- Source: PLAN.md:500-507; mdx.spec.ts:6-26.
- Screenshot: optional. `[data-note="doc.mdx"]` (mdx.spec.ts:10).

---

## Page 3 — Organise notes

**Make folders and colour them**
- Steps:
  - New folder: **File › New Folder…** (⇧⌘N), the + next to Folders, or a folder's menu → New Folder….
  - Folder menu (right-click or "Folder actions for X"): New Note, New Folder…, Export as HTML…, Rename…, Move to Trash, and colour swatches.
  - The 7 colours are `#E10051, #FF8E00, #E8D252, #3FD941, #30D5C8, #2BA5F7, #B013A4`, plus *No colour*.
  - Expand or collapse subfolders with the disclosure button.
- Source: sidebar.tsx:68-78, 139-172; model.ts:111; overlays.tsx:53-75.
- Screenshot:
  - Right-click `[data-folder="work"]` → `getByRole('menuitemradio', { name: 'Colour #E10051' })`, then the dot `[data-folder-swatch]` (layout.spec.ts:189-210).
  - Nesting: `getByRole('button', { name: 'work subfolders' })` (layout.spec.ts:216).

**Move notes and folders**
- Steps: drag a note or folder onto a folder, or use the note menu → **Move to…** → choose a folder → **Move**.
- Source: model.ts:863; relocation.spec.ts:24-27.
- Screenshot: `getByRole('dialog', { name: 'Move note' })` (relocation.spec.ts:25).

**Keep links working when you rename or move**
- You see: the dialog "Update links? N links in M notes point to “name”." with the notes listed. **Update links** (Enter) or **Don't update** (Esc). Afterwards a notice says "Updated N links".
- Tip: the dialog only appears when other notes link to the item.
- Source: PLAN.md:784-850; overlays.tsx:186.
- Screenshot: write a linker note, then rename the target (app.spec.ts:1023-1048) → `getByRole('dialog', { name: 'Update links?' })`, `[data-link-notes]`.

**Tag notes**
- Steps:
  - Open properties (ⓘ or ⇧⌘P) and type a tag in the Tags field. Enter or comma adds it; Backspace removes the last one. It autocompletes from existing tags.
  - Click a tag in the sidebar to filter the list.
- Source: PLAN.md:387-397; properties.tsx:210; sidebar.tsx:245-255.
- Screenshot: chips `[data-tag-chip=…]` (properties-refused.spec.ts:31); sidebar `[data-tag="fruit"]` click (app.spec.ts:1014).

**Star a note**
- Steps: ★ in the note header ("Star note"/"Unstar note"), or the properties panel. The sidebar **Starred** shows all starred notes.
- Source: editor-pane.tsx:312; sidebar.tsx:222.
- Screenshot: `[data-sidebar="starred"]` (app.spec.ts:1016).

**Pin a note to the top**
- Steps: 📌 in the header ("Pin note"), the Pinned checkbox in properties, or the note menu → Pin/Unpin.
- You see: pinned notes come first in every list, including search results.
- Source: PLAN.md:399-407; model.ts:860.
- Screenshot: right-click a row → `getByRole('menuitem', { name: 'Pin', exact: true })`; marker `[title="Pinned"]`; header `getByRole('button', { name: 'Pin note' })` (app.spec.ts:965-987).

**Edit properties (frontmatter)**
- Steps: **View › Toggle Properties** (⇧⌘P) or the ⓘ button.
- What you can edit:
  - Tags, starred, pinned.
  - Created and updated are read-only.
  - Other keys by type: text, number, checkbox, date, list.
  - Rename, remove or add keys ("New property name/type").
- Tip: invalid YAML stays in the note body, and the panel says so.
- Source: PLAN.md:387-397; properties.tsx:185-349.
- Screenshot: `clickMenu('toggle-properties')` or `[data-toggle-properties]` → `[data-properties]`; rows `[data-property=…]`; `getByRole('textbox', { name: 'New property name' })` (properties-refused.spec.ts:15-21; delete-refused.spec.ts:66). Needs a demo note with rich frontmatter.

**Delete and restore (Trash)**
- Steps: note or folder menu → **Move to Trash** (asks first, unless turned off). Sidebar **Trash** → **Restore** per item, or **Empty Trash**.
- Source: model.ts:866, 1144; note-list.tsx:93-130.
- Screenshot: `getByRole('menuitem', { name: 'Move to Trash' })` (delete-refused.spec.ts:33), then click Trash (`[data-sidebar="trash"]`, pattern from app.spec.ts:1016) → `[data-trash]` list.

**Sort the note list**
- Steps: the *Sort notes* dropdown: Updated, Created, Title.
- Source: note-list.tsx:9-12, 154.
- Screenshot: `getByRole('combobox', { name: 'Sort notes' })` (app.spec.ts:965).

**Show the file on disk**
- Steps: **File › Reveal in Finder** (⌥⌘R; "Show in Explorer"/"Show in Folder" elsewhere) or the note menu.
- Source: commands.ts:53-58.
- Screenshot: none (the OS file manager).

---

## Page 4 — Find notes

**Search all notes**
- Steps: type in *Search notes* above the list. Results are ranked best first (title, tags, body); pinned notes stay first.
- Tip: in the CLI, `#tag` matches tags only (main.ts:114). [INFERENCE] The same may hold in the app search box; check the vault index before documenting it.
- Source: note-list.tsx:146-150.
- Screenshot: `page.getByLabel('Search notes').fill('kiwi')` (app.spec.ts:992).

**Browse: All notes, folders, tags, Starred**
- Source: sidebar.tsx:221-270.
- Screenshot: as in Page 3.

**Note-list previews**
- Each row shows a plain-text excerpt of up to 160 characters, plus ★/📌 markers.
- Source: PLAN.md:465-469.

---

## Page 5 — Tabs

**Open, close and switch tabs**
- Open in a new tab: ⌘-click, middle-click, or the note menu → **Open in New Tab**.
- Close: ⌘W, ×, or middle-click.
- Reopen closed tab: ⇧⌘T (40 remembered per vault).
- Switch: Ctrl+Tab / Ctrl+⇧Tab; ⌘1…⌘8 picks by position, ⌘9 the last tab.
- Drag a tab to reorder.
- Back/Forward: ⌘[ / ⌘], mouse buttons 4/5, or the arrows in the tab strip.
- Tabs are restored per vault.
- Source: commands.ts:59-95; PLAN.md:304-315; tab-strip.tsx:39-78.
- Screenshot:
  - Open 3–4 notes with ⌘-click. Capture `getByRole('tablist', { name: 'Open notes' })` / `[data-tab=…]` (app.spec.ts:86).
  - Back/Forward: `getByRole('button', { name: 'Back' })`.
  - Select: `clickMenu('select-tab-1')` (app.spec.ts:108).

---

## Page 6 — Quick capture (scratch notes)

**Jot something down without choosing a folder**
- Steps: **File › New Scratch Note** (⌥⌘N). This works with no vault open.
- You see:
  - A tab with a "Scratch" badge; the text autosaves.
  - A banner says links to notes, images and properties need a vault note.
- Tips:
  - Closing an empty scratch tab deletes it. One with text is kept.
  - Scratch tabs come back after a restart.
- Source: commands.ts:41; PLAN.md:356-385, 610-635.
- Screenshot: `clickMenu('new-scratch-note')` → `[data-scratch-tab]`, `[data-scratch-badge]`, `[data-scratch-banner]` (scratch.spec.ts:19-143).

**Quick capture from anywhere (global hotkey)**
- Steps: set a hotkey in Preferences under "Quick capture: a new scratch note from anywhere". It is off by default. Pressing it from any app shows Boostnote with a new scratch note.
- Source: settings.ts:47, 72; preferences-dialog.tsx:80-84.
- Screenshot:
  - Set `ui: { captureHotkey: 'CommandOrControl+Alt+Shift+K' }`, then `pressGlobalShortcut(app, 'CommandOrControl+Alt+Shift+K')` (scratch.spec.ts:458) and capture the scratch tab.
  - Recorder: `getByRole('group', { name: 'Quick capture…' })`, `[data-hotkey-record]`, `[data-hotkey-status]` (scratch.spec.ts:489-498).

**Keep, reopen, discard or move scratch notes into a vault**
- Steps: kept scratch notes are listed in the sidebar "Scratch" section, on the welcome screen, or in a side panel when no vault is open. Click a row to reopen it. Use **Save to vault…** (pick a folder → **Save**) or **Discard**.
- Source: scratch-list.tsx:21-53; editor-pane.tsx:327-339.
- Screenshot:
  - `getByRole('region', { name: 'Scratch' })`, `[data-scratch-row]`, `getByRole('button', { name: 'Save to vault…' })` → `getByRole('dialog', { name: 'Save to vault' })` (scratch.spec.ts:248-308).
  - Discard: `getByRole('dialog', { name: 'Discard scratch note' })` (scratch.spec.ts:342).
  - Seed it by typing in a scratch tab and closing it (`clickMenu('close-tab')`).

**Show or hide Boostnote from anywhere**
- Default ⇧⌘Space (`CommandOrControl+Shift+Space`, settings.ts:60). Change or turn it off in Preferences.
- Status text: "Active." / "Not active: another app may use this combination."
- Source: preferences-dialog.tsx:75-79, 164-166.
- Screenshot: the recorder in Preferences only (the effect is a window show/hide).

---

## Page 7 — Share and export

**Export a note**
- **File › Export ›**:
  - **Note as HTML…**: a standalone page with math, diagrams and images, and no scripts.
  - **Note as PDF…**: A4.
  - **Note as Markdown…**: the note with its assets.
- Source: commands.ts:47-49; PLAN.md:473-521.
- Screenshot:
  - The dialog cannot be captured (native).
  - Capture the result: `answerSaveDialog(target)` + `clickMenu('export-html')` (app.spec.ts:247-256). Then open the HTML in a page (`page.goto('file://…')` on a new Electron window or a Playwright browser) [INFERENCE] and screenshot it.
  - PDF: show an image of the first page. [INFERENCE] It could be rendered with a PDF viewer; otherwise skip.

**Export a folder or the whole vault as a website**
- Steps: **File › Export › Folder as HTML…** or **Vault as HTML…**, or a folder's menu → **Export as HTML…**.
- Result: a `<name> (HTML)` folder with one page per note, an `index.html` listing and working links. The folder is revealed when done.
- Source: commands.ts:50-51; PLAN.md:486-499, 519-521.
- Screenshot: `answerOpenDialog(dir)` + `clickMenu('export-folder')`, then open `index.html` and capture it.

**Print**
- **File › Print…** (⌘P) opens the system print dialog.
- Source: commands.ts:52.
- Screenshot: none (native).

---

## Page 8 — Bring notes in

**Drag Markdown files into the app**
- Steps: drop `.md`/`.markdown`/`.mdx` files or folders from Finder/Explorer onto a sidebar folder (it highlights), or anywhere else for the selected folder.
- You see: "Imported N notes into <folder> (M images copied, K skipped)" with details.
- Tips:
  - Originals are copied, never moved or changed.
  - Images and files they link to go into `.assets`.
  - Links between dropped notes keep working.
  - Limits: 2000 files / 512 MB.
- Source: PLAN.md:904-970.
- Screenshot: use the `dropFiles` helper (drop.spec.ts:20-46): `setInputFiles` + a dispatched `DragEvent` onto `section[aria-label="Notes"]` or `[data-folder=…]`. Capture `[data-notice]` + `[data-notice-details]` (drop.spec.ts:66-72). Folder drops can't be staged in e2e.

**Add a file you opened read-only to the vault**
- Reader tab → **Add to vault…** → pick a folder → **Add**.
- Screenshot: see Page 1 (app.spec.ts:470-476).

**Import old Boostnote**
- See Page 1.

---

## Page 9 — Customise (Preferences)

- Open: **Boostnote › Settings…** (macOS) or **File › Preferences…** (⌘,) (commands.ts:62-67; menu.ts:91-121).
- Every change applies at once (preferences-dialog.tsx:174-176).

| Option (dialog label) | Values | Default | Source |
| --- | --- | --- | --- |
| Theme | Match system / Light / Dark | Match system | preferences-dialog.tsx:8-12; settings.ts:68 |
| Editor font | any font name; blank = system font | blank | settings.ts:69 |
| Font size (px) | 10–32 | 16 | settings.ts:70, 180 |
| Line width (px, 0 = full width) | 0 or 400–2000 | 736 | settings.ts:71, 181 |
| Table width | Line width / Full pane width / Custom (then "Table width (px)" 400–2000; Custom starts at 1200) | Line width | preferences-dialog.tsx:20-27; settings.ts:72 |
| Check spelling while typing | on/off | on | settings.ts:73 |
| Ask before moving notes and folders to the Trash | on/off | on | settings.ts:74 |
| Check for updates automatically | on/off | on | settings.ts:77 |
| Opening a .md or .mdx outside a vault | Read only / Open its folder as vault | Read only | settings.ts:79 |
| Show/hide Boostnote from anywhere | hotkey recorder + Turn off | ⇧⌘Space | settings.ts:60, 75 |
| Quick capture: a new scratch note from anywhere | hotkey recorder + Turn off | off | settings.ts:76 |

- Not in the dialog, but remembered: pane widths and collapsed panes, and whether properties are open (settings.ts:80).
- Hotkey rules: a hotkey needs a modifier other than Shift, unless it is a function key (settings.ts:106-116). The two hotkeys can't be the same combination.
- Screenshot:
  - `clickMenu('preferences')` → `getByRole('dialog', { name: 'Preferences' })` / `[data-preferences]` (scratch.spec.ts:489; app.spec.ts:847).
  - Table width: `getByRole('combobox', { name: 'Table width', exact: true })` / `getByRole('spinbutton', { name: 'Table width (px)' })` (reader-tables.spec.ts:95-108).
  - A before/after pair at fontSize 16 vs 20 and lineWidth 736 vs 0 (`ui` launch option, as in layout.spec.ts:56-76).

**Updates**
- Behaviour: once a day (and 10 s after start) the installed app checks GitHub. The status bar shows "Boostnote X.Y.Z is available — Download ×". Download opens the release page; × hides that version.
- Manual check: **Check for Updates…** (app menu on macOS, Help elsewhere) answers in a native box.
- Tip: Boostnote never downloads or installs anything itself.
- Source: readme.md Updates; workspace.tsx:288-304; updates.ts:10, 66; main.ts:49-54.
- Screenshot:
  - Before launch, set `process.env.BOOSTNOTE_UPDATE_URL` to a local HTTP server that returns `{"tag_name":"v99.0.0","html_url":"https://…"}`. The fixture passes `process.env` through.
  - Wait more than 10 s for `[data-update-notice]` and capture the status bar.
  - The manual-check message box is native: describe it in text.

---

## Page 10 — Use from the terminal and AI tools

None of this can be screenshotted. Use terminal code blocks, with output from real `pnpm cli …` runs against a copy of the demo vault.

- **Install:**
  - macOS/Linux: **Install Command Line Tool…** (app menu on macOS, Help on Linux) writes `boostnote` to `/usr/local/bin` or `~/.local/bin` and says whether it is on PATH.
  - Windows: **Help › Command Line Tool…** shows the command to use.
  - The result is a native message, so show it as text.
  - Source: menu.ts:52-57; PLAN.md:888-895.
- **Choosing the vault:** `--vault <dir>`, else `$BOOSTNOTE_VAULT`, else the vault last open in the app.
- **Ids and output:** a note id is its path in the vault (`.md` optional) or a bare name. `--json` gives machine-readable output.
- **Exit codes:** 0 ok, 1 error, 2 usage, 3 conflict, 4 not found (commands.ts:44).
- **Commands** (`src/cli/main.ts:104-180`):

  | Command | What it does |
  | --- | --- |
  | `list [--folder] [--recursive] [--tag] [--starred] [--pinned] [--sort updated\|created\|title\|id] [--limit]` | List notes, newest first |
  | `search <query> [--limit]` | Full-text search |
  | `read <id> [--raw]` | Show a note: properties, hash and body |
  | `create <folder> [--name] [--body \| <file] [--tag]…` | Create a note |
  | `write <id> (--body \| <file) [--base-hash]` | Replace the body |
  | `append <id> <text>` | Add text at the end |
  | `set-props <id> key=value… [--unset key]` | Set or remove properties |
  | `rename <id> <name> [--no-update-links]` | Rename; links follow |
  | `move <id> <folder> [--no-update-links]` | Move; links follow |
  | `trash <id>` | Move to the trash (restorable) |
  | `restore <trashId>` | Put a trashed note back |
  | `tags` | List tags with counts |
  | `folders` | Show the folder tree |
  | `tasks <id>` | Task-list progress of a note |
  | `mcp` | Run the MCP server |

- **MCP server** (`boostnote mcp`):
  - 14 tools: `list_notes`, `search_notes`, `read_note`, `create_note`, `write_note`, `append_to_note`, `update_properties`, `rename_note`, `move_note`, `trash_note`, `restore_note`, `list_tags`, `list_folders`, `task_progress`.
  - Every note is also a resource, `boostnote://note/<id>`.
  - Source: `src/cli/mcp.ts:75-253`.
  - Config snippets for Claude Desktop, Cursor and Claude Code are in readme.md "Command line and MCP".
- **With the app open:** the app reloads a note the CLI changed, or shows its conflict bar (cli.spec.ts:18-44). This is the one in-app shot for this page.
- **omp memory plugin** (`integrations/omp`): a developer add-on. [INFERENCE] Probably leave it out of the end-user guide, or give it one link.

---

## Demo content for screenshots

`tests/fixtures/sample-vault` holds only two notes:
- `Welcome.md`: tags `[intro]`, starred, and a link to Plan.
- `Projects/Plan.md`: tags `[work, todo]` and two tasks.

It has no images, mermaid, math, tables, colours, pins, assets or nesting.

The docs need their own demo vault (suggested `docs/site/demo-vault/`, copied with `vaultCopyOf`) containing:
- **Folders:** 2–3 levels (e.g. `Work/Projects/2026`, `Personal`, `Recipes`). Folder colours are stored by the app [INFERENCE] (vault metadata, not frontmatter). Set them during the script through the folder menu (layout.spec.ts:189-210), or check `src/vault` for the colour file and pre-write it.
- **A showcase note:** H1–H3, bold/italic/strike/code, a link to another note, a web link, a quote, a divider.
- **Media:** an image in `Showcase.assets/` (a real PNG), a GFM table (one wide table for the table-width option), a KaTeX inline + block, a mermaid flowchart, a highlighted code fence (ts, sh), and a task list with some items ticked (for the progress bar).
- **Tags, stars, pins:** frontmatter tags across notes (`work`, `ideas`, `recipe`), one or two starred and one pinned notes, a custom property (e.g. `status: draft`, `due: 2026-12-01`) for the properties panel.
- **Linking notes:** 2–3 notes linking to one target, for the "Update links?" dialog.
- **Search content:** enough notes (10–15) with real text for search and sort shots.
- **Trash:** an item, made in the script with Move to Trash.
- **Outside files:** one `.mdx` note (optional) and a loose `.md` for the reader tab (`openLooseFile`).
- **Scratch notes:** created in the script.
- **Legacy import:** a legacy storage fixture.
- **Updates:** a local server for the update notice.

**Constraints:** never point the app at the user's own vault (AGENTS.md). `vaultCopyOf` copies the folder and only reads it (fixtures.ts:106, 123).