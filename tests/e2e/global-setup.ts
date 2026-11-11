import { createRequire } from 'node:module'

/**
 * Electron fetches its binary the first time `electron` is resolved (it has no install script), and
 * every worker resolves it to launch the app. On a fresh install parallel workers would download and
 * unpack it at once and fail ('File exists'), so the binary is fetched here, once, before any worker.
 */
export default function globalSetup(): void {
  createRequire(import.meta.url)('electron')
}
