import type { ScriptEntry } from 'remix/assets'
import type { Handle } from 'remix/component'
import { ImportMap } from 'remix/component/server'
import { getContext } from 'remix/middleware/async-context'
import { getCspNonce } from 'remix/middleware/csp'

import { vendorImportMap } from '../vendor.ts'

export interface EntryHeadProps {
  /** A browser entry from `assets.getScriptEntry` (`scriptEntry`, `mermaidRendererEntry`). */
  entry: ScriptEntry
}

/**
 * The head tags that load a browser entry: its import map (with the vendored packages), module
 * preloads and module script. `render()` stamps the CSP nonce on the import map; these authored
 * tags read it themselves.
 */
export function EntryHead(handle: Handle<EntryHeadProps>) {
  return () => {
    const { href, importMap, preloads } = handle.props.entry
    const nonce = getCspNonce(getContext())
    return (
      <>
        <ImportMap value={{ ...importMap, imports: { ...importMap.imports, ...vendorImportMap.imports } }} />
        {preloads.map((preloadHref) => (
          <link key={preloadHref} rel="modulepreload" href={preloadHref} nonce={nonce} />
        ))}
        <script type="module" src={href} nonce={nonce}></script>
      </>
    )
  }
}
