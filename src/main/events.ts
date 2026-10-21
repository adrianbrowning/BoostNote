/**
 * Server-Sent Events hub: the single push channel from the main process to the renderer.
 *
 * `GET /events` returns `subscribe(request.signal)`; the menu and the vault watcher call
 * `broadcast(event)`. Each event is written as `event: <type>` with the JSON-encoded event as data.
 * This module is plain Node (no Electron imports) so it can be unit tested.
 */
import type { VaultEventType } from '../vault/index.ts'

/**
 * Menu commands the workspace performs (it knows the selected folder, the open note and the tabs).
 * Every app keyboard shortcut is a menu accelerator, so each one arrives exactly once, through here.
 */
export type MenuCommand =
  | 'new-note'
  | 'new-folder'
  | 'open-folder'
  | 'import-storage'
  | 'reveal-note'
  | 'close-tab'
  | 'reopen-tab'
  | 'next-tab'
  | 'previous-tab'
  /** `index`: 0–7 for tabs 1–8, `-1` for the last tab. */
  | 'select-tab'
  | 'go-back'
  | 'go-forward'
  | 'toggle-sidebar'
  | 'toggle-note-list'
  | 'toggle-properties'
  | 'preferences'
  | 'find'
  /** File > Export: the open note as HTML / PDF / Markdown, printing it, the selected folder or the vault as HTML. */
  | 'export-html'
  | 'export-pdf'
  | 'export-markdown'
  | 'print'
  | 'export-folder'
  | 'export-vault'

export interface MenuEvent {
  type: 'menu'
  command: MenuCommand
  index?: number
}

/** An external change in the open vault (the vault's own writes never produce one). */
export interface VaultChangeEvent {
  type: 'vault'
  change: VaultEventType
  /** Note id, or folder id for `tree-changed`. */
  id: string
}

/** The OS asked to open a `.md` file; the workspace takes it from `POST /api/open-request`. */
export interface OpenRequestEvent {
  type: 'open-request'
}

/** Union of every event pushed over `/events`. */
export type AppEvent = MenuEvent | VaultChangeEvent | OpenRequestEvent

export interface EventHub {
  /** Opens a new `text/event-stream` response. The client is dropped when `signal` aborts or the stream is cancelled. */
  subscribe(signal?: AbortSignal): Response
  /** Sends `event` to every open stream. Streams that can no longer be written to are dropped. */
  broadcast(event: AppEvent): void
  /** Closes every open stream. */
  close(): void
  /** Number of open streams. */
  readonly size: number
}

const encoder = new TextEncoder()

export function formatEvent(event: AppEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function createEventHub(): EventHub {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()

  function drop(client: ReadableStreamDefaultController<Uint8Array>, closeStream: boolean): void {
    if (!clients.delete(client) || !closeStream) return
    try {
      client.close()
    } catch {
      // Already closed or errored by the consumer.
    }
  }

  return {
    get size() {
      return clients.size
    },

    subscribe(signal) {
      let client: ReadableStreamDefaultController<Uint8Array> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          // `retry` tells EventSource how quickly to reconnect; it also flushes headers immediately.
          controller.enqueue(encoder.encode('retry: 1000\n\n'))
          if (signal?.aborted) {
            controller.close()
            return
          }
          clients.add(controller)
          signal?.addEventListener('abort', () => drop(controller, true), { once: true })
        },
        cancel() {
          if (client) drop(client, false)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    },

    broadcast(event) {
      const chunk = encoder.encode(formatEvent(event))
      for (const client of clients) {
        try {
          client.enqueue(chunk)
        } catch {
          drop(client, false)
        }
      }
    },

    close() {
      for (const client of [...clients]) drop(client, true)
    },
  }
}

/** The app-wide hub shared by the router (`/events`) and the main process. */
export const eventHub = createEventHub()
