// Preloaded into the e2e app's main process (`-r`, see `launchApp` in fixtures.ts). On macOS
// `BrowserWindow.show()`/`focus()` activate the app and make the window the key window, so a test app
// took over the keyboard at launch and key presses meant for another app (letters, arrow keys,
// shortcuts) landed in the test ('eWeekly plan'). Shown windows open inactive and can never become
// the key window (hidden ones, such as the export windows, are left alone); Playwright drives the
// page over CDP, which needs neither, and `launchApp` turns on focus emulation so the page still
// behaves as focused. Other platforms keep the real behaviour (Linux CI runs under xvfb).
const { BrowserWindow } = require('electron')

if (process.platform === 'darwin') {
  BrowserWindow.prototype.show = function show() {
    this.setFocusable(false)
    this.showInactive()
  }
  BrowserWindow.prototype.focus = () => {}
}
