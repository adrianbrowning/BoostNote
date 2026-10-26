#!/usr/bin/env node
// `boostnote` command line entry. Like src/main/index.js, this plain-JS module registers Remix's
// on-the-fly TS loader and then imports the real (TypeScript) entry. Runs on Node ≥ 24 from a
// checkout (`pnpm cli`) and on the app binary in the packaged app (`ELECTRON_RUN_AS_NODE=1`).
import 'remix/node-tsx'

const { processIo, runCli } = await import('./main.ts')

process.exitCode = await runCli(process.argv.slice(2), processIo)
