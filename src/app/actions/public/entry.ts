import { run } from 'remix/component'

// Hydrates every `clientEntry(...)` in the server-rendered document. Electron's Chromium supports
// multiple import maps natively, so plain dynamic `import()` is enough.
const app = run({
  async loadModule(moduleUrl, exportName) {
    const mod = await import(moduleUrl)
    const Component = mod[exportName]
    if (typeof Component !== 'function') {
      throw new Error(`Unknown component: ${moduleUrl}#${exportName}`)
    }
    return Component
  },
})

app.addEventListener('error', (event) => {
  console.error('Component error:', event.error)
})

await app.ready()
