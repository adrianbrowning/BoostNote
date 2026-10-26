// The app's only preload. Everything else goes through boost:// routes, but a dropped `File` has no
// path in a sandboxed renderer and only `webUtils.getPathForFile` (a preload-side API) can get it;
// folder drops and the images next to a dropped note need the real path. The paths go straight to
// main over IPC; the page only gets a one-time ticket to redeem at `POST /api/import-files`, so page
// script can never ask main to import a path of its own choosing. Sandboxed preloads run as classic
// scripts, hence CommonJS. Exposes exactly one function: `window.boostnote.grantDroppedFiles`.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('boostnote', {
  /** `{ ticket, count }` for the dropped `File`s backed by a file or folder on disk. */
  grantDroppedFiles: (files) =>
    ipcRenderer.invoke(
      'drop:grant',
      Array.from(files, (file) => webUtils.getPathForFile(file)).filter((path) => path !== ''),
    ),
})
