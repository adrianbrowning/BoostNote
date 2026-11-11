// Preloaded into the e2e app's main process (`-r`, see `launchApp` in fixtures.ts). Registers a
// session preload (`csp-violations-preload.cjs`) as the default session is created, before any
// window exists, so every page of the app, the hidden export windows included, records its
// `securitypolicyviolation` events from the very start of its load. `cspViolations` reads them.
const path = require('node:path')
const { app } = require('electron')

app.on('session-created', (session) => {
  session.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'csp-violations-preload.cjs') })
})
