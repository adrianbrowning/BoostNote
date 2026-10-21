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
            ref((node) => node.querySelector<HTMLElement>('[role="menuitem"]')?.focus()),
            on('keydown', (event) => {
              if (event.key === 'Escape') model.closeMenu()
            }),
          ]}
          style={`left: ${left}px; top: ${top}px; width: ${MENU_WIDTH}px`}
        >
          {menu.entries.map((entry, index) => {
            if (entry.kind === 'separator') return <hr key={`sep-${index}`} mix={separatorStyle} />
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
            return (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
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
                {entry.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
}

/** The open prompt/confirm/choose dialog (`model.dialog`). */
export function DialogView(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const dialog = handle.props.model.dialog
    if (!dialog) return null
    const cancel = () => (dialog.kind === 'confirm' ? dialog.resolve(false) : dialog.resolve(null))
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
                if (dialog.kind === 'confirm') dialog.resolve(true)
                else dialog.resolve(String(data.get('value') ?? ''))
              }),
            ]}
          >
            <h2 mix={dialogTitleStyle}>{dialog.title}</h2>
            {dialog.kind === 'confirm' ? <p>{dialog.message}</p> : null}
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
                Cancel
              </button>
              <button
                type="submit"
                mix={[
                  button,
                  dialog.kind === 'confirm' && dialog.danger ? dangerButton : primaryButton,
                  ref((node) => {
                    if (dialog.kind === 'confirm' && node instanceof HTMLElement) node.focus()
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

/** The transient notice (`model.notice`): errors of failed operations, confirmations of moves. */
export function NoticeView(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const { model } = handle.props
    const notice = model.notice
    if (!notice) return null
    return (
      <div role={notice.kind === 'error' ? 'alert' : 'status'} mix={noticeStyle} data-kind={notice.kind} data-notice>
        <span>{notice.text}</span>
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

const dismissStyle = css({ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' })
