import * as path from 'node:path'
import { createAssetServer } from 'remix/assets'
import { loadConfig } from 'remix/cli'

/** Project root: the asset server resolves `remix.json` paths from here, in dev and in the packaged app. */
export const rootDir = path.resolve(import.meta.dirname, '../..')

const isDevelopment = process.env.NODE_ENV === 'development'

const config = await loadConfig(rootDir)
if (config.assets === undefined) throw new Error(`Missing "assets" in ${rootDir}/remix.json`)

export const assets = createAssetServer({
  ...config.assets,
  rootDir,
  sourceMaps: isDevelopment ? 'external' : undefined,
  minify: !isDevelopment,
  // Recompile browser sources as they change during `pnpm dev`; packaged sources never change.
  watch: isDevelopment,
  fingerprint: !isDevelopment,
  onError(error) {
    console.error('Failed to build client asset', error)
  },
})

export const scriptEntry = await assets.getScriptEntry('src/app/actions/public/entry.ts')
export const baseStylesHref = await assets.getHref('src/app/ui/public/base.css')
