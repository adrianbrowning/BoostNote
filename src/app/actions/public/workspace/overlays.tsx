import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'

import { FOLDER_COLORS, type WorkspaceModel } from './model.ts'
import { button, dangerButton, input, primaryButton } from './styles.ts'

const MENU_WIDTH = 200

/** The open context menu (`model.menu`): a fixed popup closed by clicking outside or Escape. */
export function ContextMenuView(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const { model } = handle.props
    const menu = model.menu
    if (!menu) return null
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 4))
    const top = Math.max(4, Math.min(menu.y, window.innerHeight - 40 * menu.entries.length))
    return (
      <div
        mix={[
          scrimStyle,
          on('pointerdown', (event) => {
            if (event.target === event.currentTarget) model.closeMenu()
          }),
        ]}
      >
        <div
          role="menu"
          mix={[
            menuStyle,
            ref((node) => node.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()),
            on('keydown', (event) => {
              if (event.key === 'Escape') model.closeMenu()
            }),
          ]}
          style={`left: ${left}px; top: ${top}px; width: ${MENU_WIDTH}px`}
        >
          {menu.entries.map((entry, index) => {
            if (entry.kind === 'separator') return <hr key={`sep-${index}`} mix={separatorStyle} />
            if (entry.kind === 'heading') {
              return (
                <p key={`heading-${entry.label}`} mix={headingStyle} role="presentation">
                  {entry.label}
                </p>
              )
            }
            if (entry.kind === 'colors') {
              return (
                <fieldset key="colors" mix={colorsStyle} aria-label="Folder colour">
                  {FOLDER_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="menuitemradio"
                      aria-checked={entry.current?.toLowerCase() === color.toLowerCase() ? 'true' : 'false'}
                      aria-label={`Colour ${color}`}
                      mix={[
                        swatchStyle,
                        on('click', () => {
                          model.closeMenu()
                          entry.pick(color)
                        }),
                      ]}
                      style={`background: ${color}`}
                    />
                  ))}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.current ? 'false' : 'true'}
                    aria-label="No colour"
                    mix={[
                      swatchStyle,
                      noColorStyle,
                      on('click', () => {
                        model.closeMenu()
                        entry.pick(null)
                      }),
                    ]}
                  />
                </fieldset>
              )
            }
            // A radio item (the vault on screen ✓) or a plain one; the role and `aria-checked` go together.
            const role =
              entry.checked === undefined
                ? ({ role: 'menuitem' } as const)
                : ({ role: 'menuitemradio', 'aria-checked': entry.checked ? 'true' : 'false' } as const)
            const item = (
              <button
                key={entry.title ?? entry.label}
                type="button"
                {...role}
                title={entry.title}
                disabled={entry.disabled}
                data-danger={entry.danger ? 'true' : undefined}
                mix={[
                  itemStyle,
                  on('click', () => {
                    model.closeMenu()
                    entry.run()
                  }),
                ]}
              >
                {entry.checked === undefined ? null : (
                  <span mix={checkStyle} aria-hidden="true">
                    {entry.checked ? '✓' : ''}
                  </span>
                )}
                <span mix={itemLabelStyle}>{entry.label}</span>
                {entry.detail ? <span mix={detailStyle}>{entry.detail}</span> : null}
              </button>
            )
            const secondary = entry.secondary
            if (!secondary) return item
            return (
              <div key={entry.title ?? entry.label} mix={itemRowStyle}>
                {item}
                <button
                  type="button"
                  role="menuitem"
                  aria-label={secondary.label}
                  title={secondary.label}
                  mix={[
                    itemStyle,
                    secondaryStyle,
                    on('click', () => {
                      model.closeMenu()
                      secondary.run()
                    }),
                  ]}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}

/** The open prompt/confirm/choose/link-update dialog (`model.dialog`). */
export function DialogView(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const dialog = handle.props.model.dialog
    if (!dialog) return null
    const cancel = () =>
      dialog.kind === 'confirm' || dialog.kind === 'links' ? dialog.resolve(false) : dialog.resolve(null)
    return (
      <div
        mix={[
          scrimStyle,
          dimStyle,
          on('pointerdown', (event) => {
            if (event.target === event.currentTarget) cancel()
          }),
        ]}
      >
        <div role="dialog" aria-modal="true" aria-label={dialog.title}>
          <form
            mix={[
              dialogStyle,
              on('keydown', (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancel()
                }
              }),
              on('submit', (event) => {
                event.preventDefault()
                const data = new FormData(event.currentTarget)
                if (dialog.kind === 'confirm' || dialog.kind === 'links') dialog.resolve(true)
                else dialog.resolve(String(data.get('value') ?? ''))
              }),
            ]}
          >
            <h2 mix={dialogTitleStyle}>{dialog.title}</h2>
            {dialog.kind === 'confirm' || dialog.kind === 'links' ? <p>{dialog.message}</p> : null}
            {dialog.kind === 'links' ? (
              <ul mix={linkNotesStyle} aria-label="Notes with links" data-link-notes>
                {dialog.notes.map((note) => (
                  <li key={note.id} title={note.id}>
                    <span>{note.title}</span>
                    <span mix={linkCountStyle}>{note.links === 1 ? '1 link' : `${note.links} links`}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {dialog.kind === 'prompt' ? (
              <label mix={fieldStyle}>
                <span>{dialog.label}</span>
                <input
                  name="value"
                  defaultValue={dialog.value}
                  required
                  mix={[
                    input,
                    ref((node) => {
                      if (!(node instanceof HTMLInputElement)) return
                      node.focus()
                      node.select()
                    }),
                  ]}
                />
              </label>
            ) : null}
            {dialog.kind === 'choose' ? (
              <label mix={fieldStyle}>
                <span>{dialog.label}</span>
                <select
                  name="value"
                  mix={[
                    input,
                    ref((node) => {
                      if (node instanceof HTMLElement) node.focus()
                    }),
                  ]}
                >
                  {dialog.options.map((option) => (
                    <option key={option.value} value={option.value} selected={option.value === dialog.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div mix={actionsStyle}>
              <button type="button" mix={[button, on('click', cancel)]}>
                {dialog.kind === 'links' ? dialog.cancel : 'Cancel'}
              </button>
              <button
                type="submit"
                mix={[
                  button,
                  dialog.kind === 'confirm' && dialog.danger ? dangerButton : primaryButton,
                  ref((node) => {
                    if ((dialog.kind === 'confirm' || dialog.kind === 'links') && node instanceof HTMLElement)
                      node.focus()
                  }),
                ]}
              >
                {dialog.confirm}
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }
}

/** The transient notice (`model.notice`): errors of failed operations, confirmations of moves and imports. */
export function NoticeView(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const { model } = handle.props
    const notice = model.notice
    if (!notice) return null
    return (
      <div role={notice.kind === 'error' ? 'alert' : 'status'} mix={noticeStyle} data-kind={notice.kind} data-notice>
        <div mix={noticeBodyStyle}>
          <span>{notice.text}</span>
          {notice.details ? (
            <ul mix={noticeDetailsStyle} data-notice-details>
              {notice.details.map((line, index) => (
                <li key={String(index)}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <button type="button" mix={[dismissStyle, on('click', () => model.dismissNotice())]} aria-label="Dismiss">
          ×
        </button>
      </div>
    )
  }
}

const scrimStyle = css({ position: 'fixed', inset: 0, zIndex: 50 })

const dimStyle = css({ display: 'grid', placeItems: 'center', background: 'var(--bg-overlay)' })

const menuStyle = css({
  position: 'fixed',
  display: 'grid',
  padding: '4px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
})

const itemStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
  padding: '5px 10px',
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover, &:focus-visible': { background: 'var(--bg-selected)', outline: 'none' },
  '&[data-danger]': { color: 'var(--danger)' },
  '&:disabled': { opacity: 0.5 },
})

const itemRowStyle = css({ display: 'flex', '& > :first-child': { flex: 1 } })
const itemLabelStyle = css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
const checkStyle = css({ width: '12px', flex: 'none' })
const detailStyle = css({ flex: 'none', fontSize: '11px', color: 'var(--text-muted)' })
const secondaryStyle = css({ flex: 'none', padding: '5px 8px', color: 'var(--text-muted)' })
const headingStyle = css({
  margin: '6px 10px 2px',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
})

const separatorStyle = css({ margin: '4px 0', border: 0, borderTop: '1px solid var(--border)' })

const colorsStyle = css({ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: 0, padding: '6px 10px', border: 0 })

const swatchStyle = css({
  width: '18px',
  height: '18px',
  padding: 0,
  border: '1px solid var(--border)',
  borderRadius: '50%',
  cursor: 'pointer',
  '&[aria-checked="true"]': { outline: '2px solid var(--text)', outlineOffset: '1px' },
})

const noColorStyle = css({
  background: 'linear-gradient(135deg, transparent 45%, var(--danger) 45%, var(--danger) 55%, transparent 55%)',
})

const dialogStyle = css({
  display: 'grid',
  gap: '12px',
  width: 'min(420px, calc(100vw - 32px))',
  padding: '16px',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
})

const dialogTitleStyle = css({ fontSize: '15px', fontWeight: 600 })

const fieldStyle = css({ display: 'grid', gap: '4px', fontSize: '12px' })

/** At most eight rows visible; longer lists scroll. */
const linkNotesStyle = css({
  margin: 0,
  padding: '4px 0',
  listStyle: 'none',
  maxHeight: 'calc(8 * 26px + 8px)',
  overflowY: 'auto',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  '& > li': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    height: '26px',
    alignItems: 'center',
    padding: '0 10px',
    fontSize: '13px',
  },
  '& > li > span:first-child': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
})

const linkCountStyle = css({ flexShrink: 0, color: 'var(--text-muted)', fontSize: '12px' })

const actionsStyle = css({ display: 'flex', justifyContent: 'flex-end', gap: '8px' })

const noticeStyle = css({
  position: 'fixed',
  right: '16px',
  bottom: '36px',
  zIndex: 40,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  maxWidth: '420px',
  padding: '8px 12px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
  '&[data-kind="error"]': { borderColor: 'var(--danger)' },
})

const noticeBodyStyle = css({ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 })

const noticeDetailsStyle = css({
  margin: 0,
  paddingLeft: '16px',
  maxHeight: '160px',
  overflowY: 'auto',
  fontSize: '12px',
  color: 'var(--text-muted)',
  overflowWrap: 'anywhere',
})

const dismissStyle = css({ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' })
