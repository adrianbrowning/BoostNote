import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import type { WorkspaceModel } from './model.ts'
import { iconButton, muted, paneHeading } from './styles.ts'

/**
 * The scratch list: the kept scratch notes (`model.scratchNotes`), in the sidebar while a vault is open, on the
 * welcome screen while none is, and in a narrow panel beside the editor pane while none is and tabs are open. Each
 * row shows the scratch note's title and reopens it (its tab, opened or
 * activated), with Save to vault… (disabled with no vault, the reason shown) and Discard. Nothing shows while no
 * scratch note is kept.
 */
export function ScratchList(handle: Handle<{ model: WorkspaceModel }>) {
  return () => {
    const { model } = handle.props
    const notes = model.scratchNotes
    if (notes.length === 0) return null
    const noVault = !model.data.vault
    return (
      <section aria-label="Scratch" mix={sectionStyle} data-scratch-list>
        <h2 mix={[paneHeading, headingStyle]}>Scratch</h2>
        {noVault ? (
          <p id="scratch-list-save-reason" mix={[muted, reasonStyle]}>
            Open a vault to save a scratch note to it
          </p>
        ) : null}
        <ul mix={listStyle}>
          {notes.map((note) => (
            <li key={note.id} mix={rowStyle} data-scratch-row={note.id}>
              <button
                type="button"
                mix={[rowButtonStyle, on('click', () => void model.openScratch(note.id))]}
                title={note.title}
                data-scratch-open
              >
                <span mix={labelStyle}>{note.title}</span>
              </button>
              <button
                type="button"
                disabled={noVault}
                aria-label="Save to vault…"
                title="Save to vault…"
                aria-describedby={noVault ? 'scratch-list-save-reason' : undefined}
                mix={[iconButton, actionStyle, on('click', () => void model.saveScratchToVault(note.id))]}
                data-scratch-row-save
              >
                ↧
              </button>
              <button
                type="button"
                disabled={model.savingScratch(note.id)}
                aria-label="Discard"
                title="Discard"
                mix={[iconButton, actionStyle, on('click', () => void model.discardScratch(note.id))]}
                data-scratch-discard
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
    )
  }
}

const sectionStyle = css({ display: 'grid', gap: '2px', minWidth: 0, textAlign: 'left' })

const headingStyle = css({ padding: '10px 8px 2px' })

const reasonStyle = css({ margin: 0, padding: '0 8px', fontSize: '12px' })

const listStyle = css({ listStyle: 'none', margin: 0, padding: 0 })

const rowStyle = css({
  display: 'flex',
  alignItems: 'center',
  borderRadius: '6px',
  '&:hover': { background: 'var(--bg-hover)' },
})

const rowButtonStyle = css({
  display: 'flex',
  flex: 1,
  minWidth: 0,
  padding: '3px 6px',
  border: 0,
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
})

const labelStyle = css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })

const actionStyle = css({ flex: 'none', '&:disabled': { opacity: 0.5, cursor: 'default' } })
