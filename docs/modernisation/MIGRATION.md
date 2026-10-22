# Migrating from legacy Boostnote

Legacy Boostnote (0.x) kept notes in **storages**: a folder with `boostnote.json` (the folder list),
one `notes/<key>.cson` file per note and attachments under `attachments/<noteKey>/`. The modern app
keeps notes in a **vault**: any folder of plain markdown files with YAML frontmatter, readable by any
editor, `git`, Obsidian and so on.

The importer converts a storage into a new vault. It only reads the storage; the legacy app keeps
working with it exactly as before.

## What maps to what

| Legacy storage | Vault |
| --- | --- |
| Storage folder (`boostnote.json`, `notes/`, `attachments/`) | Vault folder you choose (must be empty) |
| Folder (`boostnote.json` → `folders[]`: key, name, color) | Top-level directory named after the folder. Characters that are invalid in file names become `-`; duplicate names (compared case-insensitively) get ` 2`, ` 3`, … |
| Folder colour | `.boostnote/config.json` → `folders["<dir>"].color` |
| Folder order | `.boostnote/config.json` → `folderOrder` |
| Notes whose folder is missing from `boostnote.json` | Directory `Unknown 1`, `Unknown 2`, … (the legacy app showed them the same way) |
| Markdown note (`MARKDOWN_NOTE`) | `<folder>/<title>.md`: the file name **is** the note's name, so it is the legacy title made safe for every OS (`noteFileName`, below), spaces and case kept; the content is unchanged apart from the links below |
| Snippet note (`SNIPPET_NOTE`) | Markdown note: `# title`, the description, then per snippet `## <name>` (or `## Snippet N`) and a fenced code block whose language comes from the snippet's mode (`JavaScript` → `javascript`, `C++` → `cpp`, `Plain Text` → `text`) |
| Empty title | `Untitled.md` |
| Duplicate titles in one folder (compared case-insensitively) | ` 2`, ` 3`, … appended to the file name (the oldest note keeps the plain name) |
| `title` | Frontmatter `title`, **only** when the file name cannot spell the title (it had `/ \ : * ? " < > \|`, control characters, leading/trailing dots, doubled spaces, a Windows device name such as `CON`, or was over ~120 characters), so the app still shows the exact legacy title |
| `tags` | Frontmatter `tags` (empty and non-text tags dropped) |
| `isStarred` | Frontmatter `starred: true` |
| `isPinned` | Frontmatter `pinned: true` |
| `createdAt`, `updatedAt` | Frontmatter `created`, `updated` (ISO-8601); the file's modification time is set to `updatedAt` |
| Note key and folder key | Frontmatter `boostnote: { key, folder }`, so every file can be traced back to its source |
| Frontmatter already inside the note content | Merged into the new frontmatter (legacy metadata wins on conflicts; each conflict is a report warning) |
| `isTrashed` | `.trash/<folder>/<file>.md` plus an entry in `.trash/.index.json`, so "Restore" in the app puts it back |
| Attachments `attachments/<noteKey>/*` | `<folder>/<file>.assets/*` next to the note, file names unchanged (all files are copied, referenced or not) |
| `:storage/<noteKey>/<file>` links (also `/:storage…`, `\` separators, `%5C`/`%2F` encoded) | `./<file>.assets/<file>` |
| Very old `:storage/<file>` links to the storage's `images/` folder | Copied into the note's `.assets/` folder and relinked |
| Note links `:note:<key>` | Relative links to the converted note (`./other.md`, `../Work/other.md`) |

File names come from `noteFileName(title)` (`src/vault/paths.ts`), the same rule the app uses for
new and renamed notes: `/ \ : * ? " < > |` and control characters become `-`, whitespace collapses
to one space, leading dots and trailing dots/spaces are dropped, the name is capped at 120
characters (and 200 bytes) on a character boundary, Windows device names get a `-` suffix
(`CON` → `CON-`), and an empty result is `Untitled`.

| Legacy title | File | Frontmatter `title` |
| --- | --- | --- |
| `Welcome to Boostnote!` | `Work/Welcome to Boostnote!.md` | — |
| `Welcome to Boostnote!` (second note) | `Work/Welcome to Boostnote! 2.md` | — |
| `Q1: plan / review?` | `Work/Q1- plan - review-.md` | `Q1: plan / review?` |
| `CON` | `Work/CON-.md` | `CON` |
| (empty) | `Work/Untitled.md` | — |

### Vaults imported before readable names

Earlier versions of the importer used lower-case slugs (`welcome-to-boostnote.md`,
`welcome-to-boostnote-2.md`) and relied on the first `# H1` for the displayed name. The app now
shows the file name (or a frontmatter `title`), so such a vault shows slugs. **File › Rename Files
From Titles…** fixes that: it lists, per folder, every note whose file name is still the slug of its
title (frontmatter `title`, else first H1) and the readable name it would get, and renames them
when you confirm. Files you named yourself (say `1-1/Craig.md` starting with `# 2026-09-18`) are
not slugs of their heading and are left alone. Each renamed note's `.assets/` folder moves with it,
links to it (and into its assets) from every other note are rewritten, and a frontmatter `title`
that now equals the file name is removed. The trash is not touched.

### Dropped

- **Blog metadata** (`blog.blogLink`, `blog.blogId`): WordPress publishing no longer exists.
- **Highlighted lines** (`linesHighlighted`) of markdown notes and snippets.
- **Snippet-note structure**: snippets become sections of one markdown note; the separate
  name/mode/content fields are not kept.
- App settings stored by the legacy app (themes, keymaps, hotkeys, the storage list).

## How to run it

Command line (available now):

```sh
pnpm migrate <legacyStorageDir> <targetVaultDir> [--dry-run] [--force]
```

- `--dry-run` prints what would be converted (counts, renames, unresolved links) and writes nothing.
- `--force` allows a target that already contains files. Existing files are never overwritten: the
  imported folders get new names (`Work 2`) instead, and `config.json`/the trash index are merged.

The legacy app created its first storage at `~/Boostnote`; other storages are wherever you added
them (Preferences → Storage in the legacy app). The in-app **Import Boostnote storage…** command
arrives in phase 4 and lists these automatically (`findLegacyStorages()`).

Programmatic use (what the app calls):

```ts
import { findLegacyStorages, migrateStorage } from './src/migrate/index.ts'

const report = await migrateStorage('/Users/me/Boostnote', '/Users/me/Notes', { dryRun: true })
```

## Safety

- **Non-destructive.** The legacy storage is opened read-only; nothing in it is written, moved or
  renamed (pre-1.0 storages that keep notes in `<folder>/data.json` are read as they are, not
  upgraded in place).
- **Empty target by default.** The importer refuses a target folder that already has files unless
  `--force` is given (`.DS_Store`, `Thumbs.db` and `desktop.ini` do not count), and refuses a target
  inside the legacy storage.
- **No overwrites.** Every file is created with "fail if it exists".
- **Report.** Every run returns a report and, unless it is a dry run, saves it as
  `<vault>/.boostnote/migration-report.json`: counts, every converted note with its new path,
  renamed folders/notes, unresolved attachments and note links, unreadable notes and warnings.
  Problems never abort the run; they are listed in the report.

## Rollback

Nothing to undo in the legacy storage: it is untouched, and the legacy app still opens it. To start
over, delete the vault folder and run the importer again. Changes you make in the new app are only
in the vault; they do not flow back to the legacy storage.

## Known limitations

- Only links in the `:storage/…` and `:note:…` forms are rewritten. Absolute `file://` paths into a
  storage stay as they are.
- A note link to a trashed note points at the place that note returns to when restored, so it only
  resolves after restoring it (reported as a warning).
- Attachments that the note references but that are missing from the storage keep their original
  `:storage/…` link and are listed under `unresolvedAttachments`.
- Snippet modes are mapped by name; uncommon modes become a lower-cased fence language
  (`Common Lisp` → `common-lisp`), which some highlighters may not recognise.
- Legacy storages synced to multiple machines are imported as they are on this machine; run the
  importer once and sync the vault instead.
