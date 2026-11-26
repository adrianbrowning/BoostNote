import type { Handle } from 'remix/component'
import { css, on, ref } from 'remix/component'

import type { WorkspaceModel } from './model.ts'
import { button, input, muted, primaryButton } from './styles.ts'
import type { OutsideFilePreference, ThemePreference, UiPatch } from './types.ts'

const THEMES: Array<[ThemePreference, string]> = [
  ['system', 'Match system'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

const OUTSIDE_FILE: Array<[OutsideFilePreference, string]> = [
  ['reader', 'Read only'],
  ['vault', 'Open its folder as vault'],
]

/** Table width choices; `custom` stands for a px value, edited in its own input. */
const TABLE_WIDTHS: Array<['line' | 'full' | 'custom', string]> = [
  ['line', 'Line width'],
  ['full', 'Full pane width'],
  ['custom', 'Custom'],
]

/** The px value a switch to Custom starts from. */
const CUSTOM_TABLE_WIDTH = 1200

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
}

/** The Electron accelerator of a key press (`Command+Shift+Space`), or `null` while only modifiers are down. */
export function acceleratorOf(event: KeyboardEvent, isMac: boolean): string | null {
  const key =
    /^Key([A-Z])$/.exec(event.code)?.[1] ??
    /^Digit(\d)$/.exec(event.code)?.[1] ??
    /^F\d{1,2}$/.exec(event.code)?.[0] ??
    KEY_NAMES[event.code]
  if (key === undefined) return null
  const modifiers = [
    ...(event.metaKey ? [isMac ? 'Command' : 'Super'] : []),
    ...(event.ctrlKey ? ['Control'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
  ]
  return [...modifiers, key].join('+')
}

/** The global hotkey preferences, and the texts of each one's recorder. */
const HOTKEYS = {
  globalHotkey: {
    legend: 'Show/hide Boostnote from anywhere',
    turnedOff: 'Global hotkey turned off.',
    none: 'No global hotkey.',
  },
  captureHotkey: {
    legend: 'Quick capture: a new scratch note from anywhere',
    turnedOff: 'Quick capture turned off.',
    none: 'No Quick capture hotkey.',
  },
}

/**
 * Records global hotkey `field`: click, then press the combination, which is saved right away (a
 * taken one shows the refusal); Turn off saves `''`.
 */
function HotkeyRecorder(handle: Handle<{ model: WorkspaceModel; field: keyof typeof HOTKEYS }>) {
  let recording = false
  let message = ''

  const saveHotkey = async (accelerator: string) => {
    recording = false
    const { field } = handle.props
    const failure = await handle.props.model.savePreferences({ [field]: accelerator })
    message = failure ?? (accelerator === '' ? HOTKEYS[field].turnedOff : `Registered ${accelerator}.`)
    void handle.update()
  }

  return () => {
    const { model, field } = handle.props
    const texts = HOTKEYS[field]
    const value = model.preferences[field]
    const registered = field === 'globalHotkey' ? model.hotkeyRegistered : model.captureHotkeyRegistered
    const isMac = /Mac/.test(navigator.platform)
    return (
      <fieldset mix={hotkeyStyle}>
        <legend>{texts.legend}</legend>
        <div mix={hotkeyRowStyle}>
          <button
            type="button"
            data-hotkey-record
            aria-pressed={recording ? 'true' : 'false'}
            mix={[
              button,
              hotkeyButtonStyle,
              on('click', () => {
                recording = true
                message = 'Press the new key combination (Esc cancels)…'
                void handle.update()
              }),
              on('blur', () => {
                if (!recording) return
                recording = false
                message = ''
                void handle.update()
              }),
              // Stops every key while recording, Esc too, so the dialog does not close.
              on('keydown', (event) => {
                if (!recording) return
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') {
                  recording = false
                  message = ''
                  void handle.update()
                  return
                }
                const accelerator = acceleratorOf(event, isMac)
                if (accelerator) void saveHotkey(accelerator)
              }),
            ]}
          >
            <kbd data-hotkey>{recording ? 'Recording…' : value || 'None'}</kbd>
          </button>
          <button type="button" mix={[button, on('click', () => void saveHotkey(''))]} disabled={value === ''}>
            Turn off
          </button>
        </div>
        <output mix={muted} data-hotkey-status>
          {message ||
            (value === '' ? texts.none : registered ? 'Active.' : 'Not active: another app may use this combination.')}
        </output>
      </fieldset>
    )
  }
}

/**
 * Preferences (⌘,): theme, editor font/size/line width, table width, spellcheck, delete confirmation, how a
 * `.md`/`.mdx` outside every vault opens, the global show/hide hotkey and the Quick capture hotkey beside it.
 * Every change is saved (and applied) right away.
 */
export function PreferencesDialog(handle: Handle<{ model: WorkspaceModel }>) {
  let error = ''

  const save = async (patch: UiPatch) => {
    error = (await handle.props.model.savePreferences(patch)) ?? ''
    void handle.update()
  }

  const close = () => handle.props.model.setPreferencesOpen(false)

  return () => {
    const { model } = handle.props
    const prefs = model.preferences
    return (
      <div
        mix={[
          scrimStyle,
          on('pointerdown', (event) => {
            if (event.target === event.currentTarget) close()
          }),
        ]}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Preferences"
          data-preferences
          mix={[
            dialogStyle,
            on('keydown', (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }),
          ]}
        >
          <h2 mix={titleStyle}>Preferences</h2>

          <label mix={rowStyle}>
            <span>Theme</span>
            <select
              name="theme"
              mix={[
                input,
                ref((node) => {
                  if (node instanceof HTMLElement) node.focus()
                }),
                on('change', (event) => {
                  const theme = THEMES.find(([value]) => value === event.currentTarget.value)?.[0]
                  if (theme) void save({ theme })
                }),
              ]}
            >
              {THEMES.map(([value, label]) => (
                <option key={value} value={value} selected={prefs.theme === value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label mix={rowStyle}>
            <span>Editor font</span>
            <input
              name="editorFont"
              defaultValue={prefs.editorFont}
              placeholder="System font"
              mix={[input, on('change', (event) => void save({ editorFont: event.currentTarget.value.trim() }))]}
            />
          </label>

          <label mix={rowStyle}>
            <span>Font size (px)</span>
            <input
              name="fontSize"
              type="number"
              min="10"
              max="32"
              defaultValue={String(prefs.fontSize)}
              mix={[input, on('change', (event) => void save({ fontSize: Number(event.currentTarget.value) }))]}
            />
          </label>

          <label mix={rowStyle}>
            <span>Line width (px, 0 = full width)</span>
            <input
              name="lineWidth"
              type="number"
              min="0"
              max="2000"
              step="10"
              defaultValue={String(prefs.lineWidth)}
              mix={[input, on('change', (event) => void save({ lineWidth: Number(event.currentTarget.value) }))]}
            />
          </label>

          <label mix={rowStyle}>
            <span>Table width</span>
            <select
              name="tableWidth"
              mix={[
                input,
                on('change', (event) => {
                  const choice = TABLE_WIDTHS.find(([value]) => value === event.currentTarget.value)?.[0]
                  if (choice === 'custom') void save({ tableWidth: Math.max(CUSTOM_TABLE_WIDTH, prefs.lineWidth) })
                  else if (choice) void save({ tableWidth: choice })
                }),
              ]}
            >
              {TABLE_WIDTHS.map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                  selected={typeof prefs.tableWidth === 'number' ? value === 'custom' : prefs.tableWidth === value}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>

          {typeof prefs.tableWidth === 'number' ? (
            <label mix={rowStyle}>
              <span>Table width (px)</span>
              <input
                name="tableWidthPx"
                type="number"
                min="400"
                max="2000"
                step="10"
                defaultValue={String(prefs.tableWidth)}
                mix={[input, on('change', (event) => void save({ tableWidth: Number(event.currentTarget.value) }))]}
              />
            </label>
          ) : null}

          <label mix={checkRowStyle}>
            <input
              name="spellcheck"
              type="checkbox"
              checked={prefs.spellcheck}
              mix={on('change', (event) => void save({ spellcheck: event.currentTarget.checked }))}
            />
            <span>Check spelling while typing</span>
          </label>

          <label mix={checkRowStyle}>
            <input
              name="confirmDelete"
              type="checkbox"
              checked={prefs.confirmDelete}
              mix={on('change', (event) => void save({ confirmDelete: event.currentTarget.checked }))}
            />
            <span>Ask before moving notes and folders to the Trash</span>
          </label>

          <label mix={checkRowStyle}>
            <input
              name="checkUpdates"
              type="checkbox"
              checked={prefs.checkUpdates}
              mix={on('change', (event) => void save({ checkUpdates: event.currentTarget.checked }))}
            />
            <span>Check for updates automatically</span>
          </label>

          <label mix={rowStyle}>
            <span>Opening a .md or .mdx outside a vault</span>
            <select
              name="outsideFile"
              mix={[
                input,
                on('change', (event) => {
                  const outsideFile = OUTSIDE_FILE.find(([value]) => value === event.currentTarget.value)?.[0]
                  if (outsideFile) void save({ outsideFile })
                }),
              ]}
            >
              {OUTSIDE_FILE.map(([value, label]) => (
                <option key={value} value={value} selected={prefs.outsideFile === value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <HotkeyRecorder model={model} field="globalHotkey" />
          <HotkeyRecorder model={model} field="captureHotkey" />

          {error ? (
            <p role="alert" mix={errorStyle}>
              {error}
            </p>
          ) : null}

          <div mix={actionsStyle}>
            <button type="button" mix={[button, primaryButton, on('click', close)]}>
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }
}

const scrimStyle = css({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--bg-overlay)',
})

const dialogStyle = css({
  display: 'grid',
  gap: '12px',
  width: 'min(460px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'auto',
  padding: '16px',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
})

const titleStyle = css({ fontSize: '15px', fontWeight: 600 })

const rowStyle = css({ display: 'grid', gridTemplateColumns: '1fr 200px', alignItems: 'center', gap: '8px' })

const checkRowStyle = css({ display: 'flex', alignItems: 'center', gap: '8px' })

const hotkeyStyle = css({
  display: 'grid',
  gap: '6px',
  margin: 0,
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  '& legend': { padding: '0 4px', fontSize: '12px', color: 'var(--text-muted)' },
})

const hotkeyRowStyle = css({ display: 'flex', gap: '8px' })

const hotkeyButtonStyle = css({
  flex: 1,
  justifyContent: 'center',
  '&[aria-pressed="true"]': { borderColor: 'var(--focus)' },
})

const errorStyle = css({ color: 'var(--danger)', fontSize: '12px' })

const actionsStyle = css({ display: 'flex', justifyContent: 'flex-end' })
