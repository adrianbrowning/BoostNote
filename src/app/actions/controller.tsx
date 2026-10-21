import { stat } from 'node:fs/promises'
import { openLazyFile } from 'remix/fs'
import { createFileResponse } from 'remix/response/file'
import { createController } from 'remix/router'

import { assets } from '../assets.ts'
import { errorResponse, HttpError, requireString } from '../http.ts'
import { routes } from '../routes.ts'
import type { AppServices } from '../services.ts'
import { serveVendorFile } from '../vendor.ts'
import { preferencesState } from './api/preferences.ts'
import { workspaceData } from './api/workspace-data.ts'
import { HomePage } from './home-page.tsx'

/**
 * Vault files are user content: even when one is opened as a document (an `.svg` or `.html` asset),
 * it must not run script with the app's origin.
 */
const VAULT_ASSET_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

export function createRootController(services: AppServices) {
  return createController(routes, {
    actions: {
      async assets(context) {
        return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
      },
      async home(context) {
        return context.render(
          <HomePage initial={await workspaceData(services)} preferences={preferencesState(services)} />,
        )
      },
      events(context) {
        return services.events.subscribe(context.request.signal)
      },
      vendor(context) {
        return serveVendorFile(context.request, context.params.path)
      },
      async vaultAssets(context) {
        try {
          const vault = services.vaults.current
          if (!vault) throw new HttpError(404, 'NO_VAULT', 'No vault is open')
          // `vault.assetPath` rejects links that leave the vault (also via symlinks) or enter dot-directories.
          const file = await vault.assetPath(
            context.params.path,
            requireString(context.url.searchParams.get('src'), 'src'),
          )
          if (!(await stat(file).catch(() => undefined))?.isFile()) {
            throw new HttpError(404, 'NOT_FOUND', 'Asset not found')
          }
          const response = await createFileResponse(openLazyFile(file), context.request, { cacheControl: 'no-cache' })
          response.headers.set('Content-Security-Policy', VAULT_ASSET_CSP)
          return response
        } catch (error) {
          return errorResponse(error)
        }
      },
    },
  })
}
