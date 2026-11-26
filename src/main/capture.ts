import type { MenuEvent } from '../shared/commands.ts'

export interface CaptureOptions {
  /** Shows and focuses the main window, creating it when there is none. */
  show: () => void
  /** Forwards a command to the renderer (main.ts broadcasts it as an SSE `menu` event). */
  send: (event: MenuEvent) => void
}

/**
 * The Quick capture hotkey (`ui.captureHotkey`): brings the window to the front, also from hidden,
 * minimised or in the background, and then asks the page for a new scratch note (New Scratch Note),
 * which opens focused. Unlike the show/hide hotkey it never hides the app. A capture made while no
 * page is connected is not queued.
 */
export function createCaptureHandler({ show, send }: CaptureOptions): () => void {
  return () => {
    show()
    send({ type: 'menu', command: 'new-scratch-note' })
  }
}
