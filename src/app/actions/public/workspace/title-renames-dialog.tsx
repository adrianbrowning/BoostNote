import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import { client } from './api.ts'
import type { WorkspaceModel } from './model.ts'
import { parentOf } from './paths.ts'
import { button, muted, primaryButton } from './styles.ts'
import type { TitleRename, TitleRenamePlan, TitleRenameReport } from './types.ts'

const fileName = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/\.md$/, '')

const LEFT_ALONE: [string, string] = [
  'note is named differently and is left alone',
  'notes are named differently and are left alone',
]

/**
 * File › Rename Files From Titles…: loads the plan (a dry run), lists `old → new` per folder, and
 * after "Rename N files" shows what was done. Imported vaults got slug file names before the file
 * name became the note's name; this gives those notes their titles back as file names.
 */
export function TitleRenamesDialog(handle: Handle<{ model: WorkspaceModel }>) {
  let plan: TitleRenamePlan | null = null
  let report: TitleRenameReport | null = null
  let busy = true
  let error = ''

  // The task's own signal aborts on the next render; only unmounting should drop the result.
  handle.queueTask(async () => {
    try {
      plan = await client.planTitleRenames()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    if (handle.signal.aborted) return
    busy = false
    void handle.update()
  })

  const apply = async (renames: TitleRename[]) => {
    busy = true
    error = ''
    void handle.update()
    try {
      report = await handle.props.model.applyTitleRenames(renames)
      if (!report) error = 'Save or resolve the open note first.'
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    busy = false
    void handle.update()
  }

  const close = () => handle.props.model.setTitleRenamesOpen(false)

  const byFolder = (renames: TitleRename[]) => {
    const groups = new Map<string, TitleRename[]>()
    for (const rename of renames) {
      const folder = parentOf(rename.from)
      groups.set(folder, [...(groups.get(folder) ?? []), rename])
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b))
  }

  const renameList = (renames: TitleRename[]) => {
    const { model } = handle.props
    return (
      <div mix={listStyle} data-title-renames-list>
        {byFolder(renames).map(([folder, items]) => (
          <section key={folder} mix={groupStyle}>
            <h3 mix={groupTitleStyle}>
              {folder === '' ? model.data.vault?.name : folder} <span mix={muted}>({items.length})</span>
            </h3>
            <ul mix={itemsStyle}>
              {items.map((rename) => (
                <li key={rename.from} data-title-rename={rename.from}>
                  <span mix={oldNameStyle}>{fileName(rename.from)}</span> → <strong>{fileName(rename.to)}</strong>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    )
  }

  /** `label` gets the count: `[one, many]`. */
  const skippedList = (skipped: Array<{ id: string; reason: string }>, label: [string, string]) =>
    skipped.length === 0 ? null : (
      <details data-title-renames-skipped>
        <summary>
          {skipped.length} {skipped.length === 1 ? label[0] : label[1]}
        </summary>
        <ul mix={itemsStyle}>
          {skipped.map((skip, index) => (
            <li key={`${skip.id}-${index}`}>
              {skip.id} <span mix={muted}>— {skip.reason}</span>
            </li>
          ))}
        </ul>
      </details>
    )

  const body = () => {
    if (report) {
      return (
        <div mix={summaryStyle} data-title-renames-report>
          <p>
            <strong>Renamed {report.renamed.length} files.</strong> Rewrote {report.linksRewritten} links in{' '}
            {report.notesUpdated} notes; removed {report.titlesRemoved} frontmatter titles that now match the file name.
          </p>
          {skippedList(report.skipped, ['note was not renamed', 'notes were not renamed'])}
        </div>
      )
    }
    if (!plan) return busy ? <p mix={muted}>Looking for notes to rename…</p> : null
    if (plan.renames.length === 0) {
      return (
        <div mix={summaryStyle}>
          <p>Every note’s file name already matches its title.</p>
          {skippedList(plan.skipped, LEFT_ALONE)}
        </div>
      )
    }
    return (
      <>
        <p data-title-renames-count>
          {plan.renames.length} files in {byFolder(plan.renames).length} folders will be renamed after their titles.
          Assets folders move with them and links to them are updated.
        </p>
        {renameList(plan.renames)}
        {skippedList(plan.skipped, LEFT_ALONE)}
      </>
    )
  }

  return () => {
    const count = plan?.renames.length ?? 0
    return (
      <div mix={scrimStyle} role="dialog" aria-modal="true" aria-label="Rename files from titles">
        <form
          mix={[
            dialogStyle,
            on('keydown', (event) => {
              if (event.key === 'Escape' && !busy) close()
            }),
            on('submit', (event) => {
              event.preventDefault()
              if (plan && count > 0 && !report && !busy) void apply(plan.renames)
            }),
          ]}
        >
          <h2 mix={titleStyle}>Rename files from titles</h2>
          <p mix={muted}>
            A note’s file name is its name. Notes imported with slug file names (like <code>meeting-notes.md</code>) can
            take their title as file name (<code>Meeting notes.md</code>). Files you named yourself are not touched.
          </p>
          {body()}
          {error ? (
            <p role="alert" mix={errorStyle}>
              {error}
            </p>
          ) : null}
          <div mix={actionsStyle}>
            {report || count === 0 ? (
              <button type="button" disabled={busy} mix={[button, on('click', close)]} data-title-renames-close>
                Close
              </button>
            ) : (
              <>
                <button type="button" disabled={busy} mix={[button, on('click', close)]}>
                  Cancel
                </button>
                <button type="submit" disabled={busy} mix={[button, primaryButton]} data-title-renames-apply>
                  {busy ? 'Renaming…' : `Rename ${count} ${count === 1 ? 'file' : 'files'}`}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    )
  }
}

const scrimStyle = css({
  position: 'fixed',
  inset: 0,
  zIndex: 45,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--bg-overlay)',
})

const dialogStyle = css({
  display: 'grid',
  gap: '12px',
  width: 'min(640px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'auto',
  padding: '18px',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
  fontSize: '13px',
})

const titleStyle = css({ fontSize: '16px', fontWeight: 600 })

const listStyle = css({
  display: 'grid',
  gap: '10px',
  maxHeight: '50vh',
  overflow: 'auto',
  padding: '8px 12px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg-list)',
})

const groupStyle = css({ display: 'grid', gap: '4px' })

const groupTitleStyle = css({ fontSize: '13px', fontWeight: 600 })

const itemsStyle = css({ margin: 0, paddingLeft: '18px', display: 'grid', gap: '2px' })

const oldNameStyle = css({ color: 'var(--text-muted)' })

const summaryStyle = css({
  display: 'grid',
  gap: '6px',
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg-list)',
})

const errorStyle = css({ color: 'var(--danger)' })

const actionsStyle = css({ display: 'flex', justifyContent: 'flex-end', gap: '8px' })
