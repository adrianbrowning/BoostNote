import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import type { WorkspaceModel } from './model.ts'
import { button, iconButton, input, muted, paneHeading } from './styles.ts'
import type { JsonValue } from './types.ts'

/** Keys with their own editors (created/updated are maintained by the vault). */
const RESERVED_KEYS: Record<string, true> = { tags: true, starred: true, created: true, updated: true }

type Kind = 'text' | 'number' | 'boolean' | 'date' | 'list'

const KIND_LABELS: Record<Kind, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Checkbox',
  date: 'Date',
  list: 'List',
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The editor a frontmatter value gets; `undefined` for nested YAML (mappings, lists of lists…), shown read-only. */
function kindOf(value: JsonValue): Kind | undefined {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return DATE.test(value) ? 'date' : 'text'
  if (value === null) return 'text'
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) return 'list'
  return undefined
}

function initialValue(kind: Kind): JsonValue {
  if (kind === 'number') return 0
  if (kind === 'boolean') return false
  if (kind === 'date') return new Date().toISOString().slice(0, 10)
  if (kind === 'list') return []
  return ''
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/**
 * File properties: the open note's frontmatter as fields. Every committed change (Enter/blur for
 * text) writes the note through the save route, which keeps the YAML bytes of untouched keys.
 */
export function PropertiesPanel(handle: Handle<{ model: WorkspaceModel }>) {
  let tagDraft = ''
  let newKey = ''
  let newKind: Kind = 'text'
  let error = ''

  const current = () => handle.props.model.session.note?.frontmatter ?? {}

  const write = (frontmatter: Record<string, JsonValue>) => {
    error = ''
    void handle.props.model.setFrontmatter(frontmatter)
  }

  const setValue = (key: string, value: JsonValue) => write({ ...current(), [key]: value })

  const remove = (key: string) => {
    const { [key]: _removed, ...rest } = current()
    write(rest)
  }

  const fail = (message: string) => {
    error = message
    void handle.update()
  }

  /** Renames a key, keeping its value (the vault rewrites the renamed key after the others). */
  const renameKey = (from: string, to: string) => {
    const name = to.trim()
    if (name === from) return
    if (name === '') return fail('A property needs a name.')
    if (name in current() || RESERVED_KEYS[name]) return fail(`There already is a property “${name}”.`)
    write(Object.fromEntries(Object.entries(current()).map(([key, value]) => [key === from ? name : key, value])))
  }

  const addProperty = () => {
    const name = newKey.trim()
    if (name === '') return fail('A property needs a name.')
    if (name in current() || RESERVED_KEYS[name]) return fail(`There already is a property “${name}”.`)
    newKey = ''
    setValue(name, initialValue(newKind))
  }

  const tags = () => handle.props.model.session.note?.tags ?? []

  const addTag = (text: string) => {
    const tag = text.trim().replace(/^#/, '')
    tagDraft = ''
    if (tag === '' || tags().includes(tag)) {
      void handle.update()
      return
    }
    setValue('tags', [...tags(), tag])
  }

  const removeTag = (tag: string) => {
    const next = tags().filter((item) => item !== tag)
    if (next.length === 0) remove('tags')
    else setValue('tags', next)
  }

  const valueEditor = (key: string, value: JsonValue, kind: Kind, noteId: string) => {
    const id = `property-${key}`
    if (kind === 'boolean') {
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          mix={on('change', (event) => setValue(key, event.currentTarget.checked))}
        />
      )
    }
    if (kind === 'number') {
      return (
        <input
          id={id}
          key={`${noteId}:${key}:${value}`}
          type="number"
          defaultValue={String(value)}
          mix={[
            input,
            on('change', (event) => {
              const number = Number(event.currentTarget.value)
              if (event.currentTarget.value.trim() !== '' && Number.isFinite(number)) setValue(key, number)
            }),
          ]}
        />
      )
    }
    if (kind === 'list') {
      const items = Array.isArray(value) ? value : []
      return (
        <input
          id={id}
          key={`${noteId}:${key}:${items.join(',')}`}
          defaultValue={items.join(', ')}
          placeholder="Comma-separated"
          mix={[
            input,
            on('change', (event) =>
              setValue(
                key,
                event.currentTarget.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter((item) => item !== ''),
              ),
            ),
          ]}
        />
      )
    }
    const commit = on<HTMLInputElement, 'change'>('change', (event) => setValue(key, event.currentTarget.value))
    const text = value === null ? '' : String(value)
    return kind === 'date' ? (
      <input id={id} key={`${noteId}:${key}:${text}`} type="date" defaultValue={text} mix={[input, commit]} />
    ) : (
      <input id={id} key={`${noteId}:${key}:${text}`} type="text" defaultValue={text} mix={[input, commit]} />
    )
  }

  return () => {
    const { model } = handle.props
    const note = model.session.note
    if (!note) return null
    const entries = Object.entries(note.frontmatter).filter(([key]) => !RESERVED_KEYS[key])
    const suggestions = model.tags.map(([tag]) => tag).filter((tag) => !note.tags.includes(tag))
    const invalidYaml = /^---\r?\n/.test(note.body) && Object.keys(note.frontmatter).length === 0
    return (
      <aside mix={panelStyle} aria-label="Properties" data-properties>
        <div mix={headingRowStyle}>
          <h2 mix={paneHeading}>Properties</h2>
          <button
            type="button"
            mix={[iconButton, on('click', () => model.togglePane('propertiesOpen'))]}
            aria-label="Close properties"
          >
            ×
          </button>
        </div>
        {invalidYaml ? (
          <p mix={[muted, hintStyle]}>
            The frontmatter at the top of this note is not valid YAML, so it is shown as text in the editor.
          </p>
        ) : null}

        <div mix={fieldStyle}>
          <label for="property-tags" mix={labelStyle}>
            Tags
          </label>
          <div mix={chipsStyle} data-tags>
            {note.tags.map((tag) => (
              <span key={tag} mix={chipStyle} data-tag-chip={tag}>
                #{tag}
                <button
                  type="button"
                  mix={[chipRemoveStyle, on('click', () => removeTag(tag))]}
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id="property-tags"
              list="property-tag-suggestions"
              placeholder={note.tags.length === 0 ? 'Add a tag' : ''}
              value={tagDraft}
              autocomplete="off"
              mix={[
                chipInputStyle,
                on('input', (event) => {
                  const value = event.currentTarget.value
                  // Picking a datalist suggestion fires `input` as a replacement of the whole text.
                  const picked = event instanceof InputEvent && event.inputType === 'insertReplacementText'
                  if (value.endsWith(',') || (picked && suggestions.includes(value))) {
                    addTag(value.replace(/,$/, ''))
                  } else {
                    // Controlled input: re-render with the new value or Remix restores the old one.
                    tagDraft = value
                    void handle.update()
                  }
                }),
                on('keydown', (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addTag(event.currentTarget.value)
                  } else if (event.key === 'Backspace' && event.currentTarget.value === '') {
                    const last = note.tags[note.tags.length - 1]
                    if (last !== undefined) removeTag(last)
                  }
                }),
                on('blur', (event) => {
                  if (event.currentTarget.value.trim() !== '') addTag(event.currentTarget.value)
                }),
              ]}
            />
            <datalist id="property-tag-suggestions">
              {suggestions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </div>
        </div>

        <div mix={[fieldStyle, inlineFieldStyle]}>
          <label for="property-starred" mix={labelStyle}>
            Starred
          </label>
          <input
            id="property-starred"
            type="checkbox"
            checked={note.starred}
            mix={on('change', () => void model.toggleStar())}
          />
        </div>

        <dl mix={datesStyle}>
          <dt mix={labelStyle}>Created</dt>
          <dd data-created>{formatTimestamp(note.created)}</dd>
          <dt mix={labelStyle}>Updated</dt>
          <dd data-updated>{formatTimestamp(note.updated)}</dd>
        </dl>

        {entries.map(([key, value]) => {
          const kind = kindOf(value)
          return (
            <div key={`${note.id}:${key}`} mix={fieldStyle} data-property={key}>
              <div mix={keyRowStyle}>
                <input
                  key={`${note.id}:${key}`}
                  defaultValue={key}
                  aria-label={`Name of property ${key}`}
                  mix={[keyInputStyle, on('change', (event) => renameKey(key, event.currentTarget.value))]}
                />
                <button
                  type="button"
                  mix={[iconButton, on('click', () => remove(key))]}
                  aria-label={`Remove property ${key}`}
                  title="Remove property"
                >
                  ×
                </button>
              </div>
              {kind ? (
                valueEditor(key, value, kind, note.id)
              ) : (
                <>
                  <pre mix={readonlyStyle}>{JSON.stringify(value, null, 2)}</pre>
                  <p mix={[muted, hintStyle]}>Nested YAML can't be edited here; edit the file to change it.</p>
                </>
              )}
            </div>
          )
        })}

        <form
          mix={[
            addFormStyle,
            on('submit', (event) => {
              event.preventDefault()
              addProperty()
            }),
          ]}
          aria-label="Add property"
        >
          <input
            placeholder="New property"
            aria-label="New property name"
            value={newKey}
            mix={[
              input,
              on('input', (event) => {
                newKey = event.currentTarget.value
                void handle.update()
              }),
            ]}
          />
          <select
            aria-label="New property type"
            mix={[
              input,
              on('change', (event) => {
                const value = event.currentTarget.value
                const kind = (Object.keys(KIND_LABELS) as Kind[]).find((item) => item === value)
                if (kind) newKind = kind
              }),
            ]}
          >
            {(Object.entries(KIND_LABELS) as Array<[Kind, string]>).map(([kind, label]) => (
              <option key={kind} value={kind} selected={kind === newKind}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" mix={button}>
            Add
          </button>
        </form>
        {error ? (
          <p role="alert" mix={errorStyle}>
            {error}
          </p>
        ) : null}
      </aside>
    )
  }
}

const panelStyle = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  width: '280px',
  flex: 'none',
  padding: '10px 12px',
  overflow: 'auto',
  borderLeft: '1px solid var(--border)',
  background: 'var(--bg-list)',
  fontSize: '13px',
})

const headingRowStyle = css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between' })

const fieldStyle = css({ display: 'grid', gap: '4px' })

const inlineFieldStyle = css({ gridTemplateColumns: '1fr auto', alignItems: 'center' })

const labelStyle = css({ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' })

const chipsStyle = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
  padding: '4px',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  background: 'var(--bg)',
  '&:focus-within': { outline: '2px solid var(--focus)', outlineOffset: '1px' },
})

const chipStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  padding: '0 2px 0 6px',
  borderRadius: '10px',
  background: 'var(--bg-selected)',
  color: 'var(--accent-strong)',
  fontSize: '12px',
})

const chipRemoveStyle = css({
  border: 0,
  padding: '0 3px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
})

const chipInputStyle = css({
  flex: 1,
  minWidth: '80px',
  border: 0,
  padding: '2px',
  background: 'transparent',
  '&:focus-visible': { outline: 'none' },
})

const datesStyle = css({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '2px 8px',
  margin: 0,
  '& dd': { margin: 0, fontSize: '12px' },
})

const keyRowStyle = css({ display: 'flex', alignItems: 'center', gap: '4px' })

const keyInputStyle = css({
  flex: 1,
  minWidth: 0,
  padding: '1px 2px',
  border: '1px solid transparent',
  borderRadius: '4px',
  background: 'transparent',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  '&:hover, &:focus': { borderColor: 'var(--border)', color: 'var(--text)' },
})

const readonlyStyle = css({
  margin: 0,
  padding: '6px',
  borderRadius: '6px',
  background: 'var(--bg)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
})

const hintStyle = css({ fontSize: '12px' })

const addFormStyle = css({
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  gap: '4px',
  paddingTop: '8px',
  borderTop: '1px solid var(--border)',
})

const errorStyle = css({ color: 'var(--danger)', fontSize: '12px' })
