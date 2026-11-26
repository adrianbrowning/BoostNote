// Preloaded into the e2e app's main process (`-r`, see `startApp` in fixtures.ts). `globalShortcut` never
// reaches the OS: a test app neither takes a combination from the developer's other apps nor fights a running
// Boostnote for it. The registered accelerators and their callbacks are kept in `globalThis.boostGlobalShortcuts`
// (`pressGlobalShortcut` runs one), and an accelerator in `globalThis.boostTakenShortcuts` is refused, as one
// another app holds (`takeGlobalShortcut`). Like the OS, it refuses an accelerator already registered.
const { globalShortcut } = require('electron')

const registered = new Map()
const taken = new Set()
Object.assign(globalThis, { boostGlobalShortcuts: registered, boostTakenShortcuts: taken })

globalShortcut.register = (accelerator, callback) => {
  if (taken.has(accelerator) || registered.has(accelerator)) return false
  registered.set(accelerator, callback)
  return true
}
globalShortcut.isRegistered = (accelerator) => registered.has(accelerator)
globalShortcut.unregister = (accelerator) => {
  registered.delete(accelerator)
}
globalShortcut.unregisterAll = () => {
  registered.clear()
}
