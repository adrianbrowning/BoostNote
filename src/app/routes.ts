import { get, post, route } from 'remix/routes'

/**
 * Every URL of the app. Pages and assets at the root; the workspace's JSON API under `/api`
 * (ids travel in query strings / JSON bodies because note ids are paths).
 */
export const routes = route({
  assets: get('/assets/*path'),
  home: get('/'),
  events: get('/events'),
  vendor: get('/vendor/*path'),
  /** `GET /vault-assets/<note id>?src=<link as written in the note>`: a file the note links to. */
  vaultAssets: get('/vault-assets/*path'),
  /** The hidden window that lays out mermaid diagrams for export (`src/main/export.ts`). */
  mermaidRenderer: get('/export/mermaid'),
  api: route('/api', {
    workspace: get('/workspace'),
    search: get('/search'),
    vaultPick: post('/vaults/pick'),
    vaultOpen: post('/vaults/open'),
    vaultClose: post('/vaults/close'),
    vaultForget: post('/vaults/forget'),
    noteRead: get('/notes/read'),
    noteCreate: post('/notes/create'),
    noteSave: post('/notes/save'),
    noteRename: post('/notes/rename'),
    noteMove: post('/notes/move'),
    noteDelete: post('/notes/delete'),
    noteReveal: post('/notes/reveal'),
    /** File › Rename Files From Titles…: `GET` the plan (dry run), `POST …/apply` to run (part of) it. */
    titleRenamesPlan: get('/notes/title-renames'),
    titleRenamesApply: post('/notes/title-renames/apply'),
    /** After a rename/move: `{ moves }` → links elsewhere still pointing at the old place (dry run / rewrite). */
    linksPlan: post('/links/plan'),
    linksApply: post('/links/apply'),
    folderCreate: post('/folders/create'),
    folderRename: post('/folders/rename'),
    folderMove: post('/folders/move'),
    folderDelete: post('/folders/delete'),
    folderColor: post('/folders/color'),
    trashRestore: post('/trash/restore'),
    trashEmpty: post('/trash/empty'),
    assetUpload: post('/assets'),
    importCandidates: get('/import/candidates'),
    importPick: post('/import/pick'),
    /** Drag and drop: `{ ticket, folder }` (a one-time ticket main granted for the dropped files) → copies in the vault. */
    importFiles: post('/import-files'),
    importRun: post('/import/run'),
    openExternal: post('/open-external'),
    preferences: get('/preferences'),
    preferencesSave: post('/preferences'),
    exportNote: post('/export/note'),
    exportFolder: post('/export/folder'),
    /** Takes the pending "open this file" request (a `.md` opened from Finder/Explorer or argv). */
    openRequest: post('/open-request'),
    /** A reader tab's outside `.md` (`{ name, body, frontmatter }`, read again each time), by its `ReaderGrants` ticket. */
    readerRead: get('/reader/:ticket'),
    /** The reader tab closed: revokes its ticket. */
    readerClose: post('/reader/:ticket/close'),
  }),
})
