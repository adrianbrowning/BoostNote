// Electron entry point. Electron cannot execute TypeScript/JSX itself, so this plain-JS module
// registers Remix's on-the-fly TS/JSX loader (synchronous Node module hooks) and then imports the
// real main process. Every later import, including the Remix app in src/app, goes through the loader.
import 'remix/node-tsx'

import { app } from 'electron'

process.env.NODE_ENV ??= app.isPackaged ? 'production' : 'development'

await import('./main.ts')
