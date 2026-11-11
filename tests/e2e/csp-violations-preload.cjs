// Session preload for e2e runs only (registered by `csp-violations.cjs`). It runs before the page's
// own scripts, so it hears every CSP violation of the load, and exposes the record to the page as
// `window.boostCspViolations()`. Sandboxed preloads run as classic scripts, hence CommonJS.
const { contextBridge } = require('electron')

const seen = []
document.addEventListener('securitypolicyviolation', (event) => {
  // For an inline violation `blockedURI` is just "inline": the element and the script that inserted
  // it are the clues (the target is the document when the element is not in it).
  const target = event.target instanceof Element ? event.target.outerHTML.slice(0, 120) : String(event.target)
  const source = event.sourceFile ? `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}` : ''
  seen.push(`${event.effectiveDirective}: ${event.blockedURI || 'inline'} ${target} ${source}`.trim())
})
contextBridge.exposeInMainWorld('boostCspViolations', () => [...seen])
