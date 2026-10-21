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
    importRun: post('/import/run'),
    openExternal: post('/open-external'),
  }),
})
