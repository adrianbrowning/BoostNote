import type { Handle } from 'remix/component'
import { clientEntry, css } from 'remix/component'

type Connection = 'connecting' | 'connected' | 'disconnected'

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
}

/** Subscribes to the main-process event stream and shows the last menu command it received. */
export const StatusBar = clientEntry(import.meta.url, function StatusBar(handle: Handle<{ eventsHref: string }>) {
  let connection: Connection = 'connecting'
  let lastCommand: string | undefined

  // Runs after the browser commit only, so the server render never touches EventSource.
  handle.queueTask(() => {
    const source = new EventSource(handle.props.eventsHref)
    source.addEventListener('open', () => {
      connection = 'connected'
      handle.update()
    })
    source.addEventListener('error', () => {
      connection = source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting'
      handle.update()
    })
    source.addEventListener('menu', (event) => {
      lastCommand = (JSON.parse(event.data) as { command: string }).command
      handle.update()
    })
    handle.signal.addEventListener('abort', () => source.close(), { once: true })
  })

  return () => (
    <footer mix={statusBarStyle} data-connection={connection} data-last-command={lastCommand ?? ''}>
      <span role="status">{CONNECTION_LABEL[connection]}</span>
      <span>
        Last command: <output>{lastCommand ?? 'none'}</output>
      </span>
    </footer>
  )
})

const statusBarStyle = css({
  gridArea: 'status',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '2px 12px',
  fontSize: '12px',
  color: 'var(--text-muted)',
  background: 'var(--bg-statusbar)',
  borderTop: '1px solid var(--border)',
})
