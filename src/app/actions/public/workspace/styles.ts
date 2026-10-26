import { css } from 'remix/component'

/** Styles shared by the workspace panes. Colours come from the variables in `base.css`. */

export const paneHeading = css({
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
})

export const muted = css({ color: 'var(--text-muted)' })

export const button = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 10px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  '&:hover': { background: 'var(--bg-hover)' },
  '&:disabled': { opacity: 0.5, cursor: 'default' },
})

export const primaryButton = css({
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: '#fff',
  '&:hover': { background: 'var(--accent-strong)' },
})

export const dangerButton = css({
  background: 'var(--danger)',
  borderColor: 'var(--danger)',
  color: '#fff',
  '&:hover': { background: 'var(--danger)', filter: 'brightness(1.1)' },
})

export const iconButton = css({
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: '24px',
  height: '24px',
  padding: '0 4px',
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  '&:hover': { background: 'var(--bg-hover)', color: 'var(--text)' },
})

export const input = css({
  width: '100%',
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
})

export const emptyState = css({
  display: 'grid',
  justifyItems: 'center',
  alignContent: 'center',
  gap: '8px',
  height: '100%',
  padding: '24px',
  textAlign: 'center',
})

export const emptyTitle = css({ fontSize: '20px', fontWeight: 600 })

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * `Oct 21, 2026`. Formatted by hand rather than with `Intl` so the server render (main process
 * locale) and the browser render (Chromium locale) produce identical text for hydration.
 */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}
