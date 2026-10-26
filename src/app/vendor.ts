import * as path from 'node:path'
import { openLazyFile } from 'remix/fs'
import { createFileResponse } from 'remix/response/file'

import { routes } from './routes.ts'

const nodeModules = path.resolve(import.meta.dirname, '../../node_modules')

/**
 * Browser packages served verbatim instead of through the asset server. mermaid's self-contained ESM
 * build bundles lodash/UMD shims (`typeof exports == "object" && exports`) that the asset server's
 * CommonJS check rejects, although they never run in a browser. The editor imports it by bare
 * specifier; `vendorImportMap` points that specifier here.
 */
const VENDOR_PACKAGES: Record<string, { dir: string; files: RegExp }> = {
  mermaid: {
    dir: path.join(nodeModules, 'mermaid/dist'),
    files: /^(?:mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[\w-]+\.mjs)$/,
  },
}

/** Bare specifiers the asset server must leave alone (see `scripts.external` in `assets.ts`). */
export const vendorSpecifiers = ['mermaid/dist/mermaid.esm.min.mjs']

export const vendorImportMap = {
  imports: {
    'mermaid/dist/mermaid.esm.min.mjs': routes.vendor.href({ path: 'mermaid/mermaid.esm.min.mjs' }),
  },
}

/** `GET /vendor/<package>/<file>`: only the allow-listed files of each vendored package. */
export async function serveVendorFile(request: Request, filePath: string): Promise<Response> {
  const slash = filePath.indexOf('/')
  const vendor = VENDOR_PACKAGES[filePath.slice(0, slash)]
  const relPath = filePath.slice(slash + 1)
  if (slash < 0 || !vendor || !vendor.files.test(relPath)) return new Response('Not Found', { status: 404 })
  return createFileResponse(openLazyFile(path.join(vendor.dir, relPath)), request, {
    cacheControl: 'public, max-age=3600',
  })
}
