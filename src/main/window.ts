import * as path from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell } from 'electron'

import { APP_ORIGIN } from './protocol.ts'
import type { SettingsStore, WindowBounds } from './settings.ts'

const DEFAULT_SIZE = { width: 1080, height: 720 }
const iconPath = path.resolve(import.meta.dirname, '../../resources/app.png')

/** Saved bounds, minus a position that no longer lands on any connected display. */
function restoreBounds(saved: WindowBounds | undefined): WindowBounds {
  if (!saved) return DEFAULT_SIZE
  const { x, y, width, height } = saved
  if (x === undefined || y === undefined) return { width, height }
  const onScreen = screen.getAllDisplays().some(({ workArea: area }) => {
    return x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y
  })
  return onScreen ? saved : { width, height }
}

function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

export interface MainWindowOptions {
  settings: SettingsStore
  /** True once a quit has been confirmed: closing the window then really closes it (macOS hides it otherwise). */
  isQuitting(): boolean
}

/** The single app window: sandboxed renderer that only ever shows `boost://app/` pages. */
export function createMainWindow({ settings, isQuitting }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...restoreBounds(settings.read().windowBounds),
    minWidth: 500,
    minHeight: 320,
    show: false,
    title: 'Boostnote',
    icon: iconPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e2124' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => {
    if (event.url.startsWith(`${APP_ORIGIN}/`)) return
    event.preventDefault()
    openExternal(event.url)
  })

  let saveTimer: NodeJS.Timeout | undefined
  const saveBounds = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
      settings.update({ windowBounds: window.getNormalBounds() })
    }, 500)
  }
  window.on('resize', saveBounds)
  window.on('move', saveBounds)

  // macOS convention (as in legacy Boostnote): closing the window hides it; Cmd+Q quits.
  if (process.platform === 'darwin') {
    window.on('close', (event) => {
      if (isQuitting()) return
      event.preventDefault()
      if (window.isFullScreen()) {
        window.once('leave-full-screen', () => window.hide())
        window.setFullScreen(false)
      } else {
        window.hide()
      }
    })
  }

  void window.loadURL(`${APP_ORIGIN}/`)
  return window
}
