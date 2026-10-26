// The app's only preload. Everything else goes through boost:// routes, but a dropped `File` has no
// path in a sandboxed renderer and only `webUtils.getPathForFile` (a preload-side API) can get it;
// folder drops and the images next to a dropped note need the real path. Sandboxed preloads run as
// classic scripts, hence CommonJS. Exposes exactly one function: `window.boostnote.pathsForFiles`.
const { contextBridge, webUtils } = require('electron')

contextBridge.exposeInMainWorld('boostnote', {
  /** Absolute paths of dropped files/folders (`''` for a `File` not backed by one). */
  pathsForFiles: (files) => Array.from(files, (file) => webUtils.getPathForFile(file)),
})
